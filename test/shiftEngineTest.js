// Unit tests for sync/shiftEngine.js — pure, no database.
//   node test/shiftEngineTest.js

const { classifyWorker, rotationShiftsFor, addDaysStr } = require('../sync/shiftEngine');

const DAY = { id: 1, name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '05:00', latestCheckOut: '05:00' };
const NIGHT = { id: 2, name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '14:00', latestCheckOut: '12:00' };
const shiftsByName = { Day: DAY, Night: NIGHT };

// A punch at an EAT wall-clock time ("HH:mm" or "HH:mm:ss").
let nextId = 1;
function punch(dateStr, time) {
  const t = time.length === 5 ? `${time}:00` : time;
  return { id: nextId++, timestamp: new Date(Date.parse(`${dateStr}T${t}.000Z`) - 3 * 3600 * 1000) };
}
function eatTime(date) {
  return date ? new Date(date.getTime() + 3 * 3600 * 1000).toISOString().slice(11, 19) : null;
}

const LATER = Date.parse('2030-01-01T00:00:00Z'); // "now" long after every test shift
const D1 = '2026-09-21';
const d = (n) => addDaysStr(D1, n - 1); // d(1) = D1, d(2) = the next day, ...

const always = (shifts) => () => ({ shifts, source: 'schedule' });
function rotation(pattern, anchor) {
  return (dateStr) => ({ shifts: rotationShiftsFor(pattern, anchor, dateStr), source: 'schedule' });
}
function withExceptions(base, exceptions) {
  return (dateStr) => (exceptions[dateStr] ? { shifts: exceptions[dateStr], source: 'exception' } : base(dateStr));
}
function run(punches, expectedFor, from = d(1), to = d(6), now = LATER) {
  return classifyWorker({ punches, shiftsByName, fromDate: from, toDate: to, expectedFor, now });
}
function find(rows, date, shiftName) {
  return rows.find((r) => r.date === date && r.shiftName === shiftName);
}

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

// --- Ordinary Day shift ---
{
  const rows = run([punch(d(1), '07:55'), punch(d(1), '17:05')], always(['Day']), d(1), d(1));
  const r = find(rows, d(1), 'Day');
  check('Day: 07:55-17:05 is one on-time Day shift', r && r.status === 'on-time');
  check('Day: hours worked 9.17, regular hours capped at 9', r && r.hoursWorked === 9.17 && r.regularHours === 9);
  check('Day: no meal deduction applied', r && r.hoursWorked === 9.17);
}

// --- Late threshold: after 08:30 is late, 08:30 exactly is not ---
{
  const onTime = find(run([punch(d(1), '08:30:00'), punch(d(1), '17:00')], always(['Day']), d(1), d(1)), d(1), 'Day');
  const late = find(run([punch(d(1), '08:30:01'), punch(d(1), '17:00')], always(['Day']), d(1), d(1)), d(1), 'Day');
  check('Late: check-in at 08:30:00 is not late', onTime.status === 'on-time' && !onTime.lateIn);
  check('Late: check-in at 08:30:01 is late', late.status === 'late' && late.lateIn);
}

// --- Early out: any check-out before 17:00 ---
{
  const early = find(run([punch(d(1), '07:58'), punch(d(1), '16:59:06')], always(['Day']), d(1), d(1)), d(1), 'Day');
  const fine = find(run([punch(d(1), '07:58'), punch(d(1), '17:00:00')], always(['Day']), d(1), d(1)), d(1), 'Day');
  check('Early out: 16:59:06 flagged', early.earlyCheckOut === true);
  check('Early out: 17:00:00 not flagged', fine.earlyCheckOut === false);
}

// --- Ordinary Night shift crossing midnight ---
{
  const r = find(run([punch(d(1), '17:05'), punch(d(2), '07:55')], always(['Night']), d(1), d(1)), d(1), 'Night');
  check('Night: 17:05 -> 07:55 next morning anchored to its start date', r && eatTime(r.checkIn) === '17:05:00' && eatTime(r.checkOut) === '07:55:00');
  check('Night: on time, 14.83h', r && r.status === 'on-time' && r.hoursWorked === 14.83);
}

// --- Double taps seconds apart are one badge ---
{
  const r = find(run([punch(d(1), '07:50:00'), punch(d(1), '07:50:36'), punch(d(1), '17:02')], always(['Day']), d(1), d(1)), d(1), 'Day');
  check('Double tap: merged — check-in 07:50:00, check-out 17:02', eatTime(r.checkIn) === '07:50:00' && eatTime(r.checkOut) === '17:02:00');
  check('Double tap: not flagged as multiple punches', r.hasMultiplePunches === false);
  const solo = find(run([punch(d(1), '17:31:51'), punch(d(1), '17:31:57')], always(['Day']), d(1), d(1)), d(1), 'Day');
  check('Double tap alone: one badge, not a 6-second shift', solo.checkIn === null && eatTime(solo.checkOut) === '17:31:57' && solo.hoursWorked === null);
}

