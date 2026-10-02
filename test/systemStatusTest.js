// GET /api/system/status: who can see it, that each section is checked on
// its own (one failing check doesn't hide the rest), and how sync, email,
// deploy and account problems are reported. Database and BioStar stubbed.
//   node test/systemStatusTest.js

process.env.JWT_SECRET = 'test-secret';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.APP_BASE_URL = 'https://portal.example.ts.net';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

let dbDown = false;
const accounts = [
  { id: 1, role: 'sysadmin', active: true, subcontractorName: 'A', mustChangePassword: false, mfaEnabledAt: new Date() },
  { id: 2, role: 'auditor', active: true, subcontractorName: 'A', mustChangePassword: false, mfaEnabledAt: null },
  { id: 3, role: 'hr', active: true, subcontractorName: 'A', mustChangePassword: true, mfaEnabledAt: null }
];
const queryRaw = async () => { if (dbDown) throw new Error('connect ECONNREFUSED'); return [{ 1: 1 }]; };
require.cache[path.resolve(__dirname, '../prismaClient.js')] = {
  loaded: true,
  exports: {
    $queryRaw: queryRaw,
    portalUser: {
      findUnique: async ({ where }) => accounts.find((a) => a.id === where.id) || null,
      findMany: async () => accounts
    },
    attendanceLog: { findFirst: async () => ({ timestamp: new Date('2026-10-02T06:00:00Z') }) },
    shift: { findMany: async () => [{ name: 'Day' }, { name: 'Night' }] },
    casualWorker: { count: async () => 184 },
    crew: { count: async () => 3 },
    approvalUnit: { count: async ({ where }) => (where.escalatedAt ? 1 : 4) }
  }
};
require.cache[path.resolve(__dirname, '../sync/attendanceSync.js')] = { loaded: true, exports: { syncRecent: async () => ({ changedWorkerIds: [] }) } };

const express = require('express');
const { markFullSync, markFullSyncFailed } = require('../services/liveSync');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

async function main() {
  const app = express();
  app.use('/api', require('../routes/system'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (id, extra = {}) => ({ Authorization: `Bearer ${jwt.sign({ userId: id, ...extra }, 'test-secret')}` });
  const status = async (id, extra) => {
    const r = await fetch(`${base}/api/system/status`, { headers: as(id, extra) });
    return { code: r.status, body: await r.json() };
  };
  const section = (b, id) => b.sections.find((s) => s.id === id);

  try {
    check('HR can’t see it', (await status(3)).code === 403);
    const audit = await status(2);
    check('the Auditor can', audit.code === 200 && audit.body.sections.length === 7);
    const admin = await status(1, { mfa: true });
    check('a System Admin (signed in with the code) can', admin.code === 200);

    let b = admin.body;
    check('no sync yet since start: needs attention', section(b, 'biostar').status === 'warn');
    check('email set up, nothing sent yet: ok', section(b, 'email').status === 'ok');
    check('shifts and workers reported', section(b, 'setup').status === 'ok' && section(b, 'setup').details.activeWorkers === 184);
    check('one System Admin: warns to keep two', section(b, 'accounts').status === 'warn' && /at least two/.test(section(b, 'accounts').summary));
    check('escalated approvals flagged', section(b, 'approvals').status === 'warn' && section(b, 'approvals').details.escalated === 1);

    markFullSync();
    b = (await status(2)).body;
    check('after a good sync: ok', section(b, 'biostar').status === 'ok');
    markFullSyncFailed(new Error('BioStar login refused'));
    b = (await status(2)).body;
    check('a failed sync is a problem, with the reason', section(b, 'biostar').status === 'error' && /login refused/.test(section(b, 'biostar').summary) && b.overall === 'error');
    markFullSync();

    dbDown = true;
    b = (await status(2)).body;
    check('database down: that section fails…', section(b, 'database').status === 'error' && /ECONNREFUSED/.test(section(b, 'database').summary));
    check('…and the others still report', section(b, 'email').status === 'ok' && section(b, 'setup').status === 'ok');
    dbDown = false;

    // Deploy logs: the newest decides.
    const logs = path.join(__dirname, '../logs');
    const made = !fs.existsSync(logs);
    if (made) fs.mkdirSync(logs);
    const failedLog = path.join(logs, 'deploy-29991231-235959.log');
    fs.writeFileSync(failedLog, '==> npm ci\n==> prisma migrate deploy\nprisma migrate deploy failed (exit code 1)\n');
    try {
      b = (await status(2)).body;
      check('a failed last deploy is a problem', section(b, 'application').status === 'error' && /failed \(exit code 1\)/.test(section(b, 'application').summary));
    } finally {
      fs.unlinkSync(failedLog);
      if (made) fs.rmSync(logs, { recursive: true, force: true });
    }
  } finally {
    server.close();
  }

  let failed = 0;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
