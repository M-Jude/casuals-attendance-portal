// Makes each worker's FIRST schedule (crew or permanent Day/Night, confirmed
// by HR or bootstrapped) cover their whole punch history: if it starts after
// their first punch, it is moved back to the day before that punch (so a
// Night whose check-out was the first punch is covered too). Later schedule
// changes are left alone. Workers with no schedule are untouched — the
// nightly profiling keeps suggesting one as their punches build up.
//
//   node scripts/backdateFirstSchedules.js            # dry run
//   node scripts/backdateFirstSchedules.js --apply    # then: npm run recompute

require('dotenv').config();
const prisma = require('../prismaClient');
const { eatDateStr, addDaysStr } = require('../sync/shiftEngine');

async function main() {
  const apply = process.argv.includes('--apply');
  const [workers, firsts, crews] = await Promise.all([
    prisma.casualWorker.findMany({ include: { schedules: { orderBy: { effectiveFrom: 'asc' } } } }),
    prisma.attendanceLog.groupBy({ by: ['casualWorkerId'], _min: { timestamp: true } }),
    prisma.crew.findMany()
  ]);
  const firstPunch = new Map(firsts.map((f) => [f.casualWorkerId, eatDateStr(f._min.timestamp.getTime())]));
  const crewName = new Map(crews.map((c) => [c.id, c.name]));

  const moves = [];
  for (const w of workers) {
    const first = w.schedules[0];
    const punched = firstPunch.get(w.id);
    if (!first || !punched || first.type === 'unassigned') continue;
    const target = addDaysStr(punched, -1);
    const current = first.effectiveFrom.toISOString().slice(0, 10);
    if (current > target) moves.push({ w, first, current, target });
  }

  for (const { w, first, current, target } of moves) {
    const label = first.type === 'crew' ? crewName.get(first.crewId) : first.type === 'fixed-day' ? 'Permanent Day' : 'Permanent Night';
    console.log(`${w.biostarUserId.padEnd(10)} ${w.name.padEnd(28)} ${label.padEnd(15)} ${current} -> ${target}`);
  }
  console.log(`\n${moves.length} first schedule(s) ${apply ? 'moved back' : 'would be moved back'}.`);
  if (!apply) {
    console.log('Dry run — nothing changed. Add --apply, then run `npm run recompute`.');
    return;
  }
  for (const { first, target } of moves) {
    await prisma.workerSchedule.update({ where: { id: first.id }, data: { effectiveFrom: new Date(`${target}T00:00:00.000Z`) } });
  }
  console.log('Done. Now run `npm run recompute` so past shifts are judged against these schedules.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