// --- Crew rotation Day,Day,Night,Night,off,off with a missed check-out and
// a missed check-in: each only affects its own shift (the old alternation
// logic flipped every later shift). ---
const ROT = rotation('DDNNOO', d(1));
{
  const punches = [
    punch(d(1), '07:58'),                          // Day 1: forgot to badge out
    punch(d(2), '07:50'), punch(d(2), '17:03'),    // Day 2
    /* Night 3 check-in missed */ punch(d(4), '08:01'), // Night 3 out
    punch(d(4), '17:06'), punch(d(5), '07:59')     // Night 4
  ];
  const rows = run(punches, ROT);
  check('Rotation: Day 1 is a Day shift with no checkout', find(rows, d(1), 'Day')?.status === 'no-checkout');
  check('Rotation: Day 2 unaffected by Day 1’s missed checkout', find(rows, d(2), 'Day')?.status === 'on-time');
  const n3 = find(rows, d(3), 'Night');
  check('Rotation: Night 3 missed check-in → no-checkin with the 08:01 check-out', n3?.status === 'no-checkin' && eatTime(n3.checkOut) === '08:01:00');
  const n4 = find(rows, d(4), 'Night');
  check('Rotation: Night 4 unaffected by Night 3’s missed check-in', eatTime(n4?.checkIn) === '17:06:00' && eatTime(n4?.checkOut) === '07:59:00');
  check('Rotation: nothing recorded as the wrong shift', rows.every((r) => r.source === 'schedule') && !find(rows, d(3), 'Day') && !find(rows, d(1), 'Night'));
  check('Rotation: off days produce no rows', !rows.some((r) => r.date === d(5) || r.date === d(6)));
}

// --- Double shift (Day + Night same date) ---
{
  const both = withExceptions(always(['Day']), { [d(1)]: ['Day', 'Night'] });

  const shared = run([punch(d(1), '07:57'), punch(d(1), '17:00'), punch(d(2), '08:02')], both, d(1), d(1));
  const sd = find(shared, d(1), 'Day');
  const sn = find(shared, d(1), 'Night');
  check('Double shift: two rows, one per shift', shared.length === 2 && sd && sn);
  check('Double shift: single 17:00 badge ends Day and starts Night', eatTime(sd.checkOut) === '17:00:00' && eatTime(sn.checkIn) === '17:00:00' && eatTime(sn.checkOut) === '08:02:00');
  check('Double shift: rows marked as exception', sd.source === 'exception' && sn.source === 'exception');

  const separate = run([punch(d(1), '07:57'), punch(d(1), '16:55'), punch(d(1), '17:05'), punch(d(2), '08:02')], both, d(1), d(1));
  check('Double shift: separate out/in badges go to each shift', eatTime(find(separate, d(1), 'Day').checkOut) === '16:55:00' && eatTime(find(separate, d(1), 'Night').checkIn) === '17:05:00');

  const implied = run([punch(d(1), '07:57'), punch(d(2), '08:02')], both, d(1), d(1));
  const id = find(implied, d(1), 'Day');
  const inn = find(implied, d(1), 'Night');
  check('Double shift without a changeover badge: split at 17:00, marked implied', eatTime(id.checkOut) === '17:00:00' && id.checkOutImplied && eatTime(inn.checkIn) === '17:00:00' && inn.checkInImplied);
}

// --- Night straight into the next morning's Day (zero rest) ---
{
  const exp = withExceptions(always([]), { [d(1)]: ['Night'], [d(2)]: ['Day'] });
  const rows = run([punch(d(1), '17:00'), punch(d(2), '07:55'), punch(d(2), '08:05'), punch(d(2), '17:00')], exp, d(1), d(2));
  const n = find(rows, d(1), 'Night');
  const dd = find(rows, d(2), 'Day');
  check('Night→Day: Night ends at 07:55, Day starts at 08:05', eatTime(n.checkOut) === '07:55:00' && eatTime(dd.checkIn) === '08:05:00');
}

// --- A swapped-in shift for one date doesn't leave a phantom Day row ---
{
  const exp = withExceptions(always(['Day']), { [d(1)]: ['Night'] });
  const rows = run([punch(d(1), '17:02'), punch(d(2), '08:00'), punch(d(2), '17:01')], exp, d(1), d(2));
  check('Swap: Night on d1 gets 17:02 → 08:00', eatTime(find(rows, d(1), 'Night')?.checkOut) === '08:00:00');
  check('Swap: back on Day d2 with its own 17:01 check-out, check-in shared from the night’s 08:00', eatTime(find(rows, d(2), 'Day')?.checkOut) === '17:01:00');
}

