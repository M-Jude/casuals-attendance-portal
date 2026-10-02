// Deleting a portal account: System Admin only, never yourself or the last
// active System Admin; removes the account and its notifications only —
// worker and attendance records are untouched — and keeps the name for
// "approved by". Real route and middleware, in-memory tables.
//   node test/accountDeleteTest.js

process.env.JWT_SECRET = 'test-secret';

const path = require('path');
const jwt = require('jsonwebtoken');

const T = 'A';
const accounts = new Map([
  [1, { id: 1, email: 'ict@caa.co.ug', name: 'ICT One', role: 'sysadmin', active: true, subcontractorName: T, mfaEnabledAt: new Date(), createdAt: new Date('2026-01-01') }],
  [2, { id: 2, email: 'sup@caa.co.ug', name: 'Sam Supervisor', role: 'supervisor', active: true, subcontractorName: T, casualWorkerId: 50, crewId: 7, createdAt: new Date('2026-02-01') }],
  [3, { id: 3, email: 'hr@caa.co.ug', name: 'Hana HR', role: 'hr', active: true, subcontractorName: T, createdAt: new Date('2026-01-05') }],
  [4, { id: 4, email: 'audit@caa.co.ug', name: 'Aud', role: 'auditor', active: true, subcontractorName: T, createdAt: new Date('2026-01-05') }]
]);
const notifications = [{ id: 1, userId: 2 }, { id: 2, userId: 2 }, { id: 3, userId: 3 }];
const deleted = [];
const workers = new Map([[50, { id: 50, name: 'Sam Supervisor', status: 'active' }]]);
const attendance = [{ id: 900, casualWorkerId: 50, approvedById: 2 }];

const fake = {
  portalUser: {
    findUnique: async ({ where }) => accounts.get(where.id) || null,
    findFirst: async ({ where }) => { const a = accounts.get(where.id); return a && a.subcontractorName === where.subcontractorName ? a : null; },
    findMany: async ({ where }) => [...accounts.values()].filter((a) => (!where.role || a.role === where.role) && (where.active === undefined || a.active === where.active)),
    count: async ({ where }) => [...accounts.values()].filter((a) => a.role === where.role && a.active === where.active && a.id !== where.id.not).length,
    delete: async ({ where }) => { if (!accounts.has(where.id)) throw Object.assign(new Error('gone'), { code: 'P2025' }); const a = accounts.get(where.id); accounts.delete(where.id); return a; }
  },
  notification: {
    deleteMany: async ({ where }) => { const before = notifications.length; for (let i = notifications.length - 1; i >= 0; i--) if (notifications[i].userId === where.userId) notifications.splice(i, 1); return { count: before - notifications.length }; },
    create: async ({ data }) => ({ id: 99, ...data }),
    update: async () => ({})
  },
  deletedAccount: { create: async ({ data }) => { deleted.push({ ...data, deletedAt: new Date() }); return data; } },
  $transaction: async (ops) => Promise.all(ops)
};
require.cache[path.resolve(__dirname, '../prismaClient.js')] = { loaded: true, exports: fake };

const express = require('express');
const { nameAt } = require('../services/accountNames');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/users'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const del = async (id, asUser, extra = {}) => {
    const r = await fetch(`${base}/api/users/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${jwt.sign({ userId: asUser, ...extra }, 'test-secret')}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    check('HR can’t delete accounts', (await del(2, 3)).status === 403);
    const audit = await del(2, 4);
    check('the Auditor can’t either (read-only)', audit.status === 403 && audit.body.code === 'READ_ONLY');
    check('a System Admin can’t delete their own account', (await del(1, 1, { mfa: true })).status === 400);

    const ok = await del(2, 1, { mfa: true });
    check('a System Admin deletes a supervisor’s account', ok.status === 200 && !accounts.has(2));
    check('their notifications go with it', notifications.every((n) => n.userId !== 2) && notifications.length === 1);
    check('the worker record is untouched', workers.get(50) && workers.get(50).status === 'active');
    check('attendance (and who approved it) is untouched', attendance[0].approvedById === 2 && attendance[0].casualWorkerId === 50);
    check('the name is kept for history', deleted.length === 1 && deleted[0].accountId === 2 && deleted[0].name === 'Sam Supervisor' && deleted[0].deletedById === 1);
    const again = await del(2, 1, { mfa: true });
    check('deleting it again: already done', again.status === 404 && again.body.code === 'ALREADY_DONE');

    accounts.set(5, { id: 5, email: 'ict2@caa.co.ug', name: 'ICT Two', role: 'sysadmin', active: true, subcontractorName: T, mfaEnabledAt: new Date(), createdAt: new Date('2026-03-01') });
    accounts.get(1).active = true;
    // ICT Two is not the last admin while ICT One is active.
    check('another System Admin can be deleted while one stays', (await del(5, 1, { mfa: true })).status === 200 && !accounts.has(5));
    // Only an active System Admin can delete, and never themselves, so a
    // System Admin always remains (the route also refuses the last one, as a
    // backstop — see adminSafeguardsTest for that rule).
    const admins = [...accounts.values()].filter((a) => a.role === 'sysadmin' && a.active);
    check('a System Admin always remains after deleting another', admins.length >= 1 && admins.some((a) => a.id === 1));
  } finally {
    console.warn = origWarn;
    server.close();
  }

  // "Approved by" names, including deleted and re-used ids.
  const live = new Map([[3, { name: 'Hana HR', createdAt: '2026-01-05' }], [8, { name: 'New Person', createdAt: '2026-06-01' }]]);
  const gone = new Map([[2, [{ name: 'Sam Supervisor', accountCreatedAt: '2026-02-01', deletedAt: '2026-05-01' }]], [8, [{ name: 'Old Holder', accountCreatedAt: '2026-01-01', deletedAt: '2026-05-15' }]]]);
  check('a live approver is named', nameAt(3, '2026-03-01', live, gone) === 'Hana HR');
  check('a deleted approver is still named', nameAt(2, '2026-03-01', live, gone) === 'Sam Supervisor (account deleted)');
  check('a re-used id names who held it at the time', nameAt(8, '2026-03-01', live, gone) === 'Old Holder (account deleted)' && nameAt(8, '2026-07-01', live, gone) === 'New Person');
  check('no approver: blank', nameAt(null, null, live, gone) === '');

  let failed = 0;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
