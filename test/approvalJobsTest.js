// Tests sync/approvalJobs.js — overdue reminders and escalation emails —
// against an in-memory fake database and notifier injected into Node's
// require cache. No real database or email.
//   node test/approvalJobsTest.js

const path = require('path');
const Module = require('module');

const HOUR = 3600 * 1000;
const T = 'Subcontractor A';
const DUE = Date.parse('2026-10-03T14:00:00Z'); // Day shift ended 17:00 EAT

const accounts = [
  { id: 1, name: 'Sup A', email: 'supa@test', role: 'supervisor', crewId: 1, active: true, subcontractorName: T },
  { id: 2, name: 'Sup B', email: 'supb@test', role: 'supervisor', crewId: 2, active: true, subcontractorName: T },
  { id: 3, name: 'Hana HR', email: 'hr@test', role: 'hr', crewId: null, active: true, subcontractorName: T },
  { id: 4, name: 'Ada AA', email: 'aa@test', role: 'admin_assistant', crewId: null, active: true, subcontractorName: T },
  { id: 5, name: 'Fin', email: 'fin@test', role: 'finance', crewId: null, active: true, subcontractorName: T }
];
let units = [];
const rows = [
  ...Array.from({ length: 10 }, () => ({ approvalKey: 'crew:1:2026-10-03:1', status: 'on-time', changedAfterApproval: false })),
  { approvalKey: 'crew:1:2026-10-03:1', status: 'late', changedAfterApproval: false },
  { approvalKey: 'crew:1:2026-10-03:1', status: 'no-show', changedAfterApproval: false },
  { approvalKey: 'crew:1:2026-10-03:1', status: 'no-checkout', changedAfterApproval: true },
  { approvalKey: `hr:${T}:2026-10-03:1`, status: 'on-time', changedAfterApproval: false }
];
const sent = [];

const matches = (u, where) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(u[k]);
  if (v && typeof v === 'object' && 'lte' in v) return new Date(u[k]) <= v.lte;
  return u[k] === v;
});
const fakePrisma = {
  approvalUnit: {
    findMany: async ({ where }) => units.filter((u) => matches(u, where)).map((u) => ({ ...u })),
    updateMany: async ({ where, data }) => { units.filter((u) => where.id.in.includes(u.id)).forEach((u) => Object.assign(u, data)); }
  },
  portalUser: { findMany: async ({ where }) => accounts.filter((a) => matches(a, where)) },
  crew: { findMany: async () => [{ id: 1, name: 'Crew A' }, { id: 2, name: 'Crew B' }] },
  shift: { findMany: async () => [{ id: 1, name: 'Day' }, { id: 2, name: 'Night' }] },
  dailyAttendanceSummary: {
    groupBy: async ({ where }) => {
      const out = new Map();
      for (const r of rows.filter((x) => where.approvalKey.in.includes(x.approvalKey))) {
        const k = `${r.approvalKey}|${r.status}|${r.changedAfterApproval}`;
        if (!out.has(k)) out.set(k, { approvalKey: r.approvalKey, status: r.status, changedAfterApproval: r.changedAfterApproval, _count: { _all: 0 } });
        out.get(k)._count._all++;
      }
      return [...out.values()];
    }
  }
};
const fakeNotify = {
  notifyUsers: async (users, n) => { for (const u of users.filter((x) => x.active)) sent.push({ to: u.email, ...n }); return users.length; },
  usersWithRoles: async (roles, tenant) => accounts.filter((a) => roles.includes(a.role) && a.active && a.subcontractorName === tenant)
};
function inject(rel, exports) {
  const file = path.join(__dirname, '..', rel);
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}
inject('prismaClient.js', fakePrisma);
inject('services/notify.js', fakeNotify);
delete process.env.APPROVAL_TRACKING_FROM;

const { runApprovalJobs, describeBatch } = require('../sync/approvalJobs');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }
const to = (type) => sent.filter((s) => s.type === type).map((s) => s.to).sort().join(',');

function reset() {
  sent.length = 0;
  units = [
    { id: 1, key: 'crew:1:2026-10-03:1', kind: 'crew-shift', subcontractorName: T, date: new Date('2026-10-03T00:00:00Z'), shiftId: 1, crewId: 1, month: null, dueAt: new Date(DUE), status: 'pending', reopenedAt: null, dueNotifiedAt: new Date(DUE), overdueRemindedAt: null, escalatedAt: null },
    { id: 2, key: `hr:${T}:2026-10-03:1`, kind: 'hr-shift', subcontractorName: T, date: new Date('2026-10-03T00:00:00Z'), shiftId: 1, crewId: null, month: null, dueAt: new Date(DUE), status: 'pending', reopenedAt: null, dueNotifiedAt: new Date(DUE), overdueRemindedAt: null, escalatedAt: null }
  ];
}

