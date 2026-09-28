// Unit tests for sync/patternProfiler.js — pure, no database.
//   node test/patternProfilerTest.js

const { profileWorker, profileWithCrews, candidateSchedules, detectCycleChange, normaliseAnchor } = require('../sync/patternProfiler');
const { addDaysStr, rotationShiftsFor } = require('../sync/shiftEngine');

const DAY = { id: 1, name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '05:00', latestCheckOut: '05:00' };
const NIGHT = { id: 2, name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '14:00', latestCheckOut: '12:00' };
const shiftsByName = { Day: DAY, Night: NIGHT };

const FROM = '2026-08-29';
const TO = '2026-09-25';
const NOW = Date.parse('2026-09-27T00:00:00Z');

// Deterministic pseudo-random numbers so failures are reproducible.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

let nextId = 1;
function punchAt(dateStr, minutesFromMidnight) {
  return { id: nextId++, timestamp: new Date(Date.parse(`${dateStr}T00:00:00Z`) + minutesFromMidnight * 60000 - 3 * 3600 * 1000) };
}

// Simulates a worker following shiftsFor(date) with realistic noise:
// arrival/departure jitter, ~12% missed badges, occasional double taps.
function simulate(shiftsFor, seed, from = FROM, to = TO) {
  const r = rng(seed);
  const punches = [];
  const badge = (dateStr, minutes) => {
    if (r() < 0.12) return; // forgot to badge
    punches.push(punchAt(dateStr, minutes));
    if (r() < 0.1) punches.push(punchAt(dateStr, minutes + 0.3)); // double tap
  };
  for (let d = from; d <= to; d = addDaysStr(d, 1)) {
    for (const shift of shiftsFor(d)) {
      const jitterIn = Math.round((r() - 0.7) * 70);
      const jitterOut = Math.round(r() * 40);
      if (shift === 'Day') {
        badge(d, 8 * 60 + jitterIn);
        badge(d, 17 * 60 + jitterOut);
      } else {
        badge(d, 17 * 60 + jitterIn);
        badge(addDaysStr(d, 1), 8 * 60 + jitterOut);
      }
    }
  }
  return punches;
}

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

// --- A rotating crew worker is recognised as the rotation, with the right phase ---
{
  const anchor = '2026-09-03';
  const punches = simulate((d) => rotationShiftsFor('DDNNOO', anchor, d), 7);
  const { suggestion } = profileWorker({ punches, shiftsByName, fromDate: FROM, toDate: TO, now: NOW });
  check('Rotation worker: suggested a DDNNOO rotation', suggestion?.schedule.type === 'rotation' && suggestion.schedule.pattern === 'DDNNOO');
  check('Rotation worker: correct phase', suggestion && normaliseAnchor('DDNNOO', suggestion.schedule.anchorDate, TO) === normaliseAnchor('DDNNOO', anchor, TO));
}

// --- Several rotation workers with different seeds and phases ---
{
  let right = 0;
  for (let i = 0; i < 12; i++) {
    const anchor = addDaysStr('2026-09-01', i % 6);
    const punches = simulate((d) => rotationShiftsFor('DDNNOO', anchor, d), 100 + i);
    const { suggestion } = profileWorker({ punches, shiftsByName, fromDate: FROM, toDate: TO, now: NOW });
    if (suggestion?.schedule.type === 'rotation' && normaliseAnchor('DDNNOO', suggestion.schedule.anchorDate, TO) === normaliseAnchor('DDNNOO', anchor, TO)) right++;
  }
  check(`Rotation workers: at least 11 of 12 noisy workers identified exactly (got ${right})`, right >= 11);
}

// --- A permanent Day worker (6 days a week) is recognised as permanent Day ---
{
  const punches = simulate((d) => (new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? [] : ['Day']), 11);
  const { suggestion } = profileWorker({ punches, shiftsByName, fromDate: FROM, toDate: TO, now: NOW });
  check('Permanent Day worker: suggested permanent Day', suggestion?.schedule.type === 'fixed-day');
}

// --- Too little evidence → no suggestion rather than a guess ---
{
  const punches = [punchAt('2026-09-20', 8 * 60), punchAt('2026-09-20', 17 * 60)];
  const { suggestion } = profileWorker({ punches, shiftsByName, fromDate: FROM, toDate: TO, now: NOW });
  check('Sparse worker: no suggestion', suggestion === null);
}

