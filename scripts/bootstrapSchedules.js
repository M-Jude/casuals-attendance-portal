// One-off setup: detects the crews from recent punches and (with --apply)
// creates them, puts each confidently-matched rotating worker on their crew,
// profiles everyone for HR's pattern review, and recomputes attendance.
//
//   node scripts/bootstrapSchedules.js            # dry run — prints the plan
//   node scripts/bootstrapSchedules.js --apply    # does it
//   options: --days 28 (history to learn from), --min-members 5
//
// Permanent-Day candidates are deliberately NOT assigned here — HR confirms
// those in Schedules → Pattern review. Safe to re-run: existing crews are
// matched by rotation, and workers who already have a schedule are left
// alone.

const prisma = require('../prismaClient');
const { addDaysStr, eatDateStr, eatToUtcMs } = require('../sync/shiftEngine');
const { profileWorker, profileWithCrews, candidateSchedules, normaliseAnchor, sameRotation } = require('../sync/patternProfiler');
const { runProfiling } = require('../sync/profilingJob');
const { computeSummaries } = require('../sync/computeDailySummaries');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APPLY = process.argv.includes('--apply');
const DAYS = parseInt(arg('days', '28'), 10);
const MIN_MEMBERS = parseInt(arg('min-members', '5'), 10);

