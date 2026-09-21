require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { syncAttendance } = require('./sync/attendanceSync');
const { computeSummaries } = require('./sync/computeDailySummaries');

const app = express();
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/attendance'));        // GET /api/attendance
app.use('/api', require('./routes/attendanceExport'));  // GET /api/attendance/export
app.use('/api', require('./routes/attendanceSummary'));  // GET /api/attendance/summary, /api/attendance/punches
app.use('/api', require('./routes/attendanceReport'));   // GET /api/attendance/report.pdf
app.use('/api', require('./routes/shiftRoster'));         // GET /api/shifts, roster template/upload

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Casuals attendance portal API listening on port ${PORT}`);
});

// Recomputes shift-aware daily summaries over the same lookback window the
// punch sync just covered. Cheap to over-compute (upsert-based), so this
// always re-runs the full window rather than trying to track exactly which
// days changed.
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
async function runSyncAndSummaries() {
  await syncAttendance();
  const lookback = parseInt(process.env.SYNC_LOOKBACK_DAYS, 10) || 14;
  await computeSummaries(daysAgoStr(lookback), todayStr());
}

// Sync + recompute hourly, plus once on startup so data isn't stale until
// the first scheduled tick.
cron.schedule('0 * * * *', () => {
  runSyncAndSummaries().catch((err) => console.error('Scheduled sync/compute failed:', err));
});
runSyncAndSummaries().catch((err) => console.error('Initial sync/compute failed:', err));
