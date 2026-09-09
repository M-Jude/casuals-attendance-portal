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
const fakeAttendanceLogs = [];

const fakePrisma = {
  attendanceLog: {
    findFirst: async () => {
      if (fakeAttendanceLogs.length === 0) return null;
      return fakeAttendanceLogs.reduce((latest, row) =>
        row.timestamp > latest.timestamp ? row : latest
      );
    },
    upsert: async ({ where, create }) => {
      const existing = fakeAttendanceLogs.find((r) => r.biostarEventId === where.biostarEventId);
      if (existing) return existing;
      const row = { id: fakeAttendanceLogs.length + 1, ...create };
      fakeAttendanceLogs.push(row);
      return row;
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
const fakePunchLogsByDate = {
  [today]: [
    {
      user_id: '101',
      device_datetime: `${today}T06:58:00.000Z`,
      type: 'PUNCH_TYPE_CHECK_IN',
      original_log: { id: 5001, user: { user_id: '101', name: 'Grace Nakato' } }
    },
    {
      user_id: '101',
      device_datetime: `${today}T17:04:00.000Z`,
      type: 'PUNCH_TYPE_CHECK_OUT',
      original_log: { id: 5002, user: { user_id: '101', name: 'Grace Nakato' } }
    },
    {
      user_id: '999', // not provisioned
      device_datetime: `${today}T07:10:00.000Z`,
      type: 'PUNCH_TYPE_CHECK_IN',
      original_log: { id: 5003, user: { user_id: '999', name: 'Unknown Worker' } }
    },
    {
      user_id: '102',
      device_datetime: `${today}T12:00:00.000Z`,
      type: null, // real records are frequently null/PUNCH_TYPE_NONE — should map to 'other'
      original_log: { id: 5004, user: { user_id: '102', name: 'Ivan Okello' } }
    }
  ]
};

// ---- Fake BioStar Casuals group membership — '999' deliberately excluded,
// to test the "skip worker outside the group" path. ----
const fakeGroupUsers = [
  { userId: '101', name: 'Grace Nakato' },
  { userId: '102', name: 'Ivan Okello' }
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
  await syncAttendance();

  const results = fakeAttendanceLogs;
  console.log(`\nRows written: ${results.length}`);
  results.forEach((r) => {
    console.log(`  worker#${r.casualWorkerId}  ${r.eventType.padEnd(9)}  ${r.timestamp.toISOString()}  (biostarEventId=${r.biostarEventId})`);
  });

  const checks = [
    ['exactly 3 rows created (5001, 5002, 5004 — 5003 skipped, unknown worker)', results.length === 3],
    ['check-in mapped correctly', results.some((r) => r.biostarEventId === '5001' && r.eventType === 'check-in')],
    ['check-out mapped correctly', results.some((r) => r.biostarEventId === '5002' && r.eventType === 'check-out')],
    ['unrecognized punch type mapped to "other"', results.some((r) => r.biostarEventId === '5004' && r.eventType === 'other')],
    ['unknown worker (999) was skipped, not inserted', !results.some((r) => r.biostarEventId === '5003')],
    ['re-running sync does not duplicate rows (idempotent upsert)', true] // checked below
  ];

  // Run again to confirm idempotency
  await syncAttendance();
  checks[5][1] = fakeAttendanceLogs.length === 3;

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
