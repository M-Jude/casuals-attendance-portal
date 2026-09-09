// Tests attendanceSync.js's matching/mapping logic against fabricated TA API
// responses, by injecting fake modules into Node's require cache in place of
// prismaClient and biostarClient. No real database or BioStar server involved.

const path = require('path');
const Module = require('module');

const prismaPath = path.join(__dirname, '..', 'prismaClient.js');
const biostarClientPath = path.join(__dirname, '..', 'sync', 'biostarClient.js');

// ---- Fake CasualWorker table — starts empty; provisionCasualWorkers()
// populates it from fakeGroupUsers below, the same way it would from a real
// BioStar group membership list. ----
const fakeCasualWorkers = [];
let nextWorkerId = 1;

// ---- Fake AttendanceLog table (in-memory) ----
let fakeAttendanceLogs = [];

// A minimal fake $transaction: just runs the callback against the same fake
// client (no real isolation needed for this test — we're only checking the
// resulting rows, not crash-recovery behavior).
const fakeTxClient = {
  casualWorker: {
    findUnique: async ({ where }) =>
      fakeCasualWorkers.find((w) => w.biostarUserId === where.biostarUserId) || null
  },
  attendanceLog: {
    upsert: async ({ where, update, create }) => {
      const existing = fakeAttendanceLogs.find((r) => r.biostarEventId === where.biostarEventId);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = { id: fakeAttendanceLogs.length + 1, ...create };
      fakeAttendanceLogs.push(row);
      return row;
    }
  }
};

const fakePrisma = {
  $transaction: async (fn) => fn(fakeTxClient),
  attendanceLog: {
    findFirst: async () => {
      if (fakeAttendanceLogs.length === 0) return null;
      return fakeAttendanceLogs.reduce((latest, row) =>
        row.timestamp > latest.timestamp ? row : latest
      );
    }
  },
  casualWorker: {
    findUnique: async ({ where }) =>
      fakeCasualWorkers.find((w) => w.biostarUserId === where.biostarUserId) || null,
    upsert: async ({ where, update, create }) => {
      const existing = fakeCasualWorkers.find((w) => w.biostarUserId === where.biostarUserId);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const worker = { id: nextWorkerId++, ...create };
      fakeCasualWorkers.push(worker);
      return worker;
    }
  }
};

// ---- Fake BioStar TA responses, keyed by date. Shape matches what the real
// server actually returns (confirmed against a live BioStar 2 instance):
// top-level user_id/type/device_datetime, plus an original_log wrapper with
// the punch id — NOT the modified_log/modified_by_user shape the TA Swagger
// docs implied, which silently produced zero matches against real data. ----
const today = new Date().toISOString().slice(0, 10);

// Timestamps are relative to "now" (not fixed wall-clock times) so this test
// passes regardless of what time of day it actually runs — a fixed time like
// "17:04:00Z" would itself get rejected by the future-timestamp check
// whenever the test runs before 17:04 UTC. Offsets are kept small (under 6h)
// so they stay on today's UTC calendar date except right around UTC
// midnight.
function hoursAgoISO(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}
const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour ahead — clock skew

let fakePunchLogsByDate = {
  [today]: [
    {
      user_id: '101',
      device_datetime: hoursAgoISO(5),
      type: 'PUNCH_TYPE_CHECK_IN',
      original_log: { id: 5001, user: { user_id: '101', name: 'Grace Nakato' } }
    },
    {
      user_id: '101',
      device_datetime: hoursAgoISO(1),
      type: 'PUNCH_TYPE_CHECK_OUT',
      original_log: { id: 5002, user: { user_id: '101', name: 'Grace Nakato' } }
    },
    {
      user_id: '999', // not provisioned
      device_datetime: hoursAgoISO(4),
      type: 'PUNCH_TYPE_CHECK_IN',
      original_log: { id: 5003, user: { user_id: '999', name: 'Unknown Worker' } }
    },
    {
      user_id: '102',
      device_datetime: hoursAgoISO(2),
      type: null, // real records are frequently null/PUNCH_TYPE_NONE — should map to 'other'
      original_log: { id: 5004, user: { user_id: '102', name: 'Ivan Okello' } }
    },
    {
      user_id: '103', // provisioned below but marked inactive
      device_datetime: hoursAgoISO(4.5),
      type: 'PUNCH_TYPE_CHECK_IN',
      original_log: { id: 5005, user: { user_id: '103', name: 'Retired Worker' } }
    },
    {
      user_id: '101',
      device_datetime: farFuture, // clock-skewed device — should be rejected
      type: 'PUNCH_TYPE_CHECK_IN',
      original_log: { id: 5006, user: { user_id: '101', name: 'Grace Nakato' } }
    }
  ]
};

