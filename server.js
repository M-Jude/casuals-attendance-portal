require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { syncAttendance } = require('./sync/attendanceSync');
const { runApprovalJobs } = require('./sync/approvalJobs');
const { runProfiling } = require('./sync/profilingJob');
const { recomputeLookback } = require('./services/recompute');
const { runWeeklyDigest } = require('./sync/weeklyDigest');
const { runLiveSync, withSyncLock, markFullSync, markFullSyncFailed } = require('./services/liveSync');

const app = express();

// Client IP addresses for the audit log. Behind a reverse proxy (IIS, nginx,
// or Vite's dev proxy) the real address is in X-Forwarded-For, which is only
// believed from a trusted hop. Default: loopback, i.e. a proxy on this same
// machine. Set TRUST_PROXY to a hop count, an address/subnet, or "false".
const trustProxy = process.env.TRUST_PROXY ?? 'loopback';
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy);

app.use(express.json());
app.use('/api', require('./middleware/auditTrail'));         // audit log: every change, download and sign-in

// Liveness probe for the deploy script — registered before the routers so
// it never goes through their auth middleware.
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));             // POST /login, GET /me
app.use('/api', require('./routes/users'));                // accounts (System Admin, HR)
app.use('/api', require('./routes/attendance'));           // POST /attendance/sync, GET /attendance (raw punches)
app.use('/api', require('./routes/attendanceExport'));     // GET /attendance/export
app.use('/api', require('./routes/attendanceSummary'));    // GET /attendance/summary, /attendance/punches
app.use('/api', require('./routes/attendanceReport'));     // GET /attendance/report.pdf
app.use('/api', require('./routes/reports'));              // report catalog + GET /reports/:type (json, csv, xlsx, pdf)
app.use('/api', require('./routes/myAttendance'));         // GET /me/attendance (the account holder's own shifts)
app.use('/api', require('./routes/live'));                 // GET /live (who's in on a crew's current shift)
app.use('/api', require('./routes/shifts'));               // shift rules
app.use('/api', require('./routes/schedules'));            // crews, rotations, worker schedules, exceptions, pattern review
app.use('/api', require('./routes/approvals'));            // shift approvals
app.use('/api', require('./routes/notifications'));        // in-app notifications
app.use('/api', require('./routes/audit'));                // audit log (System Admin, Auditor)
app.use('/api', require('./routes/system'));               // GET /system/status (System Admin, Auditor)
app.use('/api', require('./routes/overview'));             // GET /overview (Director, HR, System Admin, Auditor)

// In production the built React app (`npm run build` → dist/) is served from
// here too, so the portal and API share one origin. In development Vite
// serves the frontend instead and dist/ doesn't exist.
const DIST = path.join(__dirname, 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

const PORT = process.env.PORT || 4000;
// HOST=127.0.0.1 in production keeps the API reachable only through the
// reverse proxy on this machine; unset, it listens on every interface.
app.listen(PORT, process.env.HOST, () => {
  console.log(`Casuals attendance portal API listening on port ${PORT}`);
});

const EAT = { timezone: 'Africa/Kampala' };

// Summaries are rebuilt from scratch over the same lookback window the punch
// sync just covered (approved rows stay locked — see computeDailySummaries).
// Runs under the shared sync lock so it never overlaps a live sync.
async function runSyncAndSummaries() {
  await withSyncLock(async () => {
    try {
      await syncAttendance();
      await recomputeLookback();
      markFullSync();
    } catch (err) {
      markFullSyncFailed(err);
      throw err;
    }
  });
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

// Live sync for the Live page: today's badges every LIVE_SYNC_MINUTES
// (default 2; 0 turns it off). Skips a tick if another sync is running.
const LIVE_SYNC_MINUTES = process.env.LIVE_SYNC_MINUTES === undefined ? 2 : parseInt(process.env.LIVE_SYNC_MINUTES, 10);
if (LIVE_SYNC_MINUTES > 0) {
  cron.schedule(`*/${LIVE_SYNC_MINUTES} * * * *`, () => { runLiveSync().catch(logFailure('Live sync')); }, EAT);
}

// Pattern profiling once a day, after the night shift's punches are in.
cron.schedule('30 3 * * *', () => { runProfiling().catch(logFailure('Pattern profiling')); }, EAT);

// The Director's weekly attendance digest, Monday 07:00 — after Sunday's
// night shift has ended and been synced.
cron.schedule('0 7 * * 1', () => { runWeeklyDigest().catch(logFailure('Weekly digest')); }, EAT);
