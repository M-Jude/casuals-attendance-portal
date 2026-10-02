const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole, ROLE_LABELS } = require('../middleware/requireRole');
const { record, downloadStamp } = require('../services/audit');
const { fmtDateTime } = require('../reports/reportFormat');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = ['auth', 'account', 'approval', 'attendance', 'schedule', 'settings', 'download', 'report', 'notification', 'other'];
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 50000;

// Filters from the query string. Dates are Kampala calendar days.
function auditWhere(user, q) {
  const and = [{ OR: [{ subcontractorName: user.subcontractorName }, { subcontractorName: null }] }];
  if (DATE_RE.test(q.from || '')) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00+03:00`) } });
  if (DATE_RE.test(q.to || '')) and.push({ createdAt: { lt: new Date(new Date(`${q.to}T00:00:00+03:00`).getTime() + 86400000) } });
  const userId = parseInt(q.userId, 10);
  if (userId) and.push({ userId });
  if (CATEGORIES.includes(q.category)) and.push({ category: q.category });
  if (q.result === 'ok') and.push({ success: true });
  if (q.result === 'failed') and.push({ success: false });
  const text = String(q.q || '').trim().slice(0, 100);
  if (text) {
    and.push({
      OR: ['summary', 'userEmail', 'userName', 'ipAddress', 'device', 'action'].map((f) => ({ [f]: { contains: text } }))
    });
  }
  return { AND: and };
}

// The audit trail, newest first — System Admin only.
router.get('/audit', authenticate, requireRole('sysadmin', 'auditor'), async (req, res) => {
  const size = Math.min(parseInt(req.query.size, 10) || 50, MAX_PAGE_SIZE);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const where = auditWhere(req.user, req.query);
  try {
    const [entries, total, accounts] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size }),
      prisma.auditLog.count({ where }),
      prisma.portalUser.findMany({ where: { subcontractorName: req.user.subcontractorName }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: 'asc' } })
    ]);
    res.json({ entries, total, page, size, users: accounts, categories: CATEGORIES });
  } catch (err) {
    console.error('Failed to load audit log:', err);
    res.status(500).json({ error: 'Could not load the audit log.' });
  }
});

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The filtered trail as CSV, stamped with who downloaded it (this download
// is itself logged, with the same reference).
router.get('/audit/export', authenticate, requireRole('sysadmin', 'auditor'), async (req, res) => {
  try {
    const where = auditWhere(req.user, req.query);
    const entries = await prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: MAX_EXPORT_ROWS + 1 });
    if (entries.length > MAX_EXPORT_ROWS) {
      return res.status(413).json({ error: `More than ${MAX_EXPORT_ROWS} entries — narrow the dates or filters.` });
    }
    const stamp = downloadStamp(req, res);
    const header = ['Entry', 'Time (EAT)', 'User', 'Email', 'Role', 'Category', 'Action', 'Summary', 'Result', 'Status', 'IP address', 'Device', 'User agent', 'Method', 'Path', 'Details'];
    const lines = [
      ['UCAA-ARK GROUP CASUALS - AUDIT LOG'],
      ['Downloaded by', stamp.by],
      ['Downloaded at', stamp.atText],
      ['Download reference', stamp.ref],
      ['Entries', entries.length],
      [],
      header,
      ...entries.map((e) => [
        e.id, fmtDateTime(e.createdAt), e.userName || '', e.userEmail || '', ROLE_LABELS[e.userRole] || e.userRole || '',
        e.category, e.action, e.summary, e.success ? 'OK' : 'Failed', e.statusCode ?? '', e.ipAddress || '', e.device || '',
        e.userAgent || '', e.method, e.path, e.details ? JSON.stringify(e.details) : ''
      ])
    ];
    const csv = `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ucaa-casuals_audit-log_${stamp.ref}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  } catch (err) {
    console.error('Audit export failed:', err);
    res.status(500).json({ error: 'Could not export the audit log.' });
  }
});

// Things that happen only in the browser but still belong in the trail.
// Only these event types are accepted, so the endpoint can't be used to
// write arbitrary entries.
const CLIENT_EVENTS = {
  'report.print': (b) => ({ category: 'download', action: 'print.report', summary: `Printed report "${String(b.report || '').slice(0, 120)}" (${String(b.period || '').slice(0, 80)})`, entityType: 'report', entityId: String(b.reportId || '').slice(0, 60) })
};

router.post('/audit/event', authenticate, async (req, res) => {
  const make = CLIENT_EVENTS[req.body?.type];
  if (!make) return res.status(400).json({ error: 'Unknown event.' });
  const event = make(req.body);
  await record(req, { ...event, statusCode: 204, details: { printedAt: new Date().toISOString() } });
  res.status(204).end();
});

module.exports = router;
