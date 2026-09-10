const path = require('path');
const Module = require('module');

const prismaPath = path.join(__dirname, '..', 'prismaClient.js');

const DAY_SHIFT = { id: 1, name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 15 };
const NIGHT_SHIFT = { id: 2, name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 15 };

const workers = [
  { id: 1, biostarUserId: '12345', subcontractorName: 'Subcontractor A' },
  { id: 2, biostarUserId: '99999', subcontractorName: 'Subcontractor A' }
];

let upserts = [];

const fakePrisma = {
  shift: { findMany: async () => [DAY_SHIFT, NIGHT_SHIFT] },
  casualWorker: { findMany: async ({ where }) => workers.filter((w) => w.subcontractorName === where.subcontractorName) },
  shiftAssignment: {
    upsert: async ({ where, create }) => { upserts.push({ where, create }); return create; }
  }
};

function injectFakeModule(resolvedPath, exportsObj) {
  const fakeModule = new Module(resolvedPath, null);
  fakeModule.filename = resolvedPath;
  fakeModule.loaded = true;
  fakeModule.exports = exportsObj;
  Module._cache[resolvedPath] = fakeModule;
}
injectFakeModule(prismaPath, fakePrisma);

const ExcelJS = require('exceljs');
const { generateTemplateBuffer, importRoster } = require('../sync/shiftRoster');

async function run() {
  const checks = [];

  // --- The downloaded template must itself be a valid, importable roster ---
  const templateBuf = await generateTemplateBuffer();
  checks.push(['template buffer generated, non-empty', Buffer.isBuffer(templateBuf) && templateBuf.length > 0]);

  const templateResult = await importRoster({ buffer: templateBuf, subcontractorName: 'Subcontractor A' });
  checks.push(['template example row (Employee ID 12345) imports cleanly', templateResult.imported === 1 && templateResult.skipped === 0]);
  checks.push(['template import wrote exactly one ShiftAssignment upsert', upserts.length === 1]);

  // --- Validation paths: unknown worker, unknown shift, bad date, blank rows ---
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Roster');
  sheet.addRow(['Employee ID', 'Employee Name', 'Date', 'Shift']);
  sheet.addRow(['12345', 'Jane', '2026-09-15', 'Day']);     // valid
  sheet.addRow(['99999', 'Bob', '2026-09-16', 'Night']);    // valid
  sheet.addRow(['00000', 'Ghost', '2026-09-15', 'Day']);    // unknown worker
  sheet.addRow(['12345', 'Jane', '2026-09-17', 'Evening']); // unknown shift
  sheet.addRow(['12345', 'Jane', 'not-a-date', 'Day']);     // bad date
  sheet.addRow([]);                                          // blank row — skipped silently, not an error
  const buf2 = await wb.xlsx.writeBuffer();

  upserts = [];
  const result2 = await importRoster({ buffer: buf2, subcontractorName: 'Subcontractor A' });
  checks.push(['2 valid rows imported, 3 invalid rows reported as errors', result2.imported === 2 && result2.skipped === 3]);
  checks.push(['dateRange spans exactly the two valid rows', result2.dateRange?.from === '2026-09-15' && result2.dateRange?.to === '2026-09-16']);
  checks.push(['unknown-worker row reported with a clear message', result2.errors.some((e) => /not found among your workers/.test(e.message))]);
  checks.push(['unknown-shift row reported with a clear message', result2.errors.some((e) => /Unknown shift/.test(e.message))]);
  checks.push(['bad-date row reported with a clear message', result2.errors.some((e) => /Invalid or missing Date/.test(e.message))]);

  // --- Cross-tenant isolation: a worker from another subcontractor must never be importable ---
  workers.push({ id: 3, biostarUserId: '55555', subcontractorName: 'Subcontractor B' });
  const wbCross = new ExcelJS.Workbook();
  const sheetCross = wbCross.addWorksheet('Roster');
  sheetCross.addRow(['Employee ID', 'Employee Name', 'Date', 'Shift']);
  sheetCross.addRow(['55555', 'Cross Tenant', '2026-09-18', 'Day']);
  const bufCross = await wbCross.xlsx.writeBuffer();
  const resultCross = await importRoster({ buffer: bufCross, subcontractorName: 'Subcontractor A' });
  checks.push(['worker belonging to a different subcontractor is rejected, not imported', resultCross.imported === 0 && resultCross.skipped === 1]);

  // --- Same worker+date appearing twice in one file: last row wins, one upsert ---
  const wbDupe = new ExcelJS.Workbook();
  const sheetDupe = wbDupe.addWorksheet('Roster');
  sheetDupe.addRow(['Employee ID', 'Employee Name', 'Date', 'Shift']);
  sheetDupe.addRow(['12345', 'Jane', '2026-09-20', 'Day']);
  sheetDupe.addRow(['12345', 'Jane', '2026-09-20', 'Night']); // same worker+date, later row
  const bufDupe = await wbDupe.xlsx.writeBuffer();
  upserts = [];
  const resultDupe = await importRoster({ buffer: bufDupe, subcontractorName: 'Subcontractor A' });
  checks.push(['duplicate worker+date in one file collapses to a single upsert', resultDupe.imported === 1 && upserts.length === 1]);
  checks.push(['the later row in the file wins (Night, not Day)', upserts[0].create.shiftId === NIGHT_SHIFT.id]);

  // --- Missing a required column is a structural error, not a per-row one ---
  const wbMissing = new ExcelJS.Workbook();
  const sheetMissing = wbMissing.addWorksheet('Roster');
  sheetMissing.addRow(['Employee ID', 'Date']); // no Shift column
  sheetMissing.addRow(['12345', '2026-09-19']);
  const bufMissing = await wbMissing.xlsx.writeBuffer();
  let threwMissingColumn = false;
  try {
    await importRoster({ buffer: bufMissing, subcontractorName: 'Subcontractor A' });
  } catch (err) {
    threwMissingColumn = /Missing required column/.test(err.message);
  }
  checks.push(['missing Shift column throws a clear structural error', threwMissingColumn]);

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
