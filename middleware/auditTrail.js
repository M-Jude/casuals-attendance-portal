const prisma = require('../prismaClient');
const { record, sanitize } = require('../services/audit');
const { ROLE_LABELS } = require('./requireRole');
const { REPORT_TYPES } = require('../reports/reportCatalog');

// Writes an audit-log entry for every API request that changes something,
// downloads a file or previews a report — once the response has gone out, so
// the entry records whether it worked. Plain page loads (lists, dashboards,
// polling) aren't logged; they'd drown the trail without saying who did what.
//
// Each rule gives the action a category, a code and a readable summary.
// A summary may look things up (a worker's name), since ids alone mean
// little to an auditor. A handler can add to the entry through
// res.locals.audit ({ summary, details, entityType, entityId, downloadRef }).
// Requests no rule matches are still logged, as category "other".

const RULES = [];
function rule(method, pattern, spec) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  RULES.push({ method, re, keys, ...spec });
}

const nameOfWorker = async (id) => {
  const w = await prisma.casualWorker.findUnique({ where: { id: Number(id) }, select: { name: true, biostarUserId: true } });
  return w ? `${w.name} (${w.biostarUserId})` : `worker #${id}`;
};
const nameOfAccount = async (id) => {
  const u = await prisma.portalUser.findUnique({ where: { id: Number(id) }, select: { name: true, email: true } });
  return u ? `${u.name || u.email} <${u.email}>` : `account #${id}`;
};
const nameOfCrew = async (id) => (await prisma.crew.findUnique({ where: { id: Number(id) }, select: { name: true } }))?.name || `crew #${id}`;
const nameOfShift = async (id) => (await prisma.shift.findUnique({ where: { id: Number(id) }, select: { name: true } }))?.name || `shift #${id}`;
async function nameOfUnit(id) {
  const u = await prisma.approvalUnit.findUnique({ where: { id: Number(id) } });
  if (!u) return `batch #${id}`;
  if (u.kind !== 'crew-shift') return `Permanent staff · ${u.month}`;
  const [crew, shift] = await Promise.all([u.crewId ? nameOfCrew(u.crewId) : 'Crew', u.shiftId ? nameOfShift(u.shiftId) : '']);
  return `${crew} · ${shift} · ${u.date.toISOString().slice(0, 10)}`;
}
const reportName = (id) => REPORT_TYPES.find((t) => t.id === id)?.name || id;
const periodText = (q) => (q.from && q.to ? `${q.from} to ${q.to}` : [q.period, q.date || q.month || q.weekFrom].filter(Boolean).join(' '));

// ------------------------------------------------------------------ sign-in

rule('POST', '/api/auth/login', {
  category: 'auth', action: 'auth.login',
  summary: ({ ok, body }) => (ok ? 'Signed in' : `Failed sign-in attempt for ${String(body.email || '').slice(0, 120) || '(no email)'}`)
});
rule('POST', '/api/auth/logout', { category: 'auth', action: 'auth.logout', summary: () => 'Signed out' });
rule('POST', '/api/auth/change-password', { category: 'auth', action: 'auth.password-change', summary: () => 'Changed their password' });
rule('POST', '/api/auth/mfa/setup', { category: 'auth', action: 'auth.mfa-setup', summary: () => 'Started setting up two-step sign-in' });
rule('POST', '/api/auth/mfa/enable', { category: 'auth', action: 'auth.mfa-enable', summary: ({ ok }) => (ok ? 'Set up two-step sign-in' : 'Two-step setup: wrong code') });
rule('POST', '/api/auth/mfa/verify', { category: 'auth', action: 'auth.mfa-verify', summary: ({ ok }) => (ok ? 'Signed in (password + authenticator code)' : 'Wrong authenticator code') });

// ------------------------------------------------------------------ accounts

rule('POST', '/api/users', {
  category: 'account', action: 'account.create', entityType: 'account',
  summary: ({ body }) => `Created ${ROLE_LABELS[body.role] || body.role} account for ${body.name || body.email} <${body.email}>`
});
rule('PATCH', '/api/users/:id', {
  category: 'account', action: 'account.update', entityType: 'account', entity: (p) => p.id,
  summary: async ({ params, body }) => {
    const who = await nameOfAccount(params.id);
    const bits = [];
    if (body.moveToCrewId !== undefined) bits.push(`moved to ${await nameOfCrew(body.moveToCrewId)}`);
    if (body.active === false) bits.push('disabled');
    if (body.active === true) bits.push('re-enabled');
    if (body.role !== undefined) bits.push(`role set to ${ROLE_LABELS[body.role] || body.role}`);
    if (body.resetPassword === true) bits.push('new temporary password sent');
    if (body.resetTwoStep === true) bits.push('two-step sign-in reset');
    if (typeof body.name === 'string') bits.push(`name set to "${body.name}"`);
    if (body.casualWorkerId !== undefined) bits.push(body.casualWorkerId ? `linked to ${await nameOfWorker(body.casualWorkerId)}` : 'worker link removed');
    return `Updated account ${who}${bits.length ? `: ${bits.join(', ')}` : ''}`;
  }
});

