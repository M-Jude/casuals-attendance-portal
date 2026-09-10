const path = require('path');
const Module = require('module');

const prismaPath = path.join(__dirname, '..', 'prismaClient.js');

const DAY_SHIFT = { id: 1, name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 15 };
const NIGHT_SHIFT = { id: 2, name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 15 };

let fakeAttendanceLogs = [];
let fakeShiftAssignments = [];
const fakeSummaries = [];

const fakePrisma = {
  shift: { findMany: async () => [DAY_SHIFT, NIGHT_SHIFT] },
  attendanceLog: {
    findMany: async ({ where }) =>
      fakeAttendanceLogs
        .filter((p) =>
          (where.casualWorkerId === undefined || p.casualWorkerId === where.casualWorkerId) &&
          p.timestamp >= where.timestamp.gte && p.timestamp <= where.timestamp.lte
        )
        .sort((a, b) => a.timestamp - b.timestamp)
  },
  shiftAssignment: {
    findMany: async ({ where }) =>
      fakeShiftAssignments.filter((a) => a.date >= where.date.gte && a.date <= where.date.lte)
  },
  dailyAttendanceSummary: {
    upsert: async ({ where, create }) => {
      const idx = fakeSummaries.findIndex(
        (s) => s.casualWorkerId === where.casualWorkerId_date.casualWorkerId &&
               s.date.getTime() === where.casualWorkerId_date.date.getTime()
      );
      if (idx !== -1) { fakeSummaries[idx] = { ...fakeSummaries[idx], ...create }; return fakeSummaries[idx]; }
      fakeSummaries.push(create);
      return create;
    }
  }
};

function injectFakeModule(resolvedPath, exportsObj) {
  const fakeModule = new Module(resolvedPath, null);
  fakeModule.filename = resolvedPath;
  fakeModule.loaded = true;
  fakeModule.exports = exportsObj;
  Module._cache[resolvedPath] = fakeModule;
}
injectFakeModule(prismaPath, fakePrisma);

const { computeSummaries, classifyPunch, circularMinuteDistance, getPunchDetailForSummary, assignEffectiveTypes, computeStatus } = require('../sync/computeDailySummaries');

function utc(dateStr, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);
}

const D = '2026-09-10';
const D1 = '2026-09-11'; // D+1

function summaryFor(workerId, dateStr) {
  return fakeSummaries.find(
    (s) => s.casualWorkerId === workerId && s.date.toISOString().slice(0, 10) === dateStr
  );
}

