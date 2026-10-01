const { computeSummaries } = require('../sync/computeDailySummaries');
const { eatDateStr, addDaysStr } = require('../sync/shiftEngine');

function todayEat() {
  return eatDateStr(Date.now());
}

// Recomputes the given workers' summaries from fromDate up to today (or
// toDate, if later — e.g. an exception planned for next week), so schedule
// and exception changes show up immediately instead of at the next hourly
// run.
async function recomputeWorkers(workerIds, fromDate, toDate) {
  if (!workerIds.length) return null;
  const today = todayEat();
  const to = toDate && toDate > today ? toDate : today;
  const from = fromDate < to ? fromDate : to;
  return computeSummaries(from, to, { workerIds });
}

// Recomputes everyone over the regular sync lookback window.
async function recomputeLookback() {
  const lookback = parseInt(process.env.SYNC_LOOKBACK_DAYS, 10) || 14;
  const today = todayEat();
  return computeSummaries(addDaysStr(today, -lookback), today);
}

module.exports = { recomputeWorkers, recomputeLookback, todayEat };
