const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { summaryVisibility } = require('../middleware/requireRole');
const { getPunchDetailForSummary } = require('../sync/computeDailySummaries');

const router = express.Router();

const MAX_PAGE_SIZE = 5000;
const DEFAULT_PAGE_SIZE = 200;

const SUMMARY_INCLUDE = {
  worker: { select: { id: true, name: true, biostarUserId: true } },
  shift: { select: { id: true, name: true } }
};

// Shift-aware daily rows — this is what the dashboard table reads. What a
// user sees depends on their role (see summaryVisibility): Finance only
// approved rows, a supervisor only their crew's.
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
      ...summaryVisibility(req.user)
    };

    const [summaries, total] = await Promise.all([
      prisma.dailyAttendanceSummary.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy: [{ date: 'desc' }, { shiftId: 'asc' }],
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
  const summaryId = parseInt(req.query.summaryId, 10);
  if (!summaryId) return res.status(400).json({ error: 'summaryId is required.' });

  try {
    // 404 rather than 403 for a row outside the user's visibility — don't
    // confirm it exists.
    // Visible rows, plus the account holder's own shifts (My attendance).
    const own = req.user.casualWorkerId ? [{ id: summaryId, casualWorkerId: req.user.casualWorkerId }] : [];
    const summary = await prisma.dailyAttendanceSummary.findFirst({
      where: { OR: [{ id: summaryId, ...summaryVisibility(req.user) }, ...own] }
    });
    if (!summary) return res.status(404).json({ error: 'Record not found.' });

    const punches = await getPunchDetailForSummary(summary);
    res.json({ punches });
  } catch (err) {
    console.error('Failed to fetch punch history:', err);
    res.status(500).json({ error: 'Could not load punch history.' });
  }
});

module.exports = router;
