const prisma = require('../prismaClient');
const { fetchPunchLogsForDate, fetchGroupUsers } = require('./biostarClient');

const CASUALS_GROUP_NAME = process.env.BIOSTAR_CASUALS_GROUP_NAME || 'CASUALS';

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

// Pulls the current membership of the BioStar Casuals group and upserts it
// into CasualWorker, so syncOneDate's per-punch lookup (which only knows
// about provisioned workers) actually has someone to match against. Existing
// workers get their name refreshed; new ones get a startDate of "now" since
// BioStar's user record doesn't carry a hire date — correct manually if a
// worker's real start date matters for reporting.
async function provisionCasualWorkers() {
  const groupUsers = await fetchGroupUsers(CASUALS_GROUP_NAME);

  for (const { userId, name } of groupUsers) {
    await prisma.casualWorker.upsert({
      where: { biostarUserId: String(userId) },
      update: { name },
      create: {
        biostarUserId: String(userId),
        name,
        startDate: new Date(),
        status: 'active'
      }
    });
  }

  console.log(`Provisioned ${groupUsers.length} worker(s) from BioStar group "${CASUALS_GROUP_NAME}".`);
  return groupUsers.length;
}

function mapPunchType(type) {
  if (type === 'PUNCH_TYPE_CHECK_IN') return 'check-in';
  if (type === 'PUNCH_TYPE_CHECK_OUT') return 'check-out';
  return 'other'; // BREAK_START / BREAK_END / MEAL_START / MEAL_END / NONE
}

// Finds the earliest calendar date we still need to sync — the same date as
// the most recent AttendanceLog we have (re-checked in case of late/modified
// punches), or a short lookback window on first run. Returns a date-only
// string (YYYY-MM-DD), never a datetime, so it can't be skewed by time-of-day.
async function getSyncStartDate() {
  const latest = await prisma.attendanceLog.findFirst({
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true }
  });

  if (latest) {
    return toDateStr(latest.timestamp);
  }

  const fallback = new Date();
  fallback.setDate(fallback.getDate() - 7); // 7-day lookback on first run
  return toDateStr(fallback);
}

async function syncOneDate(dateStr) {
  const records = await fetchPunchLogsForDate(dateStr);

  let created = 0;
  let skipped = 0;

  for (const record of records) {
    const bioUserId = record.user_id || record.original_log?.user?.user_id;
    const punchId = record.original_log?.id;

    if (!bioUserId || !punchId) {
      skipped++;
      continue; // malformed record — skip rather than crash the whole sync
    }

    const worker = await prisma.casualWorker.findUnique({
      where: { biostarUserId: String(bioUserId) }
    });

    if (!worker) {
      skipped++;
      continue; // worker not yet provisioned in our table — flag for review
    }

    await prisma.attendanceLog.upsert({
      where: { biostarEventId: String(punchId) },
      update: {},
      create: {
        casualWorkerId: worker.id,
        biostarEventId: String(punchId),
        eventType: mapPunchType(record.type),
        timestamp: new Date(record.device_datetime),
        rawPayload: record
      }
    });
    created++;
  }

  return { created, skipped };
}

async function syncAttendance() {
  await provisionCasualWorkers();

  const startDateStr = await getSyncStartDate();
  const todayStr = toDateStr(new Date());

  let totalCreated = 0;
  let totalSkipped = 0;

  // Walk date-only strings from startDateStr to todayStr, inclusive.
  // Using strings (not Date objects with a time-of-day) throughout avoids
  // skew from any particular timestamp's time component.
  let cursor = startDateStr;
  while (cursor <= todayStr) {
    const { created, skipped } = await syncOneDate(cursor);
    totalCreated += created;
    totalSkipped += skipped;

    const next = new Date(`${cursor}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = toDateStr(next);
  }

  console.log(`Sync complete: ${totalCreated} punches processed, ${totalSkipped} skipped (unrecognized worker or malformed record).`);
}

module.exports = { syncAttendance };
