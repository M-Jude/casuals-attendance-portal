// Rebuilds shift summaries over a date range — use after a change to how
// shifts are worked out, so existing history picks it up (the hourly job
// only recomputes the recent lookback window).
//
//   node scripts/recompute.js                 # from the oldest punch or row on record to today
//   node scripts/recompute.js --from 2026-09-01 [--to 2026-09-30]
//
// Approved rows stay locked: a change to one is parked for re-approval,
// exactly as in the hourly run.

require('dotenv').config();
const prisma = require('../prismaClient');
const { computeSummaries } = require('../sync/computeDailySummaries');
const { eatDateStr } = require('../sync/shiftEngine');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

async function main() {
  const first = await prisma.attendanceLog.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } });
  if (!first) {
    console.log('No punches on record — nothing to recompute.');
    return;
  }
  // Default start: the earlier of the first punch and the oldest stored row,
  // so rows from before punch history began are revisited too.
  const oldest = await prisma.dailyAttendanceSummary.findFirst({ orderBy: { date: 'asc' }, select: { date: true } });
  const firstPunchDate = eatDateStr(first.timestamp.getTime());
  const oldestRow = oldest ? oldest.date.toISOString().slice(0, 10) : firstPunchDate;
  const from = arg('from') || (oldestRow < firstPunchDate ? oldestRow : firstPunchDate);
  const to = arg('to') || eatDateStr(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    console.error('Usage: node scripts/recompute.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
    process.exitCode = 1;
    return;
  }

  const count = (where) => prisma.dailyAttendanceSummary.count({ where: { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }, ...where } });
  const before = { rows: await count({}), noShows: await count({ status: 'no-show' }), held: await count({ changedAfterApproval: true }) };

  console.log(`Recomputing ${from} to ${to}…`);
  const result = await computeSummaries(from, to);

  const after = { rows: await count({}), noShows: await count({ status: 'no-show' }), held: await count({ changedAfterApproval: true }) };
  console.log(result);
  console.log(`Rows: ${before.rows} -> ${after.rows}. Absent: ${before.noShows} -> ${after.noShows}. Held for re-approval: ${before.held} -> ${after.held}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