function dateOnly(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

async function main() {
  const shifts = await prisma.shift.findMany();
  const shiftsByName = Object.fromEntries(shifts.map((s) => [s.name, s]));
  if (!shiftsByName.Day || !shiftsByName.Night) throw new Error('Run scripts/seedShifts.js first.');

  const now = Date.now();
  const toDate = addDaysStr(eatDateStr(now), -1);
  const fromDate = addDaysStr(toDate, -(DAYS - 1));
  console.log(`Learning from punches ${fromDate} .. ${toDate}${APPLY ? '' : ' (dry run — add --apply to make changes)'}\n`);

  const workers = await prisma.casualWorker.findMany({ where: { status: 'active' }, include: { schedules: true } });
  const punches = await prisma.attendanceLog.findMany({
    where: { timestamp: { gte: new Date(eatToUtcMs(addDaysStr(fromDate, -1), '00:00')), lte: new Date(eatToUtcMs(addDaysStr(toDate, 2), '12:00')) } },
    select: { id: true, casualWorkerId: true, timestamp: true }
  });
  const byWorker = new Map(workers.map((w) => [w.id, []]));
  for (const p of punches) byWorker.get(p.casualWorkerId)?.push(p);

  // Telling crews apart needs a few full cycles of punches. The regular sync
  // only keeps SYNC_LOOKBACK_DAYS (14) — backfill first if history is short.
  const punchDates = [...new Set(punches.map((p) => eatDateStr(p.timestamp.getTime())))].sort();
  const daysWithPunches = punchDates.length;
  // Schedules start where the punch history does — starting them earlier
  // would mark every scheduled shift before it a no-show.
  const scheduleFrom = punchDates.find((d) => d >= fromDate) || fromDate;
  if (daysWithPunches < Math.min(21, DAYS)) {
    console.warn(`Only ${daysWithPunches} day(s) in this window have punches — too little to detect crews reliably.`);
    console.warn(`Backfill first:  SYNC_LOOKBACK_DAYS=${DAYS + 7} npm run sync   (then re-run this script)\n`);
  }

  const groups = new Map();
  const fixedDay = [];
  const fixedNight = [];
  const unclear = [];
  for (const w of workers) {
    const { suggestion } = profileWorker({ punches: byWorker.get(w.id), shiftsByName, fromDate, toDate, now });
    if (!suggestion) { unclear.push(w); continue; }
    const s = suggestion.schedule;
    if (s.type === 'fixed-day') fixedDay.push(w);
    else if (s.type === 'fixed-night') fixedNight.push(w);
    else {
      const key = `${s.pattern}:${normaliseAnchor(s.pattern, s.anchorDate, toDate)}`;
      if (!groups.has(key)) groups.set(key, { pattern: s.pattern, anchorDate: normaliseAnchor(s.pattern, s.anchorDate, toDate), members: [] });
      groups.get(key).members.push(w);
    }
  }

  const crewGroups = [...groups.values()].filter((g) => g.members.length >= MIN_MEMBERS).sort((a, b) => a.anchorDate.localeCompare(b.anchorDate));
  let strays = [...groups.values()].filter((g) => g.members.length < MIN_MEMBERS).flatMap((g) => g.members);

  // Second pass: now the crews are known, place everyone else by comparing
  // only against those crews' cycles (two days apart, so far easier to tell
  // apart than every possible phase) plus permanent Day/Night.
  if (crewGroups.length) {
    const crewCandidates = [
      { type: 'fixed-day' },
      { type: 'fixed-night' },
      ...crewGroups.map((g) => ({ type: 'rotation', pattern: g.pattern, anchorDate: g.anchorDate }))
    ];
    const placed = new Set(crewGroups.flatMap((g) => g.members.map((w) => w.id)));
    const fixedDayIds = new Set(fixedDay.map((w) => w.id));
    const retry = [...strays, ...unclear, ...fixedNight];
    strays = [];
    unclear.length = 0;
    fixedNight.length = 0;
    for (const w of retry) {
      if (placed.has(w.id) || fixedDayIds.has(w.id)) continue;
      const { suggestion } = profileWithCrews({
        punches: byWorker.get(w.id), shiftsByName, fromDate, toDate, now, crewCandidates, allCandidates: candidateSchedules(fromDate)
      });
      const s = suggestion?.schedule;
      if (!s) unclear.push(w);
      else if (s.type === 'fixed-day') fixedDay.push(w);
      else if (s.type === 'fixed-night') fixedNight.push(w);
      else {
        const group = crewGroups.find((g) => sameRotation(g, s, toDate));
        if (group) group.members.push(w);
        else strays.push(w); // fits a rotation no detected crew is on
      }
    }
  }

  // Match detected groups to existing crews (re-runs), naming new ones
  // Crew A, Crew B, ... — rename them in the portal once the real names
  // are known.
  const existingCrews = await prisma.crew.findMany({ include: { rotations: true } });
  const usedNames = new Set(existingCrews.map((c) => c.name));
  let letter = 0;
  const nextName = () => {
    while (usedNames.has(`Crew ${String.fromCharCode(65 + letter)}`)) letter++;
    const name = `Crew ${String.fromCharCode(65 + letter)}`;
    usedNames.add(name);
    return name;
  };

  for (const g of crewGroups) {
    const match = existingCrews.find((c) => c.rotations.some((r) => sameRotation({ pattern: r.pattern, anchorDate: r.anchorDate.toISOString().slice(0, 10) }, g, toDate)));
    g.crew = match || null;
    g.name = match ? match.name : nextName();
  }

  for (const g of crewGroups) {
    console.log(`${g.name}: ${g.pattern} starting ${g.anchorDate} — ${g.members.length} workers${g.crew ? ' (existing crew)' : ' (new)'}`);
  }
  console.log(`\nLook like Permanent Day (left for HR to confirm): ${fixedDay.length}`);
  fixedDay.forEach((w) => console.log(`  ${w.biostarUserId} ${w.name}`));
  console.log(`Look like Permanent Night (left for HR to confirm): ${fixedNight.length}`);
  console.log(`Rotating, but not with enough others to form a crew: ${strays.length}`);
  console.log(`Not enough punches to tell yet: ${unclear.length}`);

  if (!APPLY) {
    await prisma.$disconnect();
    return;
  }

  let assigned = 0;
  for (const g of crewGroups) {
    if (!g.crew) {
      g.crew = await prisma.crew.create({
        data: {
          name: g.name,
          subcontractorName: g.members[0].subcontractorName,
          rotations: { create: { pattern: g.pattern, anchorDate: dateOnly(g.anchorDate), effectiveFrom: dateOnly(scheduleFrom), note: 'Detected by bootstrapSchedules' } }
        }
      });
    }
    for (const w of g.members) {
      if (w.schedules.length) continue; // already has a schedule — don't override a human decision
      await prisma.workerSchedule.create({
        data: { casualWorkerId: w.id, effectiveFrom: dateOnly(scheduleFrom), type: 'crew', crewId: g.crew.id, note: 'Detected by bootstrapSchedules' }
      });
      assigned++;
    }
  }
  console.log(`\nAssigned ${assigned} worker(s) to crews.`);

  // Fill in everyone's pattern profile for HR's review (without emailing —
  // this is setup, not news), then rebuild attendance on the new schedules.
  await runProfiling({ now, days: DAYS, notify: false });
  await computeSummaries(scheduleFrom, eatDateStr(now));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
