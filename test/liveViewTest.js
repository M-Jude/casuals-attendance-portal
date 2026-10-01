// Unit tests for sync/liveView.js — pure, no database.
//   node test/liveViewTest.js

const { pickShift, buildBoard } = require('../sync/liveView');
const { rotationShiftsFor, shiftGeometry } = require('../sync/shiftEngine');

const DAY = { id: 1, name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '05:00', latestCheckOut: '05:00' };
const NIGHT = { id: 2, name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '14:00', latestCheckOut: '12:00' };
const shiftsByName = { Day: DAY, Night: NIGHT };
const at = (date, time) => Date.parse(`${date}T${time}:00+03:00`);

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

// Crew on DDNNOO from 21 Sep: 21-22 Day, 23-24 Night, 25-26 off.
const shiftsOn = (d) => rotationShiftsFor('DDNNOO', '2026-09-21', d);

// --- Which shift is "on now" ---
{
  let p = pickShift({ shiftsOn, shiftsByName, now: at('2026-09-21', '10:15') });
  check('Mid-morning on a Day: that Day shift, in progress', p.shiftName === 'Day' && p.date === '2026-09-21' && p.phase === 'in-progress' && p.current);
  p = pickShift({ shiftsOn, shiftsByName, now: at('2026-09-21', '06:30') });
  check('06:30 before a Day: that Day, upcoming (people arriving)', p.shiftName === 'Day' && p.phase === 'upcoming' && p.current);
  p = pickShift({ shiftsOn, shiftsByName, now: at('2026-09-22', '18:10') });
  check('Just after a Day ends: still that Day, finishing (late check-outs)', p.shiftName === 'Day' && p.date === '2026-09-22' && p.phase === 'finishing');
  p = pickShift({ shiftsOn, shiftsByName, now: at('2026-09-24', '03:00') });
  check('03:00 during a Night: the Night that started the evening before', p.shiftName === 'Night' && p.date === '2026-09-23' && p.phase === 'in-progress');
  p = pickShift({ shiftsOn, shiftsByName, now: at('2026-09-24', '15:30') });
  check('Between Nights: the Night about to start, not the one that ended', p.shiftName === 'Night' && p.date === '2026-09-24' && p.phase === 'upcoming');
  p = pickShift({ shiftsOn, shiftsByName, now: at('2026-09-25', '14:00') });
  check('Off day: the next shift, marked not current', p.shiftName === 'Day' && p.date === '2026-09-27' && p.current === false);
}

// --- Where each person stands ---
{
  const instance = { shiftName: 'Day', date: '2026-09-21', geometry: shiftGeometry(DAY, '2026-09-21'), phase: 'in-progress' };
  const w = (id) => ({ id, name: `W${id}`, biostarUserId: `C${id}` });
  const rows = {
    1: { checkIn: new Date(at('2026-09-21', '07:50')), checkOut: null, status: 'in-progress' },
    2: { checkIn: new Date(at('2026-09-21', '08:45')), checkOut: null, status: 'in-progress', lateIn: true },
    3: { checkIn: new Date(at('2026-09-21', '07:55')), checkOut: new Date(at('2026-09-21', '09:30')), status: 'on-time', earlyCheckOut: true },
    6: { checkIn: new Date(at('2026-09-21', '08:00')), checkOut: null, status: 'in-progress' }
  };
  const badges = { 5: [at('2026-09-21', '09:58')] }; // badged, record not yet recomputed
  const people = [1, 2, 3, 4, 5].map((id) => ({ worker: w(id), expected: true })).concat([{ worker: w(6), expected: false, cover: true }]);
  const b = buildBoard({ instance, shift: DAY, people, rowFor: (id) => rows[id] || null, badgesFor: (id) => badges[id] || [], now: at('2026-09-21', '10:00') });
  const st = (id) => b.people.find((p) => p.worker.id === id);
  check('Checked in, not out: on site', st(1).state === 'on-site' && st(1).onSiteMinutes === 130);
  check('Checked in late: on site, marked Late in', st(2).state === 'on-site' && st(2).lateIn);
  check('Checked out: left, marked Early out', st(3).state === 'left' && st(3).earlyOut);
  check('No badge 2 hours into the shift: late, minutes counted', st(4).state === 'late' && st(4).minutesLate === 120);
  check('Badged minutes ago, before the record caught up: on site from that badge', st(5).state === 'on-site' && st(5).checkIn === at('2026-09-21', '09:58'));
  check('Someone covering for the crew is shown as a cover', st(6).cover && st(6).state === 'on-site');
  check('Counts', b.counts.expected === 5 && b.counts.onSite === 4 && b.counts.left === 1 && b.counts.late === 1 && b.counts.covers === 1);

  const early = buildBoard({ instance, shift: DAY, people: [{ worker: w(4), expected: true }], rowFor: () => null, badgesFor: () => [], now: at('2026-09-21', '08:20') });
  check('No badge but still inside the grace period: due, not late', early.people[0].state === 'due');
  const after = buildBoard({ instance, shift: DAY, people: [{ worker: w(4), expected: true }], rowFor: () => null, badgesFor: () => [], now: at('2026-09-21', '17:30') });
  check('No badge by the end of the shift: absent', after.people[0].state === 'absent');
}

console.log('\nChecks:');
let allPassed = true;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) allPassed = false;
}
process.exit(allPassed ? 0 : 1);
