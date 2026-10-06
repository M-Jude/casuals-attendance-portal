// services/approveUnit.js reapproveRows — re-approving the records a
// schedule change held for re-approval — against an in-memory fake
// database. No real database.
//   node test/reapproveTest.js

const path = require('path');
const Module = require('module');

const FIRST = new Date('2026-10-02T10:00:00Z');
let rows = [];
let units = [];

const matchRow = (r, where) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((w) => matchRow(r, w));
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
  if (v && typeof v === 'object' && 'not' in v) return r[k] !== v.not;
  return r[k] === v;
});
const tx = {
  dailyAttendanceSummary: {
    findMany: async ({ where }) => rows.filter((r) => matchRow(r, where)).map((r) => ({ ...r })),
    count: async ({ where }) => rows.filter((r) => matchRow(r, where)).length,
    update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
    delete: async ({ where }) => { rows = rows.filter((r) => r.id !== where.id); }
  },
  approvalUnit: {
    findUnique: async ({ where }) => units.find((u) => u.key === where.key) || null,
    update: async ({ where, data }) => Object.assign(units.find((u) => u.key === where.key), data)
  }
};
const file = path.join(__dirname, '..', 'prismaClient.js');
const m = new Module(file);
m.filename = file;
m.loaded = true;
m.exports = { $transaction: async (fn) => fn(tx) };
require.cache[file] = m;

const { reapproveRows } = require('../services/approveUnit');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

function row(id, key, o = {}) {
  return { id, approvalKey: key, status: 'on-time', hoursWorked: 9, checkIn: null, checkOut: null, approvedAt: FIRST, approvedById: 7, changedAfterApproval: false, pendingValues: null, supervisorComment: null, ...o };
}

(async () => {
  const A = 'crew:1:2026-10-02:1';
  const HR = 'hr:S:2026-10-02:1';
  units = [
    { key: A, status: 'reopened', approvedAt: FIRST, approvedById: 7, reopenedAt: new Date() },
    { key: HR, status: 'pending', approvedAt: null, approvedById: null }
  ];
  rows = [
    row(1, A, { changedAfterApproval: true, pendingValues: { status: 'late', hoursWorked: 7.5, checkIn: '2026-10-02T06:00:00Z', checkOut: '2026-10-02T13:30:00Z', approvalKey: A } }),
    row(2, A, { changedAfterApproval: true, pendingValues: { deleted: true } }),
    row(3, A),
    row(4, A, { changedAfterApproval: true, pendingValues: { status: 'no-show', hoursWorked: null } }), // held for another reason, not passed in
    row(5, A, { changedAfterApproval: true, pendingValues: { status: 'on-time', approvalKey: HR, approvalCrewId: null } }),
    row(6, A, { approvedAt: null }) // never approved: not a re-approval
  ];

  const n = await reapproveRows([1, 2, 5, 6], { approverId: 3, now: new Date('2026-10-06T08:00:00Z') });
  const r1 = rows.find((r) => r.id === 1);
  check('Counts only rows that were held for re-approval', n === 3);
  check('Pending values applied and stamped as the person making the change', r1.status === 'late' && r1.hoursWorked === 7.5
    && r1.checkIn.toISOString() === '2026-10-02T06:00:00.000Z' && r1.approvedById === 3 && !r1.changedAfterApproval && r1.pendingValues !== undefined);
  check('A row no longer supported by the punches is removed', !rows.some((r) => r.id === 2));
  check('Rows not passed in are left held', rows.find((r) => r.id === 4).changedAfterApproval === true);
  check('A never-approved row is not approved', rows.find((r) => r.id === 6).approvedAt === null);
  check('A row moved to another batch goes with it', rows.find((r) => r.id === 5).approvalKey === HR && rows.find((r) => r.id === 5).approvedById === 3);
  check('Its old batch still has a held and an unapproved row: stays reopened', units[0].status === 'reopened');
  check('Its new batch, all approved now: approved, stamped as this change', units[1].status === 'approved' && units[1].approvedById === 3 && /schedule change/.test(units[1].comment));

  // Everything in the batch re-approved: the batch is approved again,
  // keeping who approved it originally.
  rows = [row(10, A, { changedAfterApproval: true, pendingValues: { status: 'early' } }), row(11, A)];
  units = [{ key: A, status: 'reopened', approvedAt: FIRST, approvedById: 7, reopenedAt: new Date() }];
  await reapproveRows([10], { approverId: 3 });
  check('Fully re-approved batch: approved again, original approver kept', units[0].status === 'approved' && units[0].approvedById === 7 && units[0].reopenedAt === null);

  check('Nothing passed in: nothing done', (await reapproveRows([], { approverId: 3 })) === 0);

  let failed = 0;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
