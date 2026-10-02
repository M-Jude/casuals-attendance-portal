const { computeSummaries } = require('../sync/computeDailySummaries');
const { eatDateStr, addDaysStr } = require('../sync/shiftEngine');
const { withSyncLock } = require('./liveSync');

function todayEat() {
  return eatDateStr(Date.now());
}

// What a recalculation did, for the person who triggered it: the date range
// and how many shift records were added, changed, removed, or (already
// approved and now different) held for re-approval. `skipped` when the
// Day/Night shifts aren't set up yet, so nothing could be worked out.
function outcome(result, from, to) {
  if (!result) return { from, to, skipped: true, computed: 0, created: 0, updated: 0, deleted: 0, flaggedAfterApproval: 0 };
  return {
    from,
    to,
    computed: result.computed || 0,
    created: result.created || 0,
    updated: result.updated || 0,
    deleted: result.deleted || 0,
    flaggedAfterApproval: result.flaggedAfterApproval || 0
  };
}

// Recomputes the given workers' summaries from fromDate up to today (or
// toDate, if later — e.g. an exception planned for next week), so schedule
// and exception changes show up immediately instead of at the next hourly
// run. Waits for any BioStar sync in progress so the two never write the
// same records at once.
async function recomputeWorkers(workerIds, fromDate, toDate) {
  const today = todayEat();
  const to = toDate && toDate > today ? toDate : today;
  const from = fromDate < to ? fromDate : to;
  if (!workerIds.length) return outcome({ computed: 0 }, from, to);
  return outcome(await withSyncLock(() => computeSummaries(from, to, { workerIds })), from, to);
}

// Recomputes everyone over the regular sync lookback window. Callers hold
// the sync lock (withSyncLock) around it — the hourly and manual syncs run
// it inside theirs.
async function recomputeLookback() {
  const lookback = parseInt(process.env.SYNC_LOOKBACK_DAYS, 10) || 14;
  const today = todayEat();
  const from = addDaysStr(today, -lookback);
  return outcome(await computeSummaries(from, today), from, today);
}

module.exports = { recomputeWorkers, recomputeLookback, todayEat };