// --- Worker with no schedule: classified by clock time, flagged ---
{
  const rows = run([punch(d(1), '08:00'), punch(d(1), '17:00'), punch(d(2), '17:05'), punch(d(3), '07:55')], always([]), d(1), d(3));
  check('Unscheduled: morning start → Day', find(rows, d(1), 'Day')?.source === 'unscheduled');
  const n = find(rows, d(2), 'Night');
  check('Unscheduled: evening start → Night through next morning', n?.source === 'unscheduled' && eatTime(n.checkOut) === '07:55:00');
}

// --- New worker's test punch the day they're enrolled doesn't disturb
// their real shifts afterwards ---
{
  const exp = (dateStr) => ({ shifts: dateStr >= d(2) ? ['Day'] : [], source: 'schedule' });
  const rows = run([punch(d(1), '14:30'), punch(d(2), '07:58'), punch(d(2), '17:04'), punch(d(3), '08:01'), punch(d(3), '17:00')], exp, d(1), d(3));
  const test = rows.find((r) => r.date === d(1));
  check('Test punch: shown as a flagged unscheduled single punch', test && test.source === 'unscheduled' && test.hoursWorked === null);
  check('Test punch: following Day shifts are correct', eatTime(find(rows, d(2), 'Day')?.checkIn) === '07:58:00' && eatTime(find(rows, d(3), 'Day')?.checkOut) === '17:00:00');
}

// --- Punches on a rotation off day are flagged, not silently absorbed ---
{
  const rows = run([punch(d(5), '08:02'), punch(d(5), '17:00')], ROT, d(5), d(5));
  check('Off-day work: flagged unscheduled', rows.length === 1 && rows[0].source === 'unscheduled');
}

// --- No-shows and shifts still running ---
{
  const past = run([], always(['Day']), d(1), d(1));
  check('No-show: expected Day with no punches after it ended', past.length === 1 && past[0].status === 'no-show');
  const duringShift = Date.parse(`${d(1)}T10:00:00Z`); // 13:00 EAT
  const future = run([], always(['Day']), d(1), d(1), duringShift);
  check('No-show: not reported while the shift is still running', future.length === 0);
  const inProgress = run([punch(d(1), '07:59')], always(['Day']), d(1), d(1), duringShift);
  check('In progress: checked in, shift still running', inProgress[0]?.status === 'in-progress');
}

// --- Same answer no matter where the computation window starts ---
{
  const punches = [];
  for (let day = 1; day <= 14; day++) {
    const code = 'DDNNOO'[(day - 1) % 6];
    if (code === 'D') {
      punches.push(punch(d(day), '07:5' + (day % 10)));
      if (day % 5 !== 0) punches.push(punch(d(day), '17:0' + (day % 10))); // some missed check-outs
      if (day % 4 === 0) punches.push(punch(d(day), '07:59')); // some re-badges
    } else if (code === 'N') {
      if (day % 3 !== 0) punches.push(punch(d(day), '17:1' + (day % 10))); // some missed check-ins
      punches.push(punch(d(day + 1), '08:0' + (day % 10)));
    }
  }
  const full = run(punches, ROT, d(1), d(14));
  const late = run(punches, ROT, d(7), d(14));
  const strip = (rows) => JSON.stringify(rows.filter((r) => r.date >= d(7)).map(({ punchIds, ...r }) => r));
  check('Determinism: computing from d1 or d7 gives identical rows for d7..d14', strip(full) === strip(late));
}

// --- rotationShiftsFor ---
check('Rotation lookup: anchor day is D', rotationShiftsFor('DDNNOO', '2026-09-21', '2026-09-21')[0] === 'Day');
check('Rotation lookup: day 3 is N', rotationShiftsFor('DDNNOO', '2026-09-21', '2026-09-23')[0] === 'Night');
check('Rotation lookup: day 5 is off', rotationShiftsFor('DDNNOO', '2026-09-21', '2026-09-25').length === 0);
check('Rotation lookup: dates before the anchor wrap correctly', rotationShiftsFor('DDNNOO', '2026-09-21', '2026-09-19').length === 0 && rotationShiftsFor('DDNNOO', '2026-09-21', '2026-09-17')[0] === 'Night');

console.log('\nChecks:');
let allPassed = true;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) allPassed = false;
}
process.exit(allPassed ? 0 : 1);
