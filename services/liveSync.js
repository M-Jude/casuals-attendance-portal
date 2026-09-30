// Near-real-time attendance: every LIVE_SYNC_MINUTES (default 2) pull today's
// and yesterday's punches from BioStar and recompute just the workers who
// have a new or changed badge, so the Live page reflects the door within a
// couple of minutes. The hourly full sync carries on as before.
//
// Syncs share one lock: the hourly run waits its turn; a live run that finds
// another sync going simply skips (the next one is minutes away).

const { syncRecent } = require('../sync/attendanceSync');
const { computeSummaries } = require('../sync/computeDailySummaries');
const { eatDateStr, addDaysStr } = require('../sync/shiftEngine');

let queue = Promise.resolve();
let busy = false;
const state = { lastLiveSyncAt: null, lastFullSyncAt: null, lastError: null };

// Runs fn once no other sync is running.
function withSyncLock(fn) {
  const run = queue.then(async () => {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  });
  queue = run.catch(() => {});
  return run;
}

async function runLiveSync() {
  if (busy) return { skipped: true };
  return withSyncLock(async () => {
    try {
      const { changedWorkerIds } = await syncRecent();
      if (changedWorkerIds.length) {
        const today = eatDateStr(Date.now());
        await computeSummaries(addDaysStr(today, -1), today, { workerIds: changedWorkerIds });
      }
      state.lastLiveSyncAt = new Date();
      state.lastError = null;
      return { changed: changedWorkerIds.length };
    } catch (err) {
      state.lastError = err.message;
      throw err;
    }
  });
}

// Marks a completed full (hourly or manual) sync — it covers today too.
function markFullSync() {
  state.lastFullSyncAt = new Date();
}

// When BioStar data was last pulled, by either kind of sync.
function lastSyncAt() {
  const times = [state.lastLiveSyncAt, state.lastFullSyncAt].filter(Boolean);
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
}

module.exports = { runLiveSync, withSyncLock, markFullSync, lastSyncAt, liveSyncState: state };
