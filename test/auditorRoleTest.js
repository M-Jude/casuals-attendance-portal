// The Auditor role: sees everything, changes nothing. Checks the read-only
// gate in authenticate (with the real middleware, an in-memory account
// table), that no route that changes data names the auditor, that auditors
// can't approve, and that HR can't create or manage auditor accounts.
//   node test/auditorRoleTest.js

process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const accounts = new Map([
  [1, { id: 1, email: 'audit@caa.co.ug', name: 'Audit', role: 'auditor', active: true, subcontractorName: 'A', mustChangePassword: false }],
  [2, { id: 2, email: 'hr@caa.co.ug', name: 'HR', role: 'hr', active: true, subcontractorName: 'A', mustChangePassword: false }]
]);
require.cache[path.resolve(__dirname, '../prismaClient.js')] = {
  loaded: true,
  exports: { portalUser: { findUnique: async ({ where }) => accounts.get(where.id) || null } }
};

const express = require('express');
const authenticate = require('../middleware/authenticate');
const { readOnlyAllows } = authenticate;
const { CAN_CREATE, ROLES, ROLE_LABELS, READ_ONLY_ROLES } = require('../middleware/requireRole');
const { canApprove } = require('../sync/approvalLogic');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

// ---------------------------------------------------------------- the role
check('auditor is a role, labelled "Auditor"', ROLES.includes('auditor') && ROLE_LABELS.auditor === 'Auditor');
check('auditor is read-only', READ_ONLY_ROLES.includes('auditor'));
check('System Admin can create auditors', CAN_CREATE.sysadmin.includes('auditor'));
check('HR cannot create or manage auditors', !CAN_CREATE.hr.includes('auditor'));

// ---------------------------------------------------------------- the gate
check('reads are allowed', readOnlyAllows('GET', '/api/audit?from=2026-10-01'));
check('sign-out allowed', readOnlyAllows('POST', '/api/auth/logout'));
check('own password change allowed', readOnlyAllows('POST', '/api/auth/change-password'));
check('logging a print allowed', readOnlyAllows('POST', '/api/audit/event'));
check('marking own notifications read allowed', readOnlyAllows('POST', '/api/notifications/12/read') && readOnlyAllows('POST', '/api/notifications/read-all'));
for (const [method, url] of [
  ['POST', '/api/approvals/5/approve'], ['POST', '/api/attendance/sync'], ['POST', '/api/users'], ['PATCH', '/api/users/3'],
  ['PUT', '/api/shifts/1'], ['POST', '/api/crews'], ['PATCH', '/api/crews/1'], ['POST', '/api/crews/1/rotations'],
  ['POST', '/api/crews/proposals/2/apply'], ['POST', '/api/workers/9/schedule'], ['POST', '/api/pattern-review/9/accept'],
  ['PUT', '/api/exceptions'], ['DELETE', '/api/exceptions/4'], ['POST', '/api/notifications/12/read/../../../users']
]) {
  check(`blocked: ${method} ${url}`, !readOnlyAllows(method, url));
}

// ------------------------------------------- no change route names auditor
const routesDir = path.join(__dirname, '../routes');
const offenders = [];
for (const file of fs.readdirSync(routesDir)) {
  const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
  for (const m of src.matchAll(/router\.(post|put|patch|delete)\(([^\n]*)/g)) {
    if (/auditor|VIEWERS/.test(m[2])) offenders.push(`${file}: ${m[0].slice(0, 80)}`);
  }
}
check(`no POST/PUT/PATCH/DELETE route lets the auditor in${offenders.length ? ` (${offenders.join('; ')})` : ''}`, offenders.length === 0);

// --------------------------------------------------------------- approvals
const unit = { status: 'pending', kind: 'crew-shift', crewId: 1, dueAt: new Date(0), escalatedAt: new Date(0) };
const verdict = canApprove({ role: 'auditor' }, unit, Date.now());
check('auditors cannot approve, and are told why', verdict.ok === false && /Auditors/.test(verdict.reason));

// ----------------------------------------------- the real middleware, live
async function main() {
  const app = express();
  app.use(express.json());
  app.get('/api/thing', authenticate, (req, res) => res.json({ ok: true }));
  app.post('/api/thing', authenticate, (req, res) => res.json({ changed: true }));
  app.post('/api/auth/logout', authenticate, (req, res) => res.status(204).end());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (id) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, 'test-secret')}`, 'Content-Type': 'application/json' });

  try {
    const read = await fetch(`${base}/api/thing`, { headers: as(1) });
    check('auditor: a read goes through', read.status === 200);
    const write = await fetch(`${base}/api/thing`, { method: 'POST', headers: as(1), body: '{}' });
    const body = await write.json();
    check('auditor: a change is refused with a clear reason', write.status === 403 && body.code === 'READ_ONLY');
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: as(1) });
    check('auditor: can still sign out', out.status === 204);
    const hr = await fetch(`${base}/api/thing`, { method: 'POST', headers: as(2), body: '{}' });
    check('other roles are unaffected', hr.status === 200);
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
