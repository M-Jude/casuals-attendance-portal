// One-off seed for the two fixed shifts. Run once after migration:
//   node scripts/seedShifts.js

const prisma = require('../prismaClient');

async function main() {
  await prisma.shift.upsert({
    where: { name: 'Day' },
    update: { startTime: '08:00', endTime: '17:00', graceMinutes: 15 },
    create: { name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 15 }
  });

  await prisma.shift.upsert({
    where: { name: 'Night' },
    update: { startTime: '17:00', endTime: '08:00', graceMinutes: 15 },
    create: { name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 15 }
  });

  console.log('Shifts seeded: Day (08:00-17:00), Night (17:00-08:00).');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
