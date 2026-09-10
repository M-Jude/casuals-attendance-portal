const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { getPunchDetailForSummary } = require('../sync/computeDailySummaries');

const router = express.Router();

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 200;

// Shift-aware daily rows — this is what the dashboard table reads.
router.get('/attendance/summary', authenticate, async (req, res) => {
  const { from, to } = req.query; // YYYY-MM-DD
  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const where = {
      date: {
        gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
        lte: to ? new Date(`${to}T00:00:00.000Z`) : undefined
      },
      // Same tenant scoping as the raw attendance routes.
      worker: { subcontractorName: req.user.subcontractorName }
    };

    const [summaries, total] = await Promise.all([
      prisma.dailyAttendanceSummary.findMany({
        where,
        include: {
          worker: { select: { id: true, name: true, biostarUserId: true } },
          shift: { select: { id: true, name: true } },
          rosteredShift: { select: { id: true, name: true } }
        },
        orderBy: { date: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.dailyAttendanceSummary.count({ where })
    ]);

    res.json({ summaries, total, limit, offset });
  } catch (err) {
    console.error('Failed to fetch daily summaries:', err);
    res.status(500).json({ error: 'Could not load attendance summaries.' });
  }
});

// Raw punch history behind a single summary row — powers the modal.
router.get('/attendance/punches', authenticate, async (req, res) => {
  const workerId = parseInt(req.query.workerId, 10);
  const shiftId = parseInt(req.query.shiftId, 10);
  const date = req.query.date; // YYYY-MM-DD, the summary's own anchor date

  if (!workerId || !shiftId || !date) {
    return res.status(400).json({ error: 'workerId, shiftId, and date are required.' });
  }

  try {
    const worker = await prisma.casualWorker.findUnique({ where: { id: workerId } });
    // 404 rather than 403 for a cross-tenant worker id — don't confirm
    // another subcontractor's worker even exists.
    if (!worker || worker.subcontractorName !== req.user.subcontractorName) {
      return res.status(404).json({ error: 'Worker not found.' });
    }

    const punches = await getPunchDetailForSummary(workerId, shiftId, date);
    res.json({ punches });
  } catch (err) {
    console.error('Failed to fetch punch history:', err);
    res.status(500).json({ error: 'Could not load punch history.' });
  }
});

module.exports = router;
