const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { syncAttendance } = require('../sync/attendanceSync');
const { computeSummaries } = require('../sync/computeDailySummaries');

const router = express.Router();

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 200;

// Guards against overlapping syncs (a manual click landing mid-cron-run, or
// a double click) — syncAttendance()'s upserts are idempotent so it wouldn't
// corrupt anything, just waste a redundant BioStar round trip.
let syncInProgress = false;

router.post('/attendance/sync', authenticate, async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ error: 'A sync is already in progress. Try again shortly.' });
  }

  syncInProgress = true;
  try {
    await syncAttendance();

    const lookback = parseInt(process.env.SYNC_LOOKBACK_DAYS, 10) || 14;
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date();
    from.setDate(from.getDate() - lookback);
    await computeSummaries(from.toISOString().slice(0, 10), today);

    res.json({ success: true });
  } catch (err) {
    console.error('Manual sync failed:', err);
    res.status(500).json({ error: 'Sync failed — the BioStar server may be unreachable. Check server logs.' });
  } finally {
    syncInProgress = false;
  }
});

router.get('/attendance', authenticate, async (req, res) => {
  const { from, to } = req.query; // optional date range filter, YYYY-MM-DD
  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    // Both boundaries are built in UTC explicitly — a bare `new Date("2026-09-08")`
    // parses as UTC midnight, but `new Date("2026-09-08T23:59:59")` (no offset)
    // parses in the *server's local* timezone. Appending "Z" pins both ends to
    // UTC so the range means the same thing regardless of where this runs.
    const where = {
      timestamp: {
        gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
        lte: to ? new Date(`${to}T23:59:59.999Z`) : undefined
      },
      // Scope to the logged-in subcontractor's own workers only. Without this,
      // any authenticated PortalUser sees every subcontractor's records —
      // harmless today with one subcontractor, but a real cross-tenant leak
      // the moment a second account exists.
      worker: { subcontractorName: req.user.subcontractorName }
    };

    const [logs, total] = await Promise.all([
      prisma.attendanceLog.findMany({
        where,
        include: { worker: { select: { name: true, biostarUserId: true, status: true } } },
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.attendanceLog.count({ where })
    ]);

    res.json({ logs, total, limit, offset });
  } catch (err) {
    console.error('Failed to fetch attendance:', err);
    res.status(500).json({ error: 'Could not load attendance records.' });
  }
});

module.exports = router;
