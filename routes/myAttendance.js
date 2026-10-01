const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

// "My attendance": the signed-in account holder's own shifts, from the worker
// record linked to their account. Everyone sees all of their own records,
// whatever their role would otherwise let them see (Finance included).
router.get('/me/attendance', authenticate, async (req, res) => {
  if (!req.user.casualWorkerId) {
    return res.status(404).json({ error: 'Your account is not linked to a worker record.' });
  }
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    return res.status(400).json({ error: 'Choose a start and end date.' });
  }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) {
    return res.status(400).json({ error: 'Choose a period of about a year or less.' });
  }

  try {
    const [worker, summaries] = await Promise.all([
      prisma.casualWorker.findUnique({ where: { id: req.user.casualWorkerId }, select: { id: true, name: true, biostarUserId: true } }),
      prisma.dailyAttendanceSummary.findMany({
        where: {
          casualWorkerId: req.user.casualWorkerId,
          date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }
        },
        include: {
          worker: { select: { id: true, name: true, biostarUserId: true } },
          shift: { select: { id: true, name: true } }
        },
        orderBy: [{ date: 'desc' }, { shiftId: 'asc' }]
      })
    ]);
    res.json({ worker, summaries });
  } catch (err) {
    console.error('Failed to load own attendance:', err);
    res.status(500).json({ error: 'Could not load your attendance.' });
  }
});

module.exports = router;
