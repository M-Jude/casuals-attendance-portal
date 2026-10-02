// System status: is the portal healthy, at a glance — for System Admins
// (UCAA ICT) and Auditors. Read-only. Each section is checked separately, so
// one failing check (e.g. the database) doesn't hide the others.
//
// Each section: { status: 'ok' | 'warn' | 'error', summary, details }.

const fs = require('fs');
const path = require('path');
const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole } = require('../middleware/requireRole');
const { liveSyncState, lastSyncAt } = require('../services/liveSync');
const { emailHealth } = require('../services/notify');

const router = express.Router();
const APP_DIR = path.join(__dirname, '..');
const STARTED_AT = new Date();
const HOUR = 3600 * 1000;

const ago = (date) => (date ? Date.now() - new Date(date).getTime() : Infinity);
const fail = (err) => ({ status: 'error', summary: `Check failed: ${err.message}`, details: {} });

async function database() {
  const started = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const ms = Date.now() - started;
  return { status: ms > 2000 ? 'warn' : 'ok', summary: `Connected (${ms} ms)`, details: { responseMs: ms } };
}

async function biostar() {
  const s = liveSyncState;
  const newest = await prisma.attendanceLog.findFirst({ orderBy: { timestamp: 'desc' }, select: { timestamp: true } });
  const details = {
    lastFullSyncAt: s.lastFullSyncAt,
    lastLiveSyncAt: s.lastLiveSyncAt,
    lastFullSyncError: s.lastFullSyncError,
    lastFullSyncFailedAt: s.lastFullSyncFailedAt,
    lastLiveSyncError: s.lastError,
    newestPunchAt: newest?.timestamp || null
  };
  if (s.lastFullSyncError) return { status: 'error', summary: `The last sync failed: ${s.lastFullSyncError}`, details };
  const last = lastSyncAt();
  if (!last) return { status: 'warn', summary: 'No sync has finished since the portal last started.', details };
  if (ago(last) > 2 * HOUR) return { status: 'warn', summary: 'No successful sync for over two hours.', details };
  if (s.lastError) return { status: 'warn', summary: `Hourly sync fine; the last live sync failed: ${s.lastError}`, details };
  return { status: 'ok', summary: 'Syncing normally.', details };
}