(async () => {
  reset();
  await runApprovalJobs(DUE + 23 * HOUR);
  check('Nothing before 24h', sent.length === 0);

  await runApprovalJobs(DUE + 25 * HOUR);
  check('24h: overdue reminder to the crew supervisor and HR (for the permanent-staff shift), nobody else', to('approval-overdue') === 'hr@test,supa@test');
  check('24h: reminders go by email', sent.every((s) => s.email === true));
  const supMail = sent.find((s) => s.to === 'supa@test');
  check('24h: the email lists the batch with its records and issues', supMail.body.includes('Crew A · Day · 2026-10-03')
    && supMail.body.includes('13 records — 1 late, 1 absent, 1 missing punch, 1 changed after approval'));
  check('24h: …how long it has waited and when it escalates', supMail.body.includes('(25 h ago)') && supMail.body.includes('Escalates to HR and the Admin Assistant'));
  check('24h: HR is told its own shift escalates to the Admin Assistant', sent.find((s) => s.to === 'hr@test').body.includes('Escalates to the Admin Assistant'));
  check('24h: no escalation yet', !units.some((u) => u.escalatedAt));

  sent.length = 0;
  await runApprovalJobs(DUE + 30 * HOUR);
  check('Not reminded again within 24h', sent.length === 0);

  await runApprovalJobs(DUE + 48 * HOUR);
  check('48h: both escalated', units.every((u) => u.escalatedAt));
  check('48h: HR and the Admin Assistant get the escalation by email', sent.filter((s) => s.title.includes('escalated to you')).map((s) => s.to).sort().join(',') === 'aa@test,hr@test'
    && sent.every((s) => s.email === true));
  const supEsc = sent.find((s) => s.to === 'supa@test');
  check('48h: the crew supervisor is emailed that their shift was escalated (and can still approve)', supEsc && supEsc.type === 'approval-escalated' && supEsc.body.includes('You can still approve'));
  check('48h: no separate overdue reminder alongside the escalation', to('approval-overdue') === '');
  check('48h: escalation email carries the batch details', sent.find((s) => s.to === 'aa@test').body.includes('13 records'));
  check('Another crew’s supervisor hears nothing', !sent.some((s) => s.to === 'supb@test' || s.to === 'fin@test'));

  sent.length = 0;
  await runApprovalJobs(DUE + 60 * HOUR);
  check('Not reminded within 24h of the escalation', sent.length === 0);
  await runApprovalJobs(DUE + 72 * HOUR);
  check('72h: one reminder per person, listing every overdue batch they can approve', to('approval-overdue') === 'aa@test,hr@test,supa@test'
    && sent.find((s) => s.to === 'hr@test').title.startsWith('2 shift approvals overdue'));
  check('72h: the supervisor is reminded only about their own crew', sent.find((s) => s.to === 'supa@test').title.startsWith('1 shift approval overdue'));

  sent.length = 0;
  units[0].status = 'approved';
  units[1].status = 'approved';
  await runApprovalJobs(DUE + 200 * HOUR);
  check('Approved batches are never reminded', sent.length === 0);

  // A reopened batch: the clock runs from the reopening.
  reset();
  Object.assign(units[0], { status: 'reopened', reopenedAt: new Date(DUE + 100 * HOUR) });
  units.pop();
  await runApprovalJobs(DUE + 110 * HOUR);
  check('Reopened: no reminder until 24h after the reopening', sent.length === 0);
  await runApprovalJobs(DUE + 125 * HOUR);
  check('Reopened: reminded 24h after, marked "re-approve"', to('approval-overdue') === 'supa@test' && sent[0].body.includes('changed — re-approve') && sent[0].body.includes('Reopened'));

  const line = describeBatch({ kind: 'hr-month', month: '2026-09', dueAt: new Date(DUE), status: 'pending' }, { label: 'Permanent staff · 2026-09', now: DUE + 30 * HOUR });
  check('Monthly batch: no escalation line', line.includes('0 records') && !/Escalat/.test(line));

  console.log('\nChecks:');
  let allPassed = true;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) allPassed = false;
  }
  console.log(`${checks.filter((c) => c[1]).length}/${checks.length} passed`);
  process.exit(allPassed ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
