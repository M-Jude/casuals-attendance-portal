const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { syncAttendance } = require('../sync/attendanceSync');

const router = express.Router();

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

  try {
    const logs = await prisma.attendanceLog.findMany({
      where: {
        timestamp: {
          gte: from ? new Date(from) : undefined,
          lte: to ? new Date(`${to}T23:59:59`) : undefined
        }
      },
      include: { worker: { select: { name: true, biostarUserId: true } } },
      orderBy: { timestamp: 'desc' }
    });

    res.json(logs);
  } catch (err) {
    console.error('Failed to fetch attendance:', err);
    res.status(500).json({ error: 'Could not load attendance records.' });
  }
});

module.exports = router;
