// services/recompute.js: what a recalculation reports back, and that a
// schedule-triggered recalculation waits for a BioStar sync in progress.
// The summary computation itself is stubbed — no database.
//   node test/recomputeTest.js

const path = require('path');

const calls = [];
let nextResult = { computed: 12, created: 1, updated: 3, deleted: 0, flaggedAfterApproval: 2 };
require.cache[path.resolve(__dirname, '../sync/computeDailySummaries.js')] = {
  loaded: true,
  exports: {
    computeSummaries: async (from, to, opts) => { calls.push({ from, to, opts, at: Date.now() }); return nextResult; }
  }
};
// liveSync pulls in the BioStar client; keep only the real lock.
require.cache[path.resolve(__dirname, '../sync/attendanceSync.js')] = { loaded: true, exports: { syncRecent: async () => {} } };
const reapprovals = [];
require.cache[path.resolve(__dirname, '../services/approveUnit.js')] = {
  loaded: true,
  exports: { reapproveRows: async (ids, opts) => { reapprovals.push({ ids, opts }); return { held: ids.length, added: opts.createdRows.length }; } }
};

const { recomputeWorkers, recomputeLookback, todayEat } = require('../services/recompute');
const { withSyncLock } = require('../services/liveSync');
const { addDaysStr } = require('../sync/shiftEngine');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

async function main() {
  const today = todayEat();
  const from = addDaysStr(today, -5);

  const r = await recomputeWorkers([7], from);
  check('recalculates the worker from the change date to today', calls[0].from === from && calls[0].to === today && calls[0].opts.workerIds[0] === 7);
  check('reports the counts and range', r.computed === 12 && r.updated === 3 && r.flaggedAfterApproval === 2 && r.from === from && r.to === today && !r.skipped);

  const future = addDaysStr(today, 3);
  await recomputeWorkers([7], addDaysStr(future, -1), addDaysStr(future, 1));
  check('an exception next week recalculates through that date', calls[1].to === addDaysStr(future, 1));

  const none = await recomputeWorkers([], from);
  check('no workers: nothing computed, zero counts', none.computed === 0 && calls.length === 2);

  nextResult = null; // Day/Night shifts not set up
  const skipped = await recomputeWorkers([7], from);
  check('shifts not set up: reported as skipped', skipped.skipped === true && skipped.computed === 0);
  nextResult = { computed: 40, created: 0, updated: 0, deleted: 0, flaggedAfterApproval: 0 };

  const lb = await recomputeLookback();
  check('shift-rule change covers the lookback window', lb.from === addDaysStr(today, -14) && lb.to === today && lb.computed === 40);

  // A sync holding the lock: the schedule recalculation waits for it.
  let syncDone = 0;
  const sync = withSyncLock(() => new Promise((resolve) => setTimeout(() => { syncDone = Date.now(); resolve(); }, 150)));
  const before = calls.length;
  await recomputeWorkers([7], from);
  await sync;
  check('waits for a sync in progress before recalculating', calls.length === before + 1 && calls[before].at >= syncDone);

  // Re-approving automatically with a schedule change.
  nextResult = { computed: 12, created: 0, updated: 3, deleted: 0, flaggedAfterApproval: 2, flaggedIds: [101, 102] };
  const held = await recomputeWorkers([7], from);
  check('without auto re-approve: changed approved shifts are held', reapprovals.length === 0 && held.flaggedAfterApproval === 2 && held.reapproved === 0);
  nextResult = { computed: 12, created: 0, updated: 3, deleted: 0, flaggedAfterApproval: 2, flaggedIds: [101, 102] };
  const auto = await recomputeWorkers([7], from, undefined, { autoApproveBy: 4 });
  check('with auto re-approve: exactly the rows this recalculation held are re-approved, as that account',
    reapprovals.length === 1 && reapprovals[0].ids.join() === '101,102' && reapprovals[0].opts.approverId === 4);
  check('…and reported as re-approved, not as needing re-approval', auto.reapproved === 2 && auto.flaggedAfterApproval === 0);
  nextResult = { computed: 12, created: 0, updated: 3, deleted: 0, flaggedAfterApproval: 0, flaggedIds: [], createdRows: [] };
  await recomputeWorkers([7], from, undefined, { autoApproveBy: 4 });
  check('with auto re-approve and nothing held or added: nothing to do', reapprovals.length === 1);
  // Night → Day: the Night rows are held (to be removed), the Day rows are new.
  const dayRow = { casualWorkerId: 7, date: from, shiftId: 1 };
  nextResult = { computed: 2, created: 1, updated: 0, deleted: 0, flaggedAfterApproval: 1, flaggedIds: [201], createdRows: [dayRow] };
  const swapped = await recomputeWorkers([7], from, undefined, { autoApproveBy: 4 });
  check('with auto re-approve: rows the change added are passed on too', reapprovals[1].opts.createdRows[0] === dayRow);
  check('…counted as approved, none left held', swapped.reapproved === 2 && swapped.flaggedAfterApproval === 0);

  let failed = 0;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