// ------------------------------------------------------------------ attendance & approvals

rule('POST', '/api/attendance/sync', { category: 'attendance', action: 'attendance.sync', summary: () => 'Ran a manual BioStar sync' });
rule('POST', '/api/approvals/:id/approve', {
  category: 'approval', action: 'approval.approve', entityType: 'approval', entity: (p) => p.id,
  summary: async ({ params, body }) => {
    const comments = Object.values(body.rowComments || {}).filter((c) => typeof c === 'string' && c.trim()).length;
    return `Approved ${await nameOfUnit(params.id)}${body.comment ? ' with a comment' : ''}${comments ? ` (${comments} row comment${comments === 1 ? '' : 's'})` : ''}`;
  }
});

// ------------------------------------------------------------------ schedules & settings

rule('POST', '/api/crews', { category: 'schedule', action: 'crew.create', entityType: 'crew', summary: ({ body }) => `Created crew "${body.name}" (${body.pattern || 'DDNNOO'} from ${body.effectiveFrom})` });
rule('PATCH', '/api/crews/:id', { category: 'schedule', action: 'crew.rename', entityType: 'crew', entity: (p) => p.id, summary: ({ body }) => `Renamed a crew to "${body.name}"` });
rule('POST', '/api/crews/:id/rotations', {
  category: 'schedule', action: 'crew.rotation', entityType: 'crew', entity: (p) => p.id,
  summary: async ({ params, body }) => `Changed ${await nameOfCrew(params.id)}'s rotation to ${body.pattern} from ${body.effectiveFrom}`
});
rule('POST', '/api/crews/proposals/:id/:action', {
  category: 'schedule', action: 'crew.proposal', entityType: 'cycle-proposal', entity: (p) => p.id,
  summary: ({ params }) => `${params.action === 'apply' ? 'Applied' : 'Dismissed'} detected cycle change #${params.id}`
});
rule('POST', '/api/workers/:id/schedule', {
  category: 'schedule', action: 'worker.schedule', entityType: 'worker', entity: (p) => p.id,
  summary: async ({ params, body }) => {
    const target = body.type === 'crew' ? await nameOfCrew(body.crewId) : body.type;
    return `Set ${await nameOfWorker(params.id)}'s schedule to ${target}${body.effectiveFrom ? ` from ${body.effectiveFrom}` : ''}`;
  }
});
rule('POST', '/api/pattern-review/:workerId/:action', {
  category: 'schedule', action: 'pattern.review', entityType: 'worker', entity: (p) => p.workerId,
  summary: async ({ params }) => `${params.action === 'accept' ? 'Accepted' : 'Dismissed'} the suggested pattern for ${await nameOfWorker(params.workerId)}`
});
rule('PUT', '/api/exceptions', {
  category: 'schedule', action: 'exception.save', entityType: 'worker', entity: (p, b) => b.workerId,
  summary: async ({ body }) => {
    const works = Array.isArray(body.shifts) && body.shifts.length ? body.shifts.join(' + ') : 'off';
    return `Recorded an exception: ${await nameOfWorker(body.workerId)} works ${works} on ${body.date}`;
  }
});
rule('DELETE', '/api/exceptions/:id', { category: 'schedule', action: 'exception.remove', entityType: 'exception', entity: (p) => p.id, summary: () => 'Removed a schedule exception' });
rule('PUT', '/api/shifts/:id', {
  category: 'settings', action: 'shift.rules', entityType: 'shift', entity: (p) => p.id,
  summary: async ({ params, body }) => `Changed the ${await nameOfShift(params.id)} shift rules (${Object.keys(body).join(', ')})`
});

rule('PUT', '/api/settings/pay-rates', {
  category: 'settings', action: 'settings.pay-rates',
  summary: ({ body }) => `Set pay rates: Day ${body.dayShift ?? 'open'}, Night ${body.nightShift ?? 'open'} ${String(body.currency || 'UGX').toUpperCase()} per shift`
});

