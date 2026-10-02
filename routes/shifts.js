const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole } = require('../middleware/requireRole');
const { recomputeLookback } = require('../services/recompute');
const { withSyncLock } = require('../services/liveSync');

const router = express.Router();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Shift rules are visible to every role, so everyone can see exactly how
// lateness, early check-outs and the check-in windows are judged.
router.get('/shifts', authenticate, async (req, res) => {
  try {
    const shifts = await prisma.shift.findMany({ orderBy: { id: 'asc' } });
    res.json({ shifts });
  } catch (err) {
    console.error('Failed to fetch shifts:', err);
    res.status(500).json({ error: 'Could not load shifts.' });
  }
});

router.put('/shifts/:id', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const data = {};

  for (const field of ['startTime', 'endTime', 'earliestCheckIn', 'latestCheckOut']) {
    if (body[field] === undefined) continue;
    if (!HHMM.test(body[field])) return res.status(400).json({ error: `${field} must be HH:mm.` });
    data[field] = body[field];
  }
  for (const field of ['graceMinutes', 'earlyOutGraceMinutes']) {
    if (body[field] === undefined) continue;
    const n = Number(body[field]);
    if (!Number.isInteger(n) || n < 0 || n > 240) return res.status(400).json({ error: `${field} must be a whole number of minutes (0-240).` });
    data[field] = n;
  }

  try {
    const shift = await prisma.shift.findUnique({ where: { id } });
    if (!shift) return res.status(404).json({ error: 'Shift not found.' });

    const next = { ...shift, ...data };
    if (next.earliestCheckIn > next.startTime) {
      return res.status(400).json({ error: 'Earliest check-in must be at or before the shift start.' });
    }

    const updated = await prisma.shift.update({ where: { id }, data: { ...data, updatedById: req.user.id } });
    // The audit entry keeps the old and new values side by side.
    res.locals.audit = { details: { before: Object.fromEntries(Object.keys(data).map((k) => [k, shift[k]])), after: data } };

    // Rules changed — rebuild the recent window so it reflects them.
    // Approved rows stay as approved and are flagged for re-approval if the
    // new rules change them. Waits for any BioStar sync in progress.
    const recalculated = await withSyncLock(() => recomputeLookback());
    res.locals.audit.details.recalculated = recalculated;
    res.json({ shift: updated, recalculated });
  } catch (err) {
    console.error('Failed to update shift:', err);
    res.status(500).json({ error: 'Could not update the shift rules.' });
  }
});

module.exports = router;
