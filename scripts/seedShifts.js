// One-off seed for the two fixed shifts. Run once after migration:
//   node scripts/seedShifts.js
//
// Rules (editable later in the portal under Shift rules):
//   Day   08:00-17:00 — check-ins from 05:00, late after 08:30, early out before 17:00
//   Night 17:00-08:00 — check-ins from 14:00, late after 17:30, early out before 08:00,
//                       check-outs up to 12:00 next day

const prisma = require('../prismaClient');

const SHIFTS = [
  { name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '05:00', latestCheckOut: '05:00' },
  { name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '14:00', latestCheckOut: '12:00' }
];

async function main() {
  for (const { name, ...rules } of SHIFTS) {
    await prisma.shift.upsert({ where: { name }, update: rules, create: { name, ...rules } });
  }
  console.log('Shifts seeded: Day (08:00-17:00, in from 05:00), Night (17:00-08:00, in from 14:00, out by 12:00).');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
