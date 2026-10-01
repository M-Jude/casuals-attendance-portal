require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { syncAttendance } = require('./sync/attendanceSync');
const { runApprovalJobs } = require('./sync/approvalJobs');
const { runProfiling } = require('./sync/profilingJob');
const { recomputeLookback } = require('./services/recompute');

const app = express();
app.use(express.json());

// Liveness probe for the deploy script — registered before the routers so
// it never goes through their auth middleware.
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));             // POST /login, GET /me
app.use('/api', require('./routes/users'));                // accounts (System Admin, HR)
app.use('/api', require('./routes/attendance'));           // POST /attendance/sync, GET /attendance (raw punches)
app.use('/api', require('./routes/attendanceExport'));     // GET /attendance/export
app.use('/api', require('./routes/attendanceSummary'));    // GET /attendance/summary, /attendance/punches
app.use('/api', require('./routes/attendanceReport'));     // GET /attendance/report.pdf
app.use('/api', require('./routes/shifts'));               // shift rules
app.use('/api', require('./routes/schedules'));            // crews, rotations, worker schedules, exceptions, pattern review
app.use('/api', require('./routes/approvals'));            // shift approvals
app.use('/api', require('./routes/notifications'));        // in-app notifications

// In production the built React app (`npm run build` → dist/) is served from
// here too, so the portal and API share one origin. In development Vite
// serves the frontend instead and dist/ doesn't exist.
const DIST = path.join(__dirname, 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Casuals attendance portal API listening on port ${PORT}`);
});

const EAT = { timezone: 'Africa/Kampala' };

// Summaries are rebuilt from scratch over the same lookback window the punch
// sync just covered (approved rows stay locked — see computeDailySummaries).
async function runSyncAndSummaries() {
  await syncAttendance();
  await recomputeLookback();
  await runApprovalJobs();
}

function logFailure(label) {
  return (err) => console.error(`${label} failed:`, err);
}

// Sync + recompute hourly, plus once on startup so data isn't stale until
// the first scheduled tick.
cron.schedule('0 * * * *', () => { runSyncAndSummaries().catch(logFailure('Scheduled sync/compute')); }, EAT);
runSyncAndSummaries().catch(logFailure('Initial sync/compute'));

// Approval reminders and 48h escalations don't need to wait for the hourly
// sync (and must still fire if BioStar is unreachable).
cron.schedule('*/15 * * * *', () => { runApprovalJobs().catch(logFailure('Approval jobs')); }, EAT);

// Pattern profiling once a day, after the night shift's punches are in.
cron.schedule('30 3 * * *', () => { runProfiling().catch(logFailure('Pattern profiling')); }, EAT);
