// Preview (or send now) the Director's weekly attendance digest.
//
//   node scripts/weeklyDigest.js          # print it, send nothing
//   node scripts/weeklyDigest.js --send   # send it to every active Director now
//
// It also goes out automatically every Monday at 07:00 (EAT).

const prisma = require('../prismaClient');
const { runWeeklyDigest } = require('../sync/weeklyDigest');

async function main() {
  const send = process.argv.includes('--send');
  const results = await runWeeklyDigest({ send });
  if (!results.length) console.log('No active Director accounts — nothing to send.');
  for (const r of results) {
    console.log(`\n=== ${r.tenant} -> ${r.recipients.join(', ')} ===\n${r.title}\n\n${r.body}`);
  }
  if (!send && results.length) console.log('\nPreview only — add --send to send it.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
