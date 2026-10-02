const crypto = require('crypto');
const prisma = require('../prismaClient');
const { ROLE_LABELS } = require('../middleware/requireRole');
const { generatedStamp } = require('../reports/reportFormat');

// The audit trail: who did what, when, from which IP address and device.
// Rows are only ever inserted — nothing in the portal updates or deletes
// them. Most entries are written by middleware/auditTrail.js for every
// request that changes something or downloads a file; record() is also
// called directly for events that aren't a plain request (a failed login).

const SECRET_KEYS = /pass(word)?|token|secret|authorization|hash|^code$/i; // code: two-step sign-in codes
const MAX_DETAIL_CHARS = 8000;

// Request bodies go into the log with anything secret masked, and trimmed
// so a large payload can't bloat the table.
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? (v ? '••••••' : v) : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function boundedDetails(details) {
  if (!details || (typeof details === 'object' && Object.keys(details).length === 0)) return undefined;
  const json = JSON.stringify(details);
  return json.length > MAX_DETAIL_CHARS ? { truncated: json.slice(0, MAX_DETAIL_CHARS) } : details;
}

// The caller's address. Behind a reverse proxy this relies on Express's
// "trust proxy" setting (server.js) so X-Forwarded-For is honoured only
// from a trusted hop.
function clientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (ip === '::1') return '127.0.0.1';
  return ip.replace(/^::ffff:/, '') || null;
}

// "Chrome 128 on Android 14 (SM-A515F) · Phone" from a User-Agent string —
// enough to tell devices apart in an audit, without a UA database.
function describeDevice(userAgent, clientMode) {
  const ua = userAgent || '';
  if (!ua) return 'Unknown device';
  const tool = ua.match(/^(curl|Wget|PostmanRuntime|insomnia|axios|node-fetch|undici|python-requests|okhttp)[/\s]?([\d.]*)/i);
  if (tool) return `API client (${tool[1]}${tool[2] ? ` ${tool[2]}` : ''})`;

  if (!/Mozilla|Opera/.test(ua)) return `Other client (${ua.slice(0, 60)})`;

  const v = (re) => ua.match(re)?.[1]?.replace(/_/g, '.').split('.')[0];
  let browser = 'Browser';
  if (/Edg(A|iOS)?\//.test(ua)) browser = `Edge ${v(/Edg(?:A|iOS)?\/([\d.]+)/)}`;
  else if (/OPR\//.test(ua)) browser = `Opera ${v(/OPR\/([\d.]+)/)}`;
  else if (/SamsungBrowser\//.test(ua)) browser = `Samsung Internet ${v(/SamsungBrowser\/([\d.]+)/)}`;
  else if (/CriOS\//.test(ua)) browser = `Chrome ${v(/CriOS\/([\d.]+)/)}`;
  else if (/FxiOS\//.test(ua)) browser = `Firefox ${v(/FxiOS\/([\d.]+)/)}`;
  else if (/Firefox\//.test(ua)) browser = `Firefox ${v(/Firefox\/([\d.]+)/)}`;
  else if (/Chrome\//.test(ua)) browser = `Chrome ${v(/Chrome\/([\d.]+)/)}`;
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = `Safari ${v(/Version\/([\d.]+)/)}`;

  let os = 'unknown OS';
  let model = null;
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) {
    os = `Android ${v(/Android ([\d.]+)/) || ''}`.trim();
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    if (m && m[1] !== 'K' && !/^wv$/.test(m[1])) model = m[1].trim();
  } else if (/iPad/.test(ua)) os = `iPadOS ${v(/OS ([\d_]+)/) || ''}`.trim();
  else if (/iPhone/.test(ua)) { os = `iOS ${v(/OS ([\d_]+)/) || ''}`.trim(); model = 'iPhone'; }
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  const type = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet'
    : /Mobi|iPhone/.test(ua) ? 'Phone' : 'Computer';
  const app = clientMode === 'app' ? ' · installed app' : '';
  return `${browser} on ${os}${model ? ` (${model})` : ''} · ${type}${app}`;
}

function requestContext(req) {
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 1000) || null;
  const mode = req.headers['x-client-mode'] === 'app' ? 'app' : null;
  return {
    ipAddress: clientIp(req),
    userAgent,
    device: describeDevice(userAgent, mode),
    method: req.method,
    path: (req.originalUrl || req.url || '').split('?')[0].slice(0, 500)
  };
}

function userFields(user) {
  if (!user) return {};
  return {
    userId: user.id,
    userEmail: user.email,
    userName: user.name || null,
    userRole: user.role,
    subcontractorName: user.subcontractorName || null
  };
}

// Writes one entry. Never throws — a failed audit write is reported in the
// server log but doesn't fail the user's request.
async function record(req, { user, category, action, summary, entityType, entityId, success = true, statusCode, details }) {
  try {
    await prisma.auditLog.create({
      data: {
        ...userFields(user || req.user),
        ...requestContext(req),
        category,
        action,
        summary: String(summary || action).slice(0, 2000),
        entityType: entityType || null,
        entityId: entityId === undefined || entityId === null ? null : String(entityId),
        success,
        statusCode: statusCode ?? null,
        details: boundedDetails(details)
      }
    });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

// Stamp for a downloaded file: who downloaded it, when, and a reference
// that matches the file to its audit-log entry. The route puts `text` in the
// document; the audit middleware records the same ref.
function downloadStamp(req, res) {
  const at = new Date();
  const ref = `DL-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const u = req.user;
  const by = `${u.name || u.email} <${u.email}> (${ROLE_LABELS[u.role] || u.role})`;
  const stamp = { ref, at, by, atText: generatedStamp(at), text: `Downloaded by ${by} on ${generatedStamp(at)} - Ref ${ref}` };
  res.locals.audit = { ...(res.locals.audit || {}), downloadRef: ref };
  return stamp;
}

module.exports = { record, sanitize, clientIp, describeDevice, requestContext, downloadStamp };
