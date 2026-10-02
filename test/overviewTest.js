// The Overview figures and the Director's weekly digest — pure, no
// database.
//   node test/overviewTest.js

const path = require('path');
require.cache[path.resolve(__dirname, '../prismaClient.js')] = { loaded: true, exports: {} };

const { computeOverview, compare, attention, digestText } = require('../reports/overview');
const { wholeMonths } = require('../services/overviewData');
const { lastWeek } = require('../sync/weeklyDigest');
const { canApprove } = require('../sync/approvalLogic');
const { READ_ONLY_ROLES, CAN_CREATE, ROLE_LABELS } = require('../middleware/requireRole');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

let id = 0;
const row = (worker, date, shift, extra = {}) => ({
  id: ++id, date: new Date(`${date}T00:00:00Z`), status: 'on-time', hoursWorked: 12, lateIn: false, earlyCheckOut: false,
  approvalCrewId: 1, approvedAt: null, changedAfterApproval: false, worker: { id: worker }, shift: { name: shift }, ...extra
});

const rows = [
  row(1, '2026-09-01', 'Day', { approvedAt: new Date() }),
  row(1, '2026-09-01', 'Night', { approvedAt: new Date() }), // Day + Night = a double shift
  row(2, '2026-09-01', 'Day', { lateIn: true, status: 'late' }),
  row(2, '2026-09-02', 'Day', { status: 'no-show', hoursWorked: null }),
  row(3, '2026-09-02', 'Night', { status: 'no-checkout', hoursWorked: null, approvalCrewId: 2 }),
  row(4, '2026-09-03', 'Day', { approvalCrewId: null, earlyCheckOut: true, hoursWorked: 9.5 })
];
const crews = [{ id: 1, name: 'Crew A' }, { id: 2, name: 'Crew B' }];
const now = Date.parse('2026-10-01T00:00:00Z');
const units = [
  { kind: 'crew-shift', status: 'approved', dueAt: '2026-09-01T14:00:00Z', approvedAt: '2026-09-02T08:00:00Z' }, // on time
  { kind: 'crew-shift', status: 'approved', dueAt: '2026-09-02T14:00:00Z', approvedAt: '2026-09-06T08:00:00Z', escalatedAt: '2026-09-04T14:00:00Z' }, // late
  { kind: 'crew-shift', status: 'pending', dueAt: '2026-09-03T14:00:00Z' },
  { kind: 'crew-shift', status: 'pending', dueAt: '2026-11-01T14:00:00Z' } // not due yet: not counted
];

const none = computeOverview({ rows, units, crews, now });
const t = none.totals;
check('workers who turned up', t.workers === 4);
check('shifts worked excludes no-shows; Day/Night split', t.shiftsWorked === 5 && t.dayShifts === 3 && t.nightShifts === 2);
check('hours add up (missing hours count as 0)', t.hours === 45.5);
check('no-shows, late, early out, missing punches', t.noShows === 1 && t.late === 1 && t.earlyOut === 1 && t.missingPunch === 1);
check('attendance rate', t.attendanceRate === 83.3);
check('double shifts counted once per pair', t.doubleShifts === 1);
check('approved vs pending shifts', t.approvedShifts === 2 && t.pendingShifts === 3);
check('by crew, permanent staff last', none.byCrew.map((c) => c.crew).join(',') === 'Crew A,Crew B,Permanent staff');
check('crew A figures', none.byCrew[0].shifts === 3 && none.byCrew[0].noShows === 1 && none.byCrew[0].late === 1 && none.byCrew[0].workers === 2);
check('approvals: only batches already due', none.approvals.batches === 3 && none.approvals.approved === 2 && none.approvals.waiting === 1);
check('approvals: on time = within 48 h; escalations counted', none.approvals.approvedOnTime === 1 && none.approvals.onTimeRate === 50 && none.approvals.escalated === 1);
check('no rates: cost is open', none.cost.configured === false && none.cost.currency === 'UGX');
check('open cost is flagged', attention(none, null).some((a) => /Pay rates/.test(a)));

const priced = computeOverview({ rows, units, crews, now, rates: { currency: 'UGX', dayShift: 20000, nightShift: 25000 } });
check('cost = shifts × rate (3 Day + 2 Night)', priced.cost.total === 3 * 20000 + 2 * 25000);
check('cost split approved / pending', priced.cost.approved === 45000 && priced.cost.pending === 65000);
const half = computeOverview({ rows, units, crews, now, rates: { currency: 'UGX', dayShift: 20000, nightShift: null } });
check('one rate open: partial estimate', half.cost.configured && half.cost.partial && half.cost.total === 60000);

const previous = computeOverview({ rows: rows.slice(0, 3), units: [], crews, now });
const change = compare(none, previous);
check('change on previous period', change.shiftsWorked === 2 && change.noShows === 1);

const text = digestText({ overview: priced, change, periodLabel: 'week of 28 Sep – 4 Oct 2026', portalUrl: 'https://p.example' });
check('digest: headline figures', /Shifts worked: 5 \(Day 3, Night 2\) \(\+2 on the week before\)/.test(text) && /No-shows: 1/.test(text));
check('digest: by crew and approvals', /Crew A: 3 shifts/.test(text) && /Approvals: 2 of 3 batches approved \(50% on time\)/.test(text));
check('digest: cost when rates are set', /Estimated cost: UGX 110,000/.test(text));
check('digest: link to the overview', text.endsWith('Open the overview: https://p.example/?page=overview'));
check('digest: no cost line while rates are open', !/Estimated cost/.test(digestText({ overview: none, change: null, periodLabel: 'x' })));

check('last week = previous Monday–Sunday (run on a Monday)', JSON.stringify(lastWeek('2026-10-05')) === JSON.stringify({ from: '2026-09-28', to: '2026-10-04' }));
check('last week, run mid-week', JSON.stringify(lastWeek('2026-10-08')) === JSON.stringify({ from: '2026-09-28', to: '2026-10-04' }));
check('a whole month includes its HR monthly batch', wholeMonths('2026-09-01', '2026-09-30').join() === '2026-09');
check('a week includes no HR monthly batch', wholeMonths('2026-09-28', '2026-10-04').length === 0);

check('Director is a read-only role', READ_ONLY_ROLES.includes('director') && ROLE_LABELS.director === 'Director');
check('only the System Admin creates Directors', CAN_CREATE.sysadmin.includes('director') && !CAN_CREATE.hr.includes('director'));
check('Directors cannot approve, and are told why', /Directors/.test(canApprove({ role: 'director' }, { status: 'pending', kind: 'crew-shift', dueAt: 0 }, Date.now()).reason));

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
