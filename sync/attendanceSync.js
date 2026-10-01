const prisma = require('../prismaClient');
const { fetchPunchLogsForDate, fetchGroupUsers } = require('./biostarClient');
const { syncWorkerStatuses } = require('../services/accountLink');

const CASUALS_GROUP_NAME = process.env.BIOSTAR_CASUALS_GROUP_NAME || 'CASUALS';

// How far back every sync run re-checks, regardless of what's already
// synced. A rolling window (rather than "latest known date forward") means
// a punch stamped with an earlier date than our last-seen record — plausible
// for overnight/night-shift punches arriving out of order — still gets
// picked up on the next run instead of being permanently missed.
const LOOKBACK_DAYS = parseInt(process.env.SYNC_LOOKBACK_DAYS, 10) || 14;

// Reject punches timestamped further in the future than this — a symptom of
// a device with a skewed clock, not a real punch.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

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

  // Workers who left the group become inactive, and their portal accounts
  // are disabled.
  const statuses = await syncWorkerStatuses(groupUsers.map((u) => u.userId));
  if (statuses.deactivated) {
    console.log(`Deactivated ${statuses.deactivated} worker(s) no longer in the group; disabled ${statuses.accountsDisabled} portal account(s).`);
  }
  return groupUsers.length;
}

function mapPunchType(type) {
  if (type === 'PUNCH_TYPE_CHECK_IN') return 'check-in';
  if (type === 'PUNCH_TYPE_CHECK_OUT') return 'check-out';
  return 'other'; // BREAK_START / BREAK_END / MEAL_START / MEAL_END / NONE
}

function getSyncStartDate() {
  const fallback = new Date();
  fallback.setDate(fallback.getDate() - LOOKBACK_DAYS);
  return toDateStr(fallback);
}

// Returns { created, skipped, changedWorkerIds } — changedWorkerIds are the
// workers with a punch that is new or whose time changed, so the live sync
// only recomputes those.
async function syncOneDate(dateStr) {
  const records = await fetchPunchLogsForDate(dateStr);

  let created = 0;
  let skipped = 0;
  const changedWorkerIds = new Set();
  const punchIds = records.map((r) => r.original_log?.id).filter(Boolean).map(String);
  const known = new Map(
    (punchIds.length
      ? await prisma.attendanceLog.findMany({ where: { biostarEventId: { in: punchIds } }, select: { biostarEventId: true, timestamp: true } })
      : []
    ).map((p) => [p.biostarEventId, new Date(p.timestamp).getTime()])
  );

  // All of the day's workers in one query, up front — a per-record lookup
  // inside the transaction made it run past Prisma's 5s interactive
  // transaction timeout on busy days (P2028 "Transaction not found").
  const bioUserIds = [...new Set(
    records.map((r) => r.user_id || r.original_log?.user?.user_id).filter(Boolean).map(String)
  )];
  const workersByBioId = new Map(
    (bioUserIds.length
      ? await prisma.casualWorker.findMany({ where: { biostarUserId: { in: bioUserIds } } })
      : []
    ).map((w) => [w.biostarUserId, w])
  );

  const upserts = [];
  for (const record of records) {
    // Field shape confirmed against the live server (see
    // test/mockSyncTest.js): top-level user_id, plus an original_log
    // wrapper carrying the punch id and a duplicate of the user_id.
    const bioUserId = record.user_id || record.original_log?.user?.user_id;
    const punchId = record.original_log?.id;

    if (!bioUserId || !punchId) {
      skipped++;
      continue; // malformed record — skip rather than crash the whole sync
    }

    const worker = workersByBioId.get(String(bioUserId));

    if (!worker) {
      skipped++;
      continue; // worker not yet provisioned in our table — flag for review
    }

    if (worker.status !== 'active') {
      skipped++;
      continue; // worker marked inactive — don't sync new punches for them
    }

    const timestamp = new Date(record.device_datetime);
    if (Number.isNaN(timestamp.getTime())) {
      skipped++;
      continue; // unparseable timestamp
    }
    if (timestamp.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
      console.warn(`Skipping punch ${punchId} — timestamp ${timestamp.toISOString()} is in the future (device clock skew?).`);
      skipped++;
      continue;
    }

    const eventType = mapPunchType(record.type);
    if (known.get(String(punchId)) !== timestamp.getTime()) changedWorkerIds.add(worker.id);

    // update (not just create) so a correction BioStar makes to an
    // already-synced punch — this endpoint is literally named
    // punch_logs/modified — actually gets pulled in on the next sync,
    // rather than being silently ignored forever.
    upserts.push(prisma.attendanceLog.upsert({
      where: { biostarEventId: String(punchId) },
      update: {
        eventType,
        timestamp,
        rawPayload: record,
        syncedAt: new Date()
      },
      create: {
        casualWorkerId: worker.id,
        biostarEventId: String(punchId),
        eventType,
        timestamp,
        rawPayload: record
      }
    }));
    created++;
  }

  // Written as one batch transaction so a crash partway through a day's
  // records doesn't leave that day half-synced. Re-running is still safe
  // either way (every write is an upsert keyed on biostarEventId), but this
  // avoids needing a re-run to reach consistency.
  if (upserts.length) await prisma.$transaction(upserts);

  return { created, skipped, changedWorkerIds: [...changedWorkerIds] };
}

// The live sync: today's and yesterday's punches only (yesterday so a Night
// shift's morning badges and anything BioStar corrects overnight are
// caught). Dates here are UTC, as for the full sync; EAT midnight to 03:00
// falls on the previous UTC date, which is why yesterday is always included.
async function syncRecent() {
  const today = toDateStr(new Date());
  const yesterday = toDateStr(new Date(Date.now() - 24 * 3600 * 1000));
  const changed = new Set();
  let created = 0;
  for (const dateStr of [yesterday, today]) {
    const r = await syncOneDate(dateStr);
    created += r.created;
    r.changedWorkerIds.forEach((id) => changed.add(id));
  }
  return { created, changedWorkerIds: [...changed] };
}

async function syncAttendance() {
  await provisionCasualWorkers();

  const startDateStr = getSyncStartDate();
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

  console.log(`Sync complete: ${totalCreated} punches processed/updated, ${totalSkipped} skipped (unrecognized worker, inactive worker, or malformed record).`);
}

module.exports = { syncAttendance, syncRecent };
