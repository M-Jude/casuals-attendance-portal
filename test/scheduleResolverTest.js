// Unit tests for sync/scheduleResolver.js and the approval routing in
// sync/computeDailySummaries.js — pure, no database.
//   node test/scheduleResolverTest.js

const { buildResolver, scheduleKey } = require('../sync/scheduleResolver');
const { approvalCrewFor } = require('../sync/computeDailySummaries');

const d = (s) => new Date(`${s}T00:00:00.000Z`);
const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

// Crew 1: DDNNOO starting 09-01; changes cycle on 09-20 (shifted two days).
// Crew 2: DDNNOO starting 09-03 (on Night when crew 1 is on Day).
const rotations = [
  { crewId: 1, effectiveFrom: d('2026-08-01'), anchorDate: d('2026-09-01'), pattern: 'DDNNOO' },
  { crewId: 1, effectiveFrom: d('2026-09-20'), anchorDate: d('2026-09-21'), pattern: 'DDNNOO' },
  { crewId: 2, effectiveFrom: d('2026-08-01'), anchorDate: d('2026-09-03'), pattern: 'DDNNOO' }
];
const schedules = [
  { casualWorkerId: 10, effectiveFrom: d('2026-08-01'), type: 'crew', crewId: 1 },
  { casualWorkerId: 11, effectiveFrom: d('2026-08-01'), type: 'crew', crewId: 1 },
  { casualWorkerId: 11, effectiveFrom: d('2026-09-15'), type: 'fixed-day', crewId: null }, // moved to permanent Day
  { casualWorkerId: 12, effectiveFrom: d('2026-08-01'), type: 'crew', crewId: 2 }
];
const exceptions = [{ casualWorkerId: 10, date: d('2026-09-05'), shifts: 'Day,Night' }];
const workers = [{ id: 10, status: 'active' }, { id: 11, status: 'active' }, { id: 12, status: 'active' }, { id: 13, status: 'inactive' }];
const r = buildResolver({ schedules, rotations, exceptions, workers });

check('Crew rotation: day 1 of the cycle is Day', r.expectedFor(10)('2026-09-01').shifts[0] === 'Day');
check('Crew rotation: day 3 is Night', r.expectedFor(10)('2026-09-03').shifts[0] === 'Night');
check('Crew rotation: day 5 is off, day 7 starts the next cycle', r.crewShiftsOn(1, '2026-09-05').length === 0 && r.crewShiftsOn(1, '2026-09-07')[0] === 'Day');
check('Cycle change applies from its effective date (09-20 off under the new cycle, 09-19 Day under the old)', r.crewShiftsOn(1, '2026-09-20').length === 0 && r.crewShiftsOn(1, '2026-09-19')[0] === 'Day' && r.crewShiftsOn(1, '2026-09-21')[0] === 'Day');
check('Before the cycle change the old cycle still applies', r.crewShiftsOn(1, '2026-09-13')[0] === 'Day');
check('Exception overrides the schedule (double shift)', r.expectedFor(10)('2026-09-05').shifts.join() === 'Day,Night' && r.expectedFor(10)('2026-09-05').source === 'exception');
check('Schedule change is effective-dated: crew before, permanent Day after', r.expectedFor(11)('2026-09-10').source === 'schedule' && r.scheduleOn(11, '2026-09-10').type === 'crew' && r.expectedFor(11)('2026-09-16').shifts[0] === 'Day');
check('No schedule before the first effective date', r.expectedFor(12)('2026-07-01').shifts.length === 0);
check('Inactive workers are expected on nothing', r.expectedFor(13)('2026-09-10').shifts.length === 0);
check('scheduleKey: crew / fixed / none', scheduleKey(r.scheduleOn(10, '2026-09-10')) === 'crew:1' && scheduleKey(r.scheduleOn(11, '2026-09-16')) === 'fixed-day' && scheduleKey(null) === 'unassigned');

// Profiled suggestion for workers without a confirmed schedule.
const withProfiles = buildResolver({
  schedules: [...schedules, { casualWorkerId: 20, effectiveFrom: d('2026-08-01'), type: 'unassigned', crewId: null }],
  rotations, exceptions, workers: [...workers, { id: 20, status: 'active' }, { id: 21, status: 'active' }],
  profiles: [
    { casualWorkerId: 20, suggestedType: 'fixed-day' },
    { casualWorkerId: 21, suggestedType: 'crew', suggestedCrewId: 2 },
    { casualWorkerId: 10, suggestedType: 'fixed-night' } // has a confirmed crew — must be ignored
  ]
});
check('Suggested: unassigned worker judged against their profiled permanent Day, marked suggested', withProfiles.expectedFor(20)('2026-09-10').shifts[0] === 'Day' && withProfiles.expectedFor(20)('2026-09-10').source === 'suggested');
check('Suggested: worker with no schedule rows follows their profiled crew', withProfiles.expectedFor(21)('2026-09-03').shifts[0] === 'Day' && withProfiles.expectedFor(21)('2026-09-03').source === 'suggested');
check('Suggested: a confirmed schedule always wins over the profile', withProfiles.expectedFor(10)('2026-09-01').shifts[0] === 'Day' && withProfiles.expectedFor(10)('2026-09-01').source === 'schedule');
check('Suggested permanent Day worker → HR monthly approval', approvalCrewFor({ resolver: withProfiles, workerId: 20, dateStr: '2026-09-03', shiftName: 'Day', tenantCrewIds: [1, 2] }) === null);

// Approval routing.
const crewIds = [1, 2];
check('Approval: crew worker on their own crew’s shift → their crew', approvalCrewFor({ resolver: r, workerId: 10, dateStr: '2026-09-01', shiftName: 'Day', tenantCrewIds: crewIds }) === 1);
check('Approval: permanent Day worker → HR (null)', approvalCrewFor({ resolver: r, workerId: 11, dateStr: '2026-09-16', shiftName: 'Day', tenantCrewIds: crewIds }) === null);
// 09-05: crew 1 is on Night-off? 09-05 is day 5 → off for crew 1; crew 2 (anchor 09-03) is on day 3 → Night.
check('Approval: crew-1 worker covering the Night on their off day → crew 2 (on Night that date)', approvalCrewFor({ resolver: r, workerId: 10, dateStr: '2026-09-05', shiftName: 'Night', tenantCrewIds: crewIds }) === 2);
check('Approval: unassigned worker on a shift one crew is rostered on → that crew', approvalCrewFor({ resolver: r, workerId: 99, dateStr: '2026-09-03', shiftName: 'Day', tenantCrewIds: crewIds }) === 2);

console.log('\nChecks:');
let allPassed = true;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) allPassed = false;
}
process.exit(allPassed ? 0 : 1);