function email() {
  const configured = Boolean(process.env.SMTP_HOST);
  const details = {
    configured,
    host: process.env.SMTP_HOST || null,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    lastAttemptAt: emailHealth.lastAttemptAt,
    lastOkAt: emailHealth.lastOkAt,
    lastError: emailHealth.lastError,
    lastErrorAt: emailHealth.lastErrorAt
  };
  if (!configured) return { status: 'error', summary: 'Email isn’t set up (SMTP_HOST is empty) — no emails are sent.', details };
  if (emailHealth.lastError) return { status: 'error', summary: `The last email failed: ${emailHealth.lastError}`, details };
  if (!emailHealth.lastOkAt) return { status: 'ok', summary: 'Set up; no email sent since the portal last started.', details };
  return { status: 'ok', summary: 'Sending normally.', details };
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'version.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The newest deploy log written by deploy/windows/deploy.ps1.
function lastDeploy() {
  const dir = path.join(APP_DIR, 'logs');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^deploy-\d{8}-\d{6}\.log$/.test(f)).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const name = files[files.length - 1];
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  const ok = /==> Deployed/.test(text);
  const errorLine = ok ? null : (text.split(/\r?\n/).find((l) => /failed \(exit code|did not become healthy|not found/i.test(l)) || 'See the deploy log.').trim();
  const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return { file: name, at: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`, ok, error: errorLine };
}

function application() {
  const version = readVersion();
  const deploy = lastDeploy();
  const details = {
    commit: version?.commit || null,
    deployedAt: version?.deployedAt || null,
    runUrl: version?.runUrl || null,
    lastDeploy: deploy,
    startedAt: STARTED_AT,
    nodeVersion: process.version,
    publicUrl: process.env.APP_BASE_URL || null,
    syncLookbackDays: parseInt(process.env.SYNC_LOOKBACK_DAYS, 10) || 14,
    liveSyncMinutes: process.env.LIVE_SYNC_MINUTES === undefined ? 2 : parseInt(process.env.LIVE_SYNC_MINUTES, 10)
  };
  if (deploy && !deploy.ok) return { status: 'error', summary: `The last deploy (${deploy.at}) failed: ${deploy.error}`, details };
  if (!process.env.APP_BASE_URL) return { status: 'warn', summary: 'APP_BASE_URL isn’t set, so links in emails won’t work.', details };
  return { status: 'ok', summary: version?.commit && version.commit !== 'manual' ? `Running ${version.commit.slice(0, 7)}` : 'Running', details };
}

async function setup(subcontractorName) {
  const shifts = await prisma.shift.findMany({ select: { name: true } });
  const names = shifts.map((s) => s.name);
  const missing = ['Day', 'Night'].filter((n) => !names.includes(n));
  const [activeWorkers, crews] = await Promise.all([
    prisma.casualWorker.count({ where: { subcontractorName, status: 'active' } }),
    prisma.crew.count({ where: { subcontractorName } })
  ]);
  const details = { shifts: names, activeWorkers, crews };
  if (missing.length) return { status: 'error', summary: `The ${missing.join(' and ')} shift isn’t set up — attendance can’t be worked out. Run scripts/seedShifts.js.`, details };
  return { status: 'ok', summary: `${activeWorkers} active workers, ${crews} crews.`, details };
}

async function accounts(subcontractorName) {
  const users = await prisma.portalUser.findMany({ where: { subcontractorName }, select: { role: true, active: true, mustChangePassword: true, mfaEnabledAt: true } });
  const active = users.filter((u) => u.active);
  const admins = active.filter((u) => u.role === 'sysadmin');
  const byRole = {};
  for (const u of active) byRole[u.role] = (byRole[u.role] || 0) + 1;
  const details = {
    active: active.length,
    disabled: users.length - active.length,
    byRole,
    systemAdmins: admins.length,
    systemAdminsWithTwoStep: admins.filter((u) => u.mfaEnabledAt).length,
    onTemporaryPassword: active.filter((u) => u.mustChangePassword).length
  };
  if (admins.length < 2) return { status: 'warn', summary: `Only ${admins.length} active System Admin${admins.length === 1 ? '' : 's'} — keep at least two.`, details };
  if (details.systemAdminsWithTwoStep < admins.length) {
    const n = admins.length - details.systemAdminsWithTwoStep;
    return { status: 'warn', summary: `${n} System Admin${n === 1 ? ' hasn’t' : 's haven’t'} set up two-step sign-in yet (they will at their next sign-in).`, details };
  }
  return { status: 'ok', summary: `${active.length} active accounts; all ${admins.length} System Admins use two-step sign-in.`, details };
}

async function approvals(subcontractorName) {
  const open = { subcontractorName, status: { in: ['pending', 'reopened'] } };
  const [waiting, escalated] = await Promise.all([
    prisma.approvalUnit.count({ where: { ...open, dueAt: { lte: new Date() } } }),
    prisma.approvalUnit.count({ where: { ...open, escalatedAt: { not: null } } })
  ]);
  const details = { waiting, escalated };
  if (escalated) return { status: 'warn', summary: `${waiting} batch${waiting === 1 ? '' : 'es'} waiting, ${escalated} escalated to HR.`, details };
  return { status: 'ok', summary: waiting ? `${waiting} batch${waiting === 1 ? '' : 'es'} waiting for approval.` : 'Nothing waiting.', details };
}

router.get('/system/status', authenticate, requireRole('sysadmin', 'auditor'), async (req, res) => {
  const tenant = req.user.subcontractorName;
  const run = async (fn) => { try { return await fn(); } catch (err) { return fail(err); } };
  const [db, sync, mail, app, data, accts, appr] = await Promise.all([
    run(database), run(biostar), run(email), run(application), run(() => setup(tenant)), run(() => accounts(tenant)), run(() => approvals(tenant))
  ]);
  const sections = [
    { id: 'application', title: 'Portal', ...app },
    { id: 'database', title: 'Database', ...db },
    { id: 'biostar', title: 'BioStar sync', ...sync },
    { id: 'email', title: 'Email', ...mail },
    { id: 'setup', title: 'Shifts & workers', ...data },
    { id: 'accounts', title: 'Accounts & sign-in', ...accts },
    { id: 'approvals', title: 'Approvals', ...appr }
  ];
  const overall = sections.some((s) => s.status === 'error') ? 'error' : sections.some((s) => s.status === 'warn') ? 'warn' : 'ok';
  res.json({ checkedAt: new Date(), overall, sections });
});

module.exports = router;
