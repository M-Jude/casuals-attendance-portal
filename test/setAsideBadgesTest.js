// Badges set aside: who sees them in the list (dashboard, Exceptions report)
// and who may restore them — services/setAsideBadges.js, with an in-memory
// database.
//   node test/setAsideBadgesTest.js

const path = require('path');

const eat = (date, hhmm) => new Date(`${date}T${hhmm}:00+03:00`);
const W1 = { id: 1, name: 'Kugonza Edward', biostarUserId: 'C0052026' };
const W2 = { id: 2, name: 'Achieng Mary', biostarUserId: 'C0012026' };
const W3 = { id: 3, name: 'Okello John', biostarUserId: 'C0032026' };
const workers = new Map([[1, W1], [2, W2], [3, W3]]);

// W1 is on Crew A; W2 on Crew B; W3 unscheduled, his badge in Crew A's batch.
const punches = [
  { id: 10, casualWorkerId: 1, eventType: 'x', timestamp: eat('2026-10-07', '07:22'), setAsideAt: eat('2026-10-07', '10:00'), setAsideById: 50, setAsideReason: 'Accidental tap' },
  { id: 11, casualWorkerId: 2, eventType: 'x', timestamp: eat('2026-10-08', '06:40'), setAsideAt: eat('2026-10-08', '09:00'), setAsideById: 51, setAsideReason: 'Test badge' },
  { id: 12, casualWorkerId: 3, eventType: 'x', timestamp: eat('2026-10-09', '18:02'), setAsideAt: eat('2026-10-09', '19:00'), setAsideById: 50, setAsideReason: 'Double tap' },
  { id: 13, casualWorkerId: 2, eventType: 'x', timestamp: eat('2026-10-09', '08:00'), setAsideAt: eat('2026-10-09', '09:00'), setAsideById: 60, setAsideReason: 'Mine' },
  { id: 14, casualWorkerId: 1, eventType: 'x', timestamp: eat('2026-10-20', '08:00'), setAsideAt: eat('2026-10-20', '09:00'), setAsideById: 50, setAsideReason: 'Outside period' }
];
const schedules = [
  { casualWorkerId: 1, type: 'crew', crewId: 7, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  { casualWorkerId: 2, type: 'crew', crewId: 8, effectiveFrom: new Date('2026-01-01T00:00:00Z') }
];
const summaries = [{ casualWorkerId: 3, approvalCrewId: 7, punchIds: [12] }];

require.cache[path.resolve(__dirname, '../prismaClient.js')] = {
  loaded: true,
  exports: {
    attendanceLog: {
      findMany: async ({ where }) => punches
        .filter((p) => p.setAsideAt && p.timestamp >= where.timestamp.gte && p.timestamp < where.timestamp.lt
          && (!where.casualWorkerId || p.casualWorkerId === where.casualWorkerId))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((p) => ({ ...p, worker: workers.get(p.casualWorkerId) }))
    },
    workerSchedule: { findMany: async ({ where }) => schedules.filter((s) => where.casualWorkerId.in.includes(s.casualWorkerId)) },
    dailyAttendanceSummary: {
      findMany: async ({ where }) => summaries.filter((s) => where.casualWorkerId.in.includes(s.casualWorkerId) && s.approvalCrewId === where.approvalCrewId)
    },
    portalUser: { findMany: async () => [{ id: 50, name: 'Nakato Ruth', email: 'r@x', createdAt: new Date('2026-01-01') }] },
    deletedAccount: { findMany: async () => [] }
  }
};

const { listSetAside, canChangeBadge } = require('../services/setAsideBadges');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

const user = (role, o = {}) => ({ id: 1, role, subcontractorName: 'A', crewId: null, ...o });
const ids = (list) => list.map((b) => b.id).join(',');

(async () => {
  const hr = await listSetAside(user('hr'), '2026-10-01', '2026-10-15');
  check('HR: every badge in the period, oldest first', ids(hr) === '10,11,13,12');
  check('HR: may restore them', hr.every((b) => b.canRestore));
  check('Who set it aside, and why', hr[0].setAside.by === 'Nakato Ruth' && hr[0].setAside.reason === 'Accidental tap' && hr[0].worker.name === 'Kugonza Edward');

  const auditor = await listSetAside(user('auditor'), '2026-10-01', '2026-10-15');
  check('Auditor: sees them all, restores none', ids(auditor) === '10,11,13,12' && auditor.every((b) => !b.canRestore));
  check('Finance: none listed', (await listSetAside(user('finance'), '2026-10-01', '2026-10-15')).length === 0);

  const supA = await listSetAside(user('supervisor', { id: 70, crewId: 7 }), '2026-10-01', '2026-10-15');
  check('Supervisor: own crew’s workers and badges in their batches only', ids(supA) === '10,12');
  const supB = await listSetAside(user('supervisor', { id: 60, crewId: 9 }), '2026-10-01', '2026-10-15');
  check('Supervisor: a badge they set aside themselves', ids(supB) === '13');
  check('One worker only', ids(await listSetAside(user('hr'), '2026-10-01', '2026-10-15', { workerId: 2 })) === '11,13');

  const withWorker = (id) => ({ ...punches.find((p) => p.id === id), worker: workers.get(punches.find((p) => p.id === id).casualWorkerId) });
  check('canChangeBadge: Admin Assistant, anyone', await canChangeBadge(user('admin_assistant'), withWorker(11)));
  check('canChangeBadge: supervisor, not another crew’s worker', !(await canChangeBadge(user('supervisor', { id: 70, crewId: 7 }), withWorker(11))));
  check('canChangeBadge: supervisor, own crew', await canChangeBadge(user('supervisor', { id: 70, crewId: 7 }), withWorker(10)));
  check('canChangeBadge: a read-only role, never', !(await canChangeBadge(user('director'), withWorker(10))));

  const failed = checks.filter(([, ok]) => !ok);
  for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