// --- Placing workers on known crews: the right crew is found, and a
// worker from a crew the system doesn't know about is NOT squeezed into
// the nearest known one ---
{
  const crewA = { type: 'rotation', pattern: 'DDNNOO', anchorDate: '2026-09-01' };
  const crewB = { type: 'rotation', pattern: 'DDNNOO', anchorDate: '2026-09-05' };
  const crewCandidates = [{ type: 'fixed-day' }, { type: 'fixed-night' }, crewA, crewB];
  const allCandidates = candidateSchedules(FROM);
  const onB = simulate((d) => rotationShiftsFor('DDNNOO', '2026-09-05', d), 501);
  const b = profileWithCrews({ punches: onB, shiftsByName, fromDate: FROM, toDate: TO, now: NOW, crewCandidates, allCandidates });
  check('Known crews: a crew B worker is placed on crew B', b.suggestion && normaliseAnchor('DDNNOO', b.suggestion.schedule.anchorDate, TO) === normaliseAnchor('DDNNOO', '2026-09-05', TO));
  let squeezed = 0;
  for (let i = 0; i < 6; i++) {
    const onUnknown = simulate((d) => rotationShiftsFor('DDNNOO', '2026-09-03', d), 600 + i);
    const r = profileWithCrews({ punches: onUnknown, shiftsByName, fromDate: FROM, toDate: TO, now: NOW, crewCandidates, allCandidates });
    const a = r.suggestion && r.suggestion.schedule.type === 'rotation' ? normaliseAnchor('DDNNOO', r.suggestion.schedule.anchorDate, TO) : null;
    if (a === normaliseAnchor('DDNNOO', '2026-09-01', TO) || a === normaliseAnchor('DDNNOO', '2026-09-05', TO)) squeezed++;
  }
  check(`Unknown crew: none of 6 workers forced onto a known crew (got ${squeezed})`, squeezed === 0);
}

// --- Crew cycle change: members move two days along the cycle mid-window ---
{
  const oldAnchor = '2026-09-01';
  const newAnchor = '2026-09-17'; // two days off the old phase (old phase starts cycles on 09-19)
  const changeDate = '2026-09-17';
  const from = '2026-09-06';
  const members = [];
  for (let i = 0; i < 8; i++) {
    members.push({
      punches: simulate((d) => rotationShiftsFor('DDNNOO', d < changeDate ? oldAnchor : newAnchor, d), 300 + i, from, TO)
    });
  }
  const proposal = detectCycleChange({ current: { pattern: 'DDNNOO', anchorDate: oldAnchor }, members, shiftsByName, fromDate: from, toDate: TO, now: NOW });
  check('Cycle change: detected', !!proposal);
  check('Cycle change: new phase correct', proposal && normaliseAnchor('DDNNOO', proposal.anchorDate, TO) === normaliseAnchor('DDNNOO', newAnchor, TO));
  check(`Cycle change: effective date within a day of the real change (got ${proposal?.effectiveFrom})`, proposal && Math.abs(Date.parse(proposal.effectiveFrom) - Date.parse(changeDate)) <= 86400000);

  const steady = [];
  for (let i = 0; i < 8; i++) steady.push({ punches: simulate((d) => rotationShiftsFor('DDNNOO', oldAnchor, d), 400 + i, from, TO) });
  const none = detectCycleChange({ current: { pattern: 'DDNNOO', anchorDate: oldAnchor }, members: steady, shiftsByName, fromDate: from, toDate: TO, now: NOW });
  check('No cycle change: nothing proposed for a crew still on its rotation', none === null);

  // One worker swapping onto another crew's shifts must not move the crew.
  const oneMover = [...steady.slice(0, 7), members[0]];
  const stillNone = detectCycleChange({ current: { pattern: 'DDNNOO', anchorDate: oldAnchor }, members: oneMover, shiftsByName, fromDate: from, toDate: TO, now: NOW });
  check('One worker moving does not trigger a crew cycle change', stillNone === null);
}

console.log('\nChecks:');
let allPassed = true;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) allPassed = false;
}
process.exit(allPassed ? 0 : 1);
