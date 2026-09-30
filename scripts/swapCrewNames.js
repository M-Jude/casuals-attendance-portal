// Swaps the names of two crews, e.g. when the portal's "Crew B" is the
// contractor's Crew C and vice versa. Only the names change — workers,
// rotations, approvals and supervisors are linked by crew id, so they stay
// with the same physical crew.
//
//   node scripts/swapCrewNames.js "Crew B" "Crew C"            # dry run
//   node scripts/swapCrewNames.js "Crew B" "Crew C" --apply
//   (optional) --subcontractor "Subcontractor A"

require('dotenv').config();
const prisma = require('../prismaClient');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

async function describe(crew) {
  const [rotation, workers, supervisors] = await Promise.all([
    prisma.crewRotation.findFirst({ where: { crewId: crew.id }, orderBy: { effectiveFrom: 'desc' } }),
    prisma.workerSchedule.count({ where: { crewId: crew.id } }),
    prisma.portalUser.findMany({ where: { crewId: crew.id }, select: { email: true } })
  ]);
  const anchor = rotation ? `${rotation.pattern} from ${rotation.anchorDate.toISOString().slice(0, 10)}` : 'no rotation';
  return `#${crew.id} "${crew.name}" — ${anchor}, ${workers} worker schedules, supervisors: ${supervisors.map((s) => s.email).join(', ') || 'none'}`;
}

async function main() {
  const [a, b] = process.argv.slice(2).filter((x, i, all) => !x.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
  const apply = process.argv.includes('--apply');
  if (!a || !b || a === b) {
    console.error('Usage: node scripts/swapCrewNames.js "Crew B" "Crew C" [--apply] [--subcontractor NAME]');
    process.exitCode = 1;
    return;
  }

  const all = await prisma.crew.findMany({ orderBy: { id: 'asc' } });
  console.log('Crews now:');
  for (const c of all) console.log(`  ${c.subcontractorName}: ${await describe(c)}`);

  const sub = arg('subcontractor');
  const pick = (name) => all.filter((c) => c.name === name && (!sub || c.subcontractorName === sub));
  const [ca, cb] = [pick(a), pick(b)];
  if (ca.length !== 1 || cb.length !== 1 || ca[0].subcontractorName !== cb[0].subcontractorName) {
    console.error(`Need exactly one "${a}" and one "${b}" for the same subcontractor (found ${ca.length} and ${cb.length}). Use --subcontractor to choose.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nWill rename #${ca[0].id} "${a}" -> "${b}" and #${cb[0].id} "${b}" -> "${a}".`);
  if (!apply) {
    console.log('Dry run — nothing changed. Add --apply to do it.');
    return;
  }

  // Names are unique per subcontractor, so go through a temporary name.
  await prisma.$transaction([
    prisma.crew.update({ where: { id: ca[0].id }, data: { name: `__swap_${ca[0].id}` } }),
    prisma.crew.update({ where: { id: cb[0].id }, data: { name: a } }),
    prisma.crew.update({ where: { id: ca[0].id }, data: { name: b } })
  ]);

  console.log('\nCrews after:');
  for (const c of await prisma.crew.findMany({ orderBy: { id: 'asc' } })) console.log(`  ${c.subcontractorName}: ${await describe(c)}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