// ------------------------------------------------------------------ notifications

rule('POST', '/api/notifications/read-all', { category: 'notification', action: 'notification.read-all', summary: () => 'Marked all notifications as read' });
rule('POST', '/api/notifications/:id/read', { category: 'notification', action: 'notification.read', entityType: 'notification', entity: (p) => p.id, summary: () => 'Opened a notification' });

// ------------------------------------------------------------------ downloads & report views (GET)

rule('GET', '/api/attendance/export', {
  category: 'download', action: 'download.attendance-csv', log: true,
  summary: ({ query }) => `Downloaded attendance CSV (${periodText(query)})`
});
rule('GET', '/api/attendance/report.pdf', {
  category: 'download', action: 'download.attendance-pdf', log: true,
  summary: ({ query }) => `Downloaded attendance PDF (${periodText(query)})`
});
rule('GET', '/api/reports/:type', {
  log: true,
  classify: ({ query }) => (['csv', 'xlsx', 'pdf'].includes(query.format)
    ? { category: 'download', action: `download.report-${query.format}` }
    : { category: 'report', action: 'report.view' }),
  entityType: 'report', entity: (p) => p.type,
  summary: ({ params, query }) => {
    const fmt = ['csv', 'xlsx', 'pdf'].includes(query.format) ? query.format : null;
    return `${fmt ? `Downloaded ${fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase()}` : 'Previewed'} report "${reportName(params.type)}" (${periodText(query)})`;
  }
});
rule('GET', '/api/audit/export', { category: 'download', action: 'download.audit-csv', log: true, summary: () => 'Downloaded the audit log (CSV)' });
rule('GET', '/api/attendance', { category: 'attendance', action: 'attendance.raw', log: true, summary: ({ query }) => `Viewed raw BioStar punches${query.from ? ` (${periodText(query)})` : ''}` });

function match(req) {
  const path = (req.originalUrl || '').split('?')[0];
  for (const r of RULES) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(path);
    if (m) return { rule: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// Client-reported events (POST /api/audit/event) log themselves.
const SKIP = new Set(['/api/audit/event']);

function auditTrail(req, res, next) {
  const path = (req.originalUrl || '').split('?')[0];
  if (SKIP.has(path) || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  const found = match(req);
  const mutating = req.method !== 'GET';
  if (!mutating && !(found && found.rule.log)) return next();

  res.on('finish', () => {
    // No session and not a sign-in: an anonymous probe, nothing to attribute.
    if (!req.user && !(found && found.rule.category === 'auth') && !res.locals.auditUser) return;
    const ok = res.statusCode < 400;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const query = req.query || {};
    const params = found ? found.params : {};
    const extra = res.locals.audit || {};
    const ctx = { ok, body, query, params };

    (async () => {
      let category = 'other';
      let action = `${req.method.toLowerCase()} ${path}`;
      let summary = `${req.method} ${path}`;
      let entityType;
      let entityId;
      if (found) {
        const r = found.rule;
        ({ category, action } = r.classify ? r.classify(ctx) : r);
        try { summary = await r.summary(ctx); } catch { summary = action; }
        entityType = r.entityType;
        entityId = r.entity ? r.entity(params, body) : undefined;
      }
      if (extra.summary) summary = extra.summary;
      // (A failed sign-in already says so.)
      const failedLogin = found && found.rule.action === 'auth.login' && res.statusCode === 401;
      if (!ok && !failedLogin) summary = `${summary} — failed (${res.statusCode}${res.locals.auditError ? `: ${res.locals.auditError}` : ''})`;

      await record(req, {
        user: req.user || res.locals.auditUser,
        category,
        action,
        summary,
        entityType: extra.entityType || entityType,
        entityId: extra.entityId ?? entityId,
        success: ok,
        statusCode: res.statusCode,
        details: {
          ...(extra.downloadRef && ok ? { downloadRef: extra.downloadRef } : {}),
          ...(Object.keys(query).length ? { query: sanitize(query) } : {}),
          ...(mutating && Object.keys(body).length ? { request: sanitize(body) } : {}),
          ...(extra.details || {})
        }
      });
    })();
  });

  // Keep the error message a failed request sent back, for the summary.
  const json = res.json.bind(res);
  res.json = (payload) => {
    if (res.statusCode >= 400 && payload && typeof payload.error === 'string') res.locals.auditError = payload.error.slice(0, 200);
    return json(payload);
  };
  next();
}

module.exports = auditTrail;
