// Setting a badge aside: a badge made by mistake (an accidental tap, a test)
// is left out of every shift calculation but kept and shown, struck
// through, with who set it aside and why — and can be restored. The
// worker's records around it are worked out again straight away; with
// autoReapprove, approved records that change are re-approved as the person
// doing it (services/recompute.js).
//
//   POST /api/punches/:id/set-aside   { reason, autoReapprove }
//   POST /api/punches/:id/restore     { autoReapprove }
//   GET  /api/punches/set-aside?from=&to=   the badges set aside in a period
//
// HR, the Admin Assistant and the System Admin can do it for anyone; a
// supervisor for their own crew's workers, a badge in one of their crew's
// approval batches, or one they set aside themselves
// (services/setAsideBadges.js).

const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole } = require('../middleware/requireRole');
const { recomputeWorkers } = require('../services/recompute');
const { canChangeBadge, listSetAside, EDITORS } = require('../services/setAsideBadges');
const { addDaysStr, eatDateStr } = require('../sync/shiftEngine');

const router = express.Router();
const MAX_REASON = 500;
const MAX_LIST_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const httpError = (status, message) => Object.assign(new Error(message), { status });

// The badge, if this user may set it aside or restore it (else throws).
async function loadEditablePunch(user, id) {
  const punch = await prisma.attendanceLog.findFirst({
    where: { id, worker: { subcontractorName: user.subcontractorName } },
    include: { worker: { select: { id: true, name: true, biostarUserId: true } } }
  });
  if (!punch) throw httpError(404, 'Badge not found.');
  if (!(await canChangeBadge(user, punch))) throw httpError(403, 'You can only change badges of your own crew’s workers.');
  return punch;
}

// Works the worker's records out again around the badge.
function recompute(punch, user, autoReapprove) {
  const date = eatDateStr(punch.timestamp.getTime());
  return recomputeWorkers([punch.casualWorkerId], addDaysStr(date, -1), addDaysStr(date, 1), { autoApproveBy: autoReapprove ? user.id : null });
}

const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Badges set aside in a period (Kampala dates, inclusive) that this user may
// see, with whether they may restore each.
router.get('/punches/set-aside', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) return res.status(400).json({ error: 'Give a period: from and to (YYYY-MM-DD).' });
  if (Date.parse(to) - Date.parse(from) > MAX_LIST_DAYS * 24 * 3600 * 1000) return res.status(400).json({ error: `Choose a period of at most ${MAX_LIST_DAYS} days.` });
  try {
    res.json({ badges: await listSetAside(req.user, from, to) });
  } catch (err) {
    console.error('Failed to list set-aside badges:', err);
    res.status(500).json({ error: 'Could not load the badges set aside.' });
  }
});

router.post('/punches/:id/set-aside', authenticate, requireRole(...EDITORS, 'supervisor'), async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, MAX_REASON) : '';
  if (!reason) return res.status(400).json({ error: 'Say why this badge is being set aside.' });
  try {
    const punch = await loadEditablePunch(req.user, parseInt(req.params.id, 10));
    if (punch.setAsideAt) return res.status(409).json({ error: 'This badge has already been set aside.', code: 'ALREADY_DONE' });
    await prisma.attendanceLog.update({ where: { id: punch.id }, data: { setAsideAt: new Date(), setAsideById: req.user.id, setAsideReason: reason } });
    const recalculated = await recompute(punch, req.user, req.body?.autoReapprove === true);
    res.locals.audit = {
      entityType: 'worker', entityId: punch.casualWorkerId,
      summary: `Set aside ${punch.worker.name} (${punch.worker.biostarUserId})'s badge of ${when(punch.timestamp)}: ${reason}${req.body?.autoReapprove === true ? ', re-approving changed records automatically' : ''}`,
      details: { punchId: punch.id, recalculated }
    };
    res.json({ success: true, recalculated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to set badge aside:', err);
    res.status(500).json({ error: 'Could not set the badge aside.' });
  }
});

router.post('/punches/:id/restore', authenticate, requireRole(...EDITORS, 'supervisor'), async (req, res) => {
  try {
    const punch = await loadEditablePunch(req.user, parseInt(req.params.id, 10));
    if (!punch.setAsideAt) return res.status(409).json({ error: 'This badge is already counted.', code: 'ALREADY_DONE' });
    await prisma.attendanceLog.update({ where: { id: punch.id }, data: { setAsideAt: null, setAsideById: null, setAsideReason: null } });
    const recalculated = await recompute(punch, req.user, req.body?.autoReapprove === true);
    res.locals.audit = {
      entityType: 'worker', entityId: punch.casualWorkerId,
      summary: `Restored ${punch.worker.name} (${punch.worker.biostarUserId})'s badge of ${when(punch.timestamp)} (it had been set aside: ${punch.setAsideReason || 'no reason given'})${req.body?.autoReapprove === true ? ', re-approving changed records automatically' : ''}`,
      details: { punchId: punch.id, recalculated }
    };
    res.json({ success: true, recalculated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to restore badge:', err);
    res.status(500).json({ error: 'Could not restore the badge.' });
  }
});

module.exports = router;