// ---- Fake BioStar Casuals group membership — '999' deliberately excluded,
// to test the "skip worker outside the group" path. '103' is provisioned
// but will be marked inactive after the first provisioning pass, to test
// the "skip punches for inactive workers" path. ----
const fakeGroupUsers = [
  { userId: '101', name: 'Grace Nakato' },
  { userId: '102', name: 'Ivan Okello' },
  { userId: '103', name: 'Retired Worker' }
];

const fakeBiostarClient = {
  fetchPunchLogsForDate: async (dateStr) => fakePunchLogsByDate[dateStr] || [],
  fetchGroupUsers: async () => fakeGroupUsers
};

// ---- Inject fakes into the require cache before attendanceSync.js loads ----
function injectFakeModule(resolvedPath, exportsObj) {
  const fakeModule = new Module(resolvedPath, null);
  fakeModule.filename = resolvedPath;
  fakeModule.loaded = true;
  fakeModule.exports = exportsObj;
  Module._cache[resolvedPath] = fakeModule;
}

injectFakeModule(prismaPath, fakePrisma);
injectFakeModule(biostarClientPath, fakeBiostarClient);

const { syncAttendance } = require('../sync/attendanceSync');

// ---- Run and assert ----
async function run() {
  // Mark worker 103 inactive before the first sync, same as flipping
  // CasualWorker.status by hand — provisionCasualWorkers() only refreshes
  // `name` on existing rows, so it won't stomp this back to 'active'.
  await fakePrisma.casualWorker.upsert({
    where: { biostarUserId: '103' },
    update: {},
    create: { biostarUserId: '103', name: 'Retired Worker', startDate: new Date(), status: 'active' }
  });
  fakeCasualWorkers.find((w) => w.biostarUserId === '103').status = 'inactive';

  await syncAttendance();

  const results = fakeAttendanceLogs;
  console.log(`\nRows written: ${results.length}`);
  results.forEach((r) => {
    console.log(`  worker#${r.casualWorkerId}  ${r.eventType.padEnd(9)}  ${r.timestamp.toISOString()}  (biostarEventId=${r.biostarEventId})`);
  });

  const checks = [
    ['exactly 3 rows created (5001, 5002, 5004 — 5003 unrecognized, 5005 inactive, 5006 future-skew, all skipped)', results.length === 3],
    ['check-in mapped correctly', results.some((r) => r.biostarEventId === '5001' && r.eventType === 'check-in')],
    ['check-out mapped correctly', results.some((r) => r.biostarEventId === '5002' && r.eventType === 'check-out')],
    ['unrecognized punch type mapped to "other"', results.some((r) => r.biostarEventId === '5004' && r.eventType === 'other')],
    ['unknown worker (999) was skipped, not inserted', !results.some((r) => r.biostarEventId === '5003')],
    ['inactive worker (103) punch was skipped, not inserted', !results.some((r) => r.biostarEventId === '5005')],
    ['future-timestamped punch (clock skew) was rejected, not inserted', !results.some((r) => r.biostarEventId === '5006')],
    ['re-running sync does not duplicate rows (idempotent upsert)', true] // checked below
  ];

  // Run again to confirm idempotency
  await syncAttendance();
  checks[7][1] = fakeAttendanceLogs.length === 3;

  // ---- Correction propagation: BioStar corrects punch 5001's timestamp on
  // a later sync — the upsert's `update` clause must actually apply the new
  // values, not silently keep the first-synced ones. ----
  const correctedTime = hoursAgoISO(5.25);
  fakePunchLogsByDate = {
    ...fakePunchLogsByDate,
    [today]: fakePunchLogsByDate[today].map((r) =>
      r.original_log.id === 5001 ? { ...r, device_datetime: correctedTime } : r
    )
  };
  await syncAttendance();
  const corrected = fakeAttendanceLogs.find((r) => r.biostarEventId === '5001');
  checks.push(['correction propagation: a modified punch\'s timestamp is updated on re-sync', corrected?.timestamp.toISOString() === correctedTime]);
  checks.push(['correction propagation: no duplicate row was created for the corrected punch', fakeAttendanceLogs.filter((r) => r.biostarEventId === '5001').length === 1]);

  console.log('\nChecks:');
  let allPassed = true;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) allPassed = false;
  }

  process.exit(allPassed ? 0 : 1);
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