async function run() {
  const checks = [];

  // --- Unit tests: circularMinuteDistance ---
  checks.push(['circular distance handles midnight wraparound', circularMinuteDistance(1430, 10) === 20]);
  checks.push(['circular distance for same time is 0', circularMinuteDistance(500, 500) === 0]);

  // --- Unit tests: classifyPunch ---
  const dayCheckIn = { eventType: 'check-in', timestamp: utc(D, '05:10') };  // 08:10 EAT — near Day start
  const c1 = classifyPunch(dayCheckIn, [DAY_SHIFT, NIGHT_SHIFT]);
  checks.push(['check-in at 08:10 EAT classified as Day', c1.shift.name === 'Day']);
  checks.push(['Day check-in anchors to its own calendar date', c1.anchorDateStr === D]);

  const nightCheckOut = { eventType: 'check-out', timestamp: utc(D1, '05:05') }; // 08:05 EAT — near Night end
  const c2 = classifyPunch(nightCheckOut, [DAY_SHIFT, NIGHT_SHIFT]);
  checks.push(['check-out at 08:05 EAT classified as Night', c2.shift.name === 'Night']);
  checks.push(['Night check-out anchors to the PREVIOUS day (when the shift started)', c2.anchorDateStr === D]);

  const dayCheckOut = { eventType: 'check-out', timestamp: utc(D, '14:05') }; // 17:05 EAT — near Day end
  const c3 = classifyPunch(dayCheckOut, [DAY_SHIFT, NIGHT_SHIFT]);
  checks.push(['check-out at 17:05 EAT classified as Day', c3.shift.name === 'Day']);
  checks.push(['Day check-out anchors to its own calendar date (not overnight)', c3.anchorDateStr === D]);

  // --- Full pipeline: three ordinary cases + the critical zero-rest edge case ---
  fakeAttendanceLogs = [
    // Worker 1: ordinary Day shift, on time
    { casualWorkerId: 1, eventType: 'check-in', timestamp: utc(D, '04:55') },  // 07:55 EAT
    { casualWorkerId: 1, eventType: 'check-out', timestamp: utc(D, '14:10') }, // 17:10 EAT

    // Worker 2: ordinary Night shift, crosses midnight
    { casualWorkerId: 2, eventType: 'check-in', timestamp: utc(D, '14:05') },   // 17:05 EAT
    { casualWorkerId: 2, eventType: 'check-out', timestamp: utc(D1, '04:50') }, // 07:50 EAT next morning

    // Worker 3: THE EDGE CASE — Night ending ~08:00 on D+1, immediately
    // followed by Day starting ~08:00 on D+1 for the SAME worker, zero rest.
    { casualWorkerId: 3, eventType: 'check-in', timestamp: utc(D, '14:00') },    // 17:00 EAT D — starts Night(D)
    { casualWorkerId: 3, eventType: 'check-out', timestamp: utc(D1, '04:55') }, // 07:55 EAT D+1 — ends Night(D)
    { casualWorkerId: 3, eventType: 'check-in', timestamp: utc(D1, '05:05') },  // 08:05 EAT D+1 — starts Day(D+1)
    { casualWorkerId: 3, eventType: 'check-out', timestamp: utc(D1, '14:00') }  // 17:00 EAT D+1 — ends Day(D+1)
  ];

  // --- Multiple-punch anomaly: worker 4 badges in twice (device noise) ---
  fakeAttendanceLogs.push(
    { casualWorkerId: 4, eventType: 'check-in', timestamp: utc(D, '04:50') },  // 07:50 EAT — real arrival
    { casualWorkerId: 4, eventType: 'check-in', timestamp: utc(D, '04:52') },  // 07:52 EAT — duplicate badge 2 min later
    { casualWorkerId: 4, eventType: 'check-out', timestamp: utc(D, '14:00') }  // 17:00 EAT
  );

  // --- Real-world case for this deployment: worker 5's device reports every
  // punch as 'other' (PUNCH_TYPE_NONE) — no explicit check-in/check-out.
  // Ordinary Day shift; alternation must still infer check-in then
  // check-out correctly from sequence alone. ---
  fakeAttendanceLogs.push(
    { casualWorkerId: 5, eventType: 'other', timestamp: utc(D, '04:58') }, // 07:58 EAT — untyped
    { casualWorkerId: 5, eventType: 'other', timestamp: utc(D, '14:03') }  // 17:03 EAT — untyped
  );

  // --- Worker 6: untyped punches across a Night shift (crosses midnight) —
  // alternation must combine correctly with the overnight anchor-date logic. ---
  fakeAttendanceLogs.push(
    { casualWorkerId: 6, eventType: 'other', timestamp: utc(D, '14:02') },   // 17:02 EAT D — untyped
    { casualWorkerId: 6, eventType: 'other', timestamp: utc(D1, '04:58') }  // 07:58 EAT D+1 — untyped
  );

  // --- ROSTER-DRIVEN CASES ---
  function assignment(casualWorkerId, dateStr, shift) {
    return { casualWorkerId, date: new Date(`${dateStr}T00:00:00.000Z`), shiftId: shift.id };
  }

  fakeShiftAssignments = [
    assignment(7, D, DAY_SHIFT),   // worker 7: rostered Day, arrives well early
    assignment(8, D, DAY_SHIFT),   // worker 8: rostered Day, leaves well early
    assignment(9, D, DAY_SHIFT),   // worker 9: rostered Day, never punches — no-show
    assignment(10, D, NIGHT_SHIFT) // worker 10: rostered Night, but actually punches a Day pattern — mismatch
  ];

  fakeAttendanceLogs.push(
    // Worker 7: check-in 3h before Day start (well beyond the 15min grace) — 'early'
    { casualWorkerId: 7, eventType: 'check-in', timestamp: utc(D, '02:00') },  // 05:00 EAT
    { casualWorkerId: 7, eventType: 'check-out', timestamp: utc(D, '14:05') }, // 17:05 EAT — on-time end

    // Worker 8: on-time check-in, but checks out 2h before Day end — earlyCheckOut
    { casualWorkerId: 8, eventType: 'check-in', timestamp: utc(D, '04:58') },  // 07:58 EAT
    { casualWorkerId: 8, eventType: 'check-out', timestamp: utc(D, '12:00') }, // 15:00 EAT

    // Worker 9: no punches at all — covered only by fakeShiftAssignments above

    // Worker 10: rostered Night(D), but punches look exactly like an ordinary Day shift
    { casualWorkerId: 10, eventType: 'check-in', timestamp: utc(D, '04:58') },  // 07:58 EAT
    { casualWorkerId: 10, eventType: 'check-out', timestamp: utc(D, '14:03') }  // 17:03 EAT
  );

  await computeSummaries(D, D1);

  console.log('\nSummaries:');
  fakeSummaries.forEach((s) => {
    console.log(`  worker#${s.casualWorkerId}  date=${s.date.toISOString().slice(0, 10)}  shift=${s.shiftId}  status=${s.status.padEnd(11)}  hours=${s.hoursWorked ?? '-'}`);
  });

  const w1 = summaryFor(1, D);
  checks.push(['worker 1 (Day, on-time) status correct', w1?.status === 'on-time']);
  checks.push(['worker 1 hours ~9.25h', Math.abs(w1?.hoursWorked - 9.25) < 0.01]);

  const w2 = summaryFor(2, D);
  checks.push(['worker 2 (Night, crosses midnight) anchored to D not D+1', !!w2]);
  checks.push(['worker 2 status correct', w2?.status === 'on-time']);
  checks.push(['worker 2 hours ~14.75h', Math.abs(w2?.hoursWorked - 14.75) < 0.01]);

  const w3Night = summaryFor(3, D);
  const w3Day = summaryFor(3, D1);
  checks.push(['EDGE CASE: worker 3 gets TWO separate summary rows, not one merged/corrupted row', !!w3Night && !!w3Day]);
  checks.push(['EDGE CASE: Night(D) leg has correct shift', w3Night?.shiftId === NIGHT_SHIFT.id]);
  checks.push(['EDGE CASE: Day(D+1) leg has correct shift', w3Day?.shiftId === DAY_SHIFT.id]);
  checks.push(['EDGE CASE: Night(D) leg did NOT pick up the Day check-in as its check-out', Math.abs(w3Night?.hoursWorked - 14.9167) < 0.01]);
  checks.push(['EDGE CASE: Day(D+1) leg did NOT pick up the Night check-out as its check-in', Math.abs(w3Day?.hoursWorked - 8.9167) < 0.01]);
  checks.push(['EDGE CASE: both legs on-time (no false "late" from the boundary)', w3Night?.status === 'on-time' && w3Day?.status === 'on-time']);

  const w4 = summaryFor(4, D);
  checks.push(['worker 4 (duplicate check-in) still uses earliest check-in (FILO)', w4?.checkIn?.getTime() === utc(D, '04:50').getTime()]);
  checks.push(['worker 4 flagged hasMultiplePunches', w4?.hasMultiplePunches === true]);
  checks.push(['worker 1 (single punches) NOT flagged hasMultiplePunches', w1?.hasMultiplePunches === false]);

  // --- Untyped punches (this deployment's real-world case): worker 5's Day
  // shift must still get a summary row, with the first untyped punch
  // inferred as check-in and the second as check-out. ---
  const w5 = summaryFor(5, D);
  checks.push(['UNTYPED PUNCHES: worker 5 (all "other" eventType) still gets a summary row', !!w5]);
  checks.push(['UNTYPED PUNCHES: worker 5 classified as Day shift', w5?.shiftId === DAY_SHIFT.id]);
  checks.push(['UNTYPED PUNCHES: first untyped punch inferred as check-in', w5?.checkIn?.getTime() === utc(D, '04:58').getTime()]);
  checks.push(['UNTYPED PUNCHES: second untyped punch inferred as check-out', w5?.checkOut?.getTime() === utc(D, '14:03').getTime()]);
  checks.push(['UNTYPED PUNCHES: worker 5 status correct (on-time)', w5?.status === 'on-time']);

  // --- Untyped punches across an overnight shift ---
  const w6 = summaryFor(6, D);
  checks.push(['UNTYPED PUNCHES + OVERNIGHT: worker 6 anchored to D (Night shift start date)', !!w6]);
  checks.push(['UNTYPED PUNCHES + OVERNIGHT: worker 6 classified as Night shift', w6?.shiftId === NIGHT_SHIFT.id]);
  checks.push(['UNTYPED PUNCHES + OVERNIGHT: check-in/check-out correctly ordered despite crossing midnight', w6?.checkIn?.getTime() === utc(D, '14:02').getTime() && w6?.checkOut?.getTime() === utc(D1, '04:58').getTime()]);

  // --- Direct unit test of assignEffectiveTypes: mixed typed/untyped
  // punches — explicit types must be respected, only 'other' inferred, and
  // alternation state must carry correctly across the mix. ---
  const mixed = [
    { eventType: 'other', timestamp: utc(D, '05:00') },      // no type — expect inferred check-in
    { eventType: 'other', timestamp: utc(D, '14:00') },      // no type — expect inferred check-out
    { eventType: 'check-in', timestamp: utc(D1, '05:00') },  // explicit — must stay check-in regardless of alternation
    { eventType: 'other', timestamp: utc(D1, '14:00') }      // no type, follows an explicit check-in — expect inferred check-out
  ];
  const mixedResult = assignEffectiveTypes(mixed);
  checks.push(['assignEffectiveTypes: untyped #1 inferred as check-in (window start default)', mixedResult[0].effectiveType === 'check-in']);
  checks.push(['assignEffectiveTypes: untyped #2 inferred as check-out (alternates)', mixedResult[1].effectiveType === 'check-out']);
  checks.push(['assignEffectiveTypes: explicit check-in is respected as-is', mixedResult[2].effectiveType === 'check-in']);
  checks.push(['assignEffectiveTypes: untyped #4 inferred as check-out (follows explicit check-in)', mixedResult[3].effectiveType === 'check-out']);

  // --- getPunchDetailForSummary: worker 4's duplicate check-in ---
  const w4Punches = await getPunchDetailForSummary(4, DAY_SHIFT.id, D);
  const w4RealCheckIn = w4Punches.find((p) => p.timestamp.getTime() === utc(D, '04:50').getTime());
  const w4DupeCheckIn = w4Punches.find((p) => p.timestamp.getTime() === utc(D, '04:52').getTime());
  checks.push(['punch history returns all 3 of worker 4\'s punches', w4Punches.length === 3]);
  checks.push(['the real (earliest) check-in is flagged usedAsCheckIn', w4RealCheckIn?.usedAsCheckIn === true]);
  checks.push(['the duplicate check-in is NOT flagged usedAsCheckIn', w4DupeCheckIn?.usedAsCheckIn === false]);

  // --- getPunchDetailForSummary: worker 3's edge case — each leg's punch
  // history should be isolated from the other, not bleed across the boundary ---
  const w3NightPunches = await getPunchDetailForSummary(3, NIGHT_SHIFT.id, D);
  const w3DayPunches = await getPunchDetailForSummary(3, DAY_SHIFT.id, D1);
  checks.push(['worker 3 Night-leg punch history has exactly 2 punches (its own check-in/out only)', w3NightPunches.length === 2]);
  checks.push(['worker 3 Day-leg punch history has exactly 2 punches (its own check-in/out only)', w3DayPunches.length === 2]);
  checks.push(['worker 3 Night-leg does not include the Day check-in', !w3NightPunches.some((p) => p.timestamp.getTime() === utc(D1, '05:05').getTime())]);

  // --- ROSTER-DRIVEN: worker 7, arrives 3h early ---
  const w7 = summaryFor(7, D);
  checks.push(['ROSTER: worker 7 status is "early" (arrived well before shift start)', w7?.status === 'early']);
  checks.push(['ROSTER: worker 7 not flagged earlyCheckOut', w7?.earlyCheckOut === false]);
  checks.push(['ROSTER: worker 7 rosteredShiftId matches worked shift (no mismatch)', w7?.rosteredShiftId === DAY_SHIFT.id && w7?.shiftId === DAY_SHIFT.id]);

  // --- ROSTER-DRIVEN: worker 8, leaves 2h early ---
  const w8 = summaryFor(8, D);
  checks.push(['ROSTER: worker 8 status is "on-time" (check-in itself was on time)', w8?.status === 'on-time']);
  checks.push(['ROSTER: worker 8 flagged earlyCheckOut', w8?.earlyCheckOut === true]);

  // --- ROSTER-DRIVEN: worker 9, rostered but never punches — no-show ---
  const w9 = summaryFor(9, D);
  checks.push(['ROSTER: worker 9 gets a "no-show" row despite zero punches', w9?.status === 'no-show']);
  checks.push(['ROSTER: worker 9 no-show row has null checkIn/checkOut/hours', w9?.checkIn === null && w9?.checkOut === null && w9?.hoursWorked === null]);
  checks.push(['ROSTER: worker 9 no-show row carries the rostered shift as both shiftId and rosteredShiftId', w9?.shiftId === DAY_SHIFT.id && w9?.rosteredShiftId === DAY_SHIFT.id]);

  // --- ROSTER-DRIVEN: worker 10, rostered Night but actually punched a Day pattern ---
  const w10 = summaryFor(10, D);
  checks.push(['ROSTER MISMATCH: worker 10 is recorded under the shift punches actually match (Day)', w10?.shiftId === DAY_SHIFT.id]);
  checks.push(['ROSTER MISMATCH: worker 10 rosteredShiftId still reflects what was rostered (Night)', w10?.rosteredShiftId === NIGHT_SHIFT.id]);
  checks.push(['ROSTER MISMATCH: worker 10 is NOT also reported as a no-show (they did show up)', w10?.status !== 'no-show']);
  checks.push(['ROSTER MISMATCH: worker 10 status computed against the shift they actually worked', w10?.status === 'on-time']);

  // --- Direct unit tests: computeStatus ---
  const shiftStartUtc = utc(D, '05:00'); // 08:00 EAT
  const shiftEndUtc = utc(D, '14:00');   // 17:00 EAT
  const r1 = computeStatus({ checkIn: utc(D, '05:05'), checkOut: utc(D, '14:00'), shiftStartUtc, shiftEndUtc, graceMinutes: 15 });
  checks.push(['computeStatus: check-in 5min after start (within grace) is on-time', r1.status === 'on-time']);
  const r2 = computeStatus({ checkIn: utc(D, '05:30'), checkOut: utc(D, '14:00'), shiftStartUtc, shiftEndUtc, graceMinutes: 15 });
  checks.push(['computeStatus: check-in 30min after start (beyond grace) is late', r2.status === 'late']);
  const r3 = computeStatus({ checkIn: utc(D, '04:30'), checkOut: utc(D, '14:00'), shiftStartUtc, shiftEndUtc, graceMinutes: 15 });
  checks.push(['computeStatus: check-in 30min before start (beyond grace) is early', r3.status === 'early']);
  const r4 = computeStatus({ checkIn: utc(D, '05:00'), checkOut: utc(D, '13:30'), shiftStartUtc, shiftEndUtc, graceMinutes: 15 });
  checks.push(['computeStatus: check-out 30min before end (beyond grace) flags earlyCheckOut', r4.earlyCheckOut === true]);
  const r5 = computeStatus({ checkIn: utc(D, '05:00'), checkOut: utc(D, '13:50'), shiftStartUtc, shiftEndUtc, graceMinutes: 15 });
  checks.push(['computeStatus: check-out 10min before end (within grace) does NOT flag earlyCheckOut', r5.earlyCheckOut === false]);
  const r6 = computeStatus({ checkIn: null, checkOut: null, shiftStartUtc, shiftEndUtc, graceMinutes: 15 });
  checks.push(['computeStatus: no check-in returns null status (caller decides no-show vs skip)', r6.status === null]);

  console.log('\nChecks:');
  let allPassed = true;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) allPassed = false;
  }
  process.exit(allPassed ? 0 : 1);
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
