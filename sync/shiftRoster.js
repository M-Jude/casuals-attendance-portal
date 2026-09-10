// Shift roster upload: parses the system .xlsx template into ShiftAssignment
// rows, which computeDailySummaries.js then treats as the authoritative
// source for who was expected on what shift (see that file for how roster
// and actual punches are reconciled).

const ExcelJS = require('exceljs');
const prisma = require('../prismaClient');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every recognized header variant maps to one of these canonical fields.
// Keeps the parser forgiving of minor formatting differences (spacing,
// case, "Emp ID" vs "Employee ID") without silently accepting a
// differently-shaped file.
const HEADER_ALIASES = {
  employeeid: 'employeeId',
  empid: 'employeeId',
  id: 'employeeId',
  biostaruserid: 'employeeId',
  employeename: 'name',
  name: 'name',
  date: 'date',
  shiftdate: 'date',
  shift: 'shift',
  shiftname: 'shift'
};

function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// exceljs returns a JS Date for a cell formatted/entered as a date, or a
// plain string for one entered as text — the template's example row uses
// text, but a user free-typing into Excel may end up with either.
function normalizeDateValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return DATE_RE.test(trimmed) ? trimmed : null;
  }
  return null;
}

// Builds the downloadable .xlsx roster template — this IS the system
// template; parseRosterWorkbook below validates uploads against these same
// column names.
async function generateTemplateBuffer() {
  const shifts = await prisma.shift.findMany({ orderBy: { name: 'asc' } });
  const shiftNames = shifts.map((s) => s.name).join(', ') || 'Day, Night';

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Roster');
  sheet.columns = [
    { header: 'Employee ID', key: 'employeeId', width: 16 },
    { header: 'Employee Name', key: 'name', width: 28 },
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Shift', key: 'shift', width: 12 }
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({ employeeId: '12345', name: 'Jane Example', date: '2026-09-15', shift: shifts[0]?.name || 'Day' });

  const notes = workbook.addWorksheet('Instructions');
  notes.columns = [{ key: 'text', width: 100 }];
  notes.addRows([
    { text: 'Fill in one row per worker per scheduled shift date on the Roster sheet.' },
    { text: 'Employee ID must match the worker\'s ID in BioStar (shown as "Employee ID" on the dashboard).' },
    { text: 'Date must be YYYY-MM-DD — for a Night shift, use the date the shift STARTS (the evening), not the morning it ends.' },
    { text: `Shift must be one of: ${shiftNames}.` },
    { text: 'Employee Name is optional, for your own reference only — it is not read by the system.' },
    { text: 'Re-uploading a row for the same Employee ID + Date replaces the previous assignment for that date.' }
  ]);

  return workbook.xlsx.writeBuffer();
}

// Reads the first worksheet of an uploaded workbook into plain row objects
// keyed by canonical field name. Throws on structural problems (no
// worksheet, missing required columns) — those abort the whole upload,
// unlike per-row data problems which are collected as errors instead.
async function parseRosterWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('No worksheet found in the uploaded file.');

  const columnMap = {}; // column number -> canonical field
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const field = HEADER_ALIASES[normalizeHeader(cell.value)];
    if (field) columnMap[colNumber] = field;
  });

  const foundFields = new Set(Object.values(columnMap));
  const missing = ['employeeId', 'date', 'shift'].filter((f) => !foundFields.has(f));
  if (missing.length > 0) {
    throw new Error(`Missing required column(s): ${missing.join(', ')}. Download the template and use its headers.`);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = Array.isArray(row.values) ? row.values : [];
    const isBlank = values.every((v) => v === null || v === undefined || v === '');
    if (isBlank) return;

    const entry = { rowNumber };
    for (const [colNumber, field] of Object.entries(columnMap)) {
      entry[field] = row.getCell(Number(colNumber)).value;
    }
    rows.push(entry);
  });

  return rows;
}

// Parses + validates an uploaded roster and upserts ShiftAssignment rows.
// Per-row problems (unknown worker, bad date, unknown shift) are collected
// and reported rather than aborting the whole file — a roster with a
// hundred good rows and one typo shouldn't lose the hundred.
async function importRoster({ buffer, subcontractorName }) {
  const rawRows = await parseRosterWorkbook(buffer);
  if (rawRows.length === 0) {
    return { imported: 0, skipped: 0, errors: [{ row: null, message: 'No data rows found in the uploaded file.' }], dateRange: null };
  }

  const [shifts, workers] = await Promise.all([
    prisma.shift.findMany(),
    prisma.casualWorker.findMany({ where: { subcontractorName } })
  ]);
  const shiftByName = new Map(shifts.map((s) => [s.name.toLowerCase(), s]));
  const workerById = new Map(workers.map((w) => [w.biostarUserId, w]));

  const errors = [];
  const validAssignments = [];
  let minDate = null;
  let maxDate = null;

  for (const row of rawRows) {
    const employeeId = row.employeeId != null ? String(row.employeeId).trim() : '';
    const shiftNameRaw = row.shift != null ? String(row.shift).trim() : '';
    const dateStr = normalizeDateValue(row.date);

    if (!employeeId) { errors.push({ row: row.rowNumber, message: 'Missing Employee ID.' }); continue; }
    if (!dateStr) { errors.push({ row: row.rowNumber, message: `Invalid or missing Date (expected YYYY-MM-DD): "${row.date ?? ''}".` }); continue; }
    if (!shiftNameRaw) { errors.push({ row: row.rowNumber, message: 'Missing Shift.' }); continue; }

    const worker = workerById.get(employeeId);
    if (!worker) { errors.push({ row: row.rowNumber, message: `Employee ID "${employeeId}" not found among your workers.` }); continue; }

    const shift = shiftByName.get(shiftNameRaw.toLowerCase());
    if (!shift) {
      errors.push({ row: row.rowNumber, message: `Unknown shift "${shiftNameRaw}" — must be one of: ${shifts.map((s) => s.name).join(', ')}.` });
      continue;
    }

    validAssignments.push({ casualWorkerId: worker.id, dateStr, shiftId: shift.id });
    if (!minDate || dateStr < minDate) minDate = dateStr;
    if (!maxDate || dateStr > maxDate) maxDate = dateStr;
  }

  // If the same worker+date appears twice in one file, the last row wins —
  // same outcome as uploading it twice in separate files.
  const dedupedByKey = new Map();
  for (const a of validAssignments) dedupedByKey.set(`${a.casualWorkerId}|${a.dateStr}`, a);

  let imported = 0;
  for (const a of dedupedByKey.values()) {
    await prisma.shiftAssignment.upsert({
      where: { casualWorkerId_date: { casualWorkerId: a.casualWorkerId, date: new Date(`${a.dateStr}T00:00:00.000Z`) } },
      update: { shiftId: a.shiftId, uploadedAt: new Date() },
      create: { casualWorkerId: a.casualWorkerId, date: new Date(`${a.dateStr}T00:00:00.000Z`), shiftId: a.shiftId }
    });
    imported++;
  }

  return {
    imported,
    skipped: errors.length,
    errors: errors.slice(0, 50), // cap so a badly-malformed file doesn't dump thousands of rows into the response
    dateRange: minDate && maxDate ? { from: minDate, to: maxDate } : null
  };
}

module.exports = { generateTemplateBuffer, importRoster };
