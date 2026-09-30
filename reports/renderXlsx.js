// Report model -> formatted Excel workbook: an Overview sheet (title, period,
// key figures, notes) and one sheet per section with a styled header row,
// frozen panes, filters, banded rows, a totals row, coloured status cells
// and print setup (fit to one page wide).

const ExcelJS = require('exceljs');
const { TAG_LABEL, fmtDay } = require('./reportCatalog');
const { generatedStamp } = require('./reportFormat');

const COLORS = {
  navy: 'FF0F1B2C',
  navy2: 'FF1B2C45',
  teal: 'FF0F7B6C',
  tealSoft: 'FFE6F5F2',
  zebra: 'FFF7F9FB',
  line: 'FFE2E8F0',
  muted: 'FF5B6B80',
  white: 'FFFFFFFF'
};
// Status cells hold Late in / Early out tags; both together use the late colour.
const STATUS_FILL = {
  'late-in': ['FFA26307', 'FFFBEFD5'],
  'early-out': ['FFB3362A', 'FFFBE5E2'],
  'late-in,early-out': ['FFA26307', 'FFFBEFD5']
};
const CODE_FILL = { D: ['FF9A5B00', 'FFFFF8E1'], N: ['FF4338CA', 'FFEEF0FE'], DN: ['FF0F7B6C', 'FFE6F5F2'], A: ['FFB3362A', 'FFFBE5E2'] };
const TONE = { navy: 'FF1B2C45', teal: COLORS.teal, ok: 'FF3FAF83', warn: 'FFE0A63A', grey: 'FF8B9BAF', critical: 'FFD9594C' };

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: COLORS.line } };

// Excel stores dates as serial days; keep EAT wall-clock by shifting.
const excelDate = (dateStr) => new Date(`${dateStr}T00:00:00Z`);
const excelEat = (ts) => new Date(new Date(ts).getTime() + 3 * 3600 * 1000);

function cellValue(col, v) {
  if (v == null || v === '') return null;
  switch (col.type) {
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? excelDate(v) : v;
    case 'time':
    case 'datetime': return excelEat(v);
    case 'pct': return typeof v === 'number' ? v / 100 : v;
    case 'status': return String(v).split(',').map((k) => TAG_LABEL[k] || k).join(' · ');
    default: return v;
  }
}
const NUM_FMT = {
  date: 'ddd dd mmm yyyy',
  time: 'hh:mm',
  datetime: 'dd mmm yyyy hh:mm',
  hours: '0.00',
  pct: '0.0%',
  int: '0',
  minutes: '0" min"'
};

function colWidth(col, rows) {
  const base = { date: 16, time: 8, datetime: 18, hours: 9, pct: 11, int: 8, minutes: 12, status: 13, code: 5, id: 13 }[col.type];
  const longest = Math.max(col.label.length, ...rows.slice(0, 500).map((r) => String(r[col.key] ?? '').length));
  if (col.type === 'text') return Math.min(48, Math.max(10, longest + 2));
  return Math.max(base || 10, col.type === 'code' ? 5 : Math.min(col.label.length + 2, 16));
}

function sheetName(title, used) {
  let base = title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 28).trim() || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

function writeTitle(ws, model, meta, span) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = model.title;
  t.font = { bold: true, size: 16, color: { argb: COLORS.white } };
  t.fill = fill(COLORS.navy);
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, span);
  const s = ws.getCell(2, 1);
  s.value = [meta.orgName, model.subtitle, model.period.label].filter(Boolean).join('  ·  ');
  s.font = { size: 10, color: { argb: COLORS.white } };
  s.fill = fill(COLORS.teal);
  s.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 20;
}

function writeOverview(wb, model, meta) {
  const ws = wb.addWorksheet('Overview', { properties: { tabColor: { argb: COLORS.teal } }, views: [{ showGridLines: false }] });
  ws.columns = [{ width: 26 }, { width: 20 }, { width: 46 }];
  writeTitle(ws, model, meta, 3);

  let r = 4;
  const info = [
    ['Period', model.period.label],
    ['Dates', `${fmtDay(model.period.from)} to ${fmtDay(model.period.to)}`],
    ['Subcontractor', meta.subcontractorName],
    ['Generated', `${generatedStamp(meta.generatedAt)} by ${meta.generatedBy}`],
    ...(meta.download ? [['Downloaded by', meta.download.by], ['Downloaded at', meta.download.atText], ['Download reference', meta.download.ref]] : []),
    ...(meta.scopeNote ? [['Scope', meta.scopeNote]] : []),
    ...(meta.filters || []).map((f) => ['Filter', f])
  ];
  for (const [k, v] of info) {
    ws.getCell(r, 1).value = k;
    ws.getCell(r, 1).font = { bold: true, color: { argb: COLORS.muted } };
    ws.getCell(r, 2).value = v;
    ws.mergeCells(r, 2, r, 3);
    r++;
  }

  if (model.kpis?.length) {
    r++;
    ws.getCell(r, 1).value = 'KEY FIGURES';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: COLORS.teal } };
    r++;
    for (const k of model.kpis) {
      const label = ws.getCell(r, 1);
      label.value = k.label;
      label.font = { bold: true };
      label.border = { left: { style: 'thick', color: { argb: TONE[k.tone] || COLORS.teal } }, bottom: thin };
      const value = ws.getCell(r, 2);
      value.value = /^-?\d+(\.\d+)?$/.test(k.value) ? Number(k.value) : k.value;
      value.font = { bold: true, size: 13, color: { argb: COLORS.navy } };
      value.alignment = { horizontal: 'left' };
      value.border = { bottom: thin };
      const sub = ws.getCell(r, 3);
      sub.value = k.sub || '';
      sub.font = { color: { argb: COLORS.muted }, size: 9 };
      sub.border = { bottom: thin };
      ws.getRow(r).height = 20;
      r++;
    }
  }

  if (model.sections.length > 0) {
    r++;
    ws.getCell(r, 1).value = 'SHEETS IN THIS WORKBOOK';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: COLORS.teal } };
    r++;
    for (const s of model.sections) {
      ws.getCell(r, 1).value = s.title;
      ws.getCell(r, 2).value = `${s.rows.length} row${s.rows.length === 1 ? '' : 's'}`;
      ws.getCell(r, 3).value = s.note || '';
      ws.getCell(r, 3).font = { color: { argb: COLORS.muted }, size: 9 };
      r++;
    }
  }

  if (model.notes?.length) {
    r++;
    ws.getCell(r, 1).value = 'NOTES';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: COLORS.teal } };
    r++;
    for (const n of model.notes) {
      ws.mergeCells(r, 1, r, 3);
      const c = ws.getCell(r, 1);
      c.value = n;
      c.alignment = { wrapText: true, vertical: 'top' };
      c.font = { size: 9, color: { argb: COLORS.muted } };
      ws.getRow(r).height = 28;
      r++;
    }
  }
  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
}

function writeSection(wb, section, model, meta, used) {
  const ws = wb.addWorksheet(sheetName(section.title, used), { views: [{ state: 'frozen', ySplit: 4, xSplit: section.columns[0]?.type === 'id' ? 2 : 1, showGridLines: false }] });
  const cols = section.columns;
  ws.columns = cols.map((c) => ({ width: colWidth(c, section.rows) }));
  writeTitle(ws, { ...model, title: `${model.title} — ${section.title}` }, meta, cols.length);

  // Row 3: section note.
  ws.mergeCells(3, 1, 3, cols.length);
  const note = ws.getCell(3, 1);
  note.value = section.note || '';
  note.font = { italic: true, size: 9, color: { argb: COLORS.muted } };
  note.alignment = { indent: 1, vertical: 'middle' };

  // Row 4: header.
  const header = ws.getRow(4);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: COLORS.white }, size: 10 };
    cell.fill = fill(COLORS.navy2);
    cell.alignment = { vertical: 'middle', horizontal: ['text', 'id'].includes(c.type) ? 'left' : 'center', wrapText: true };
  });
  header.height = cols.some((c) => c.type === 'code') ? 30 : 22;

  section.rows.forEach((row, ri) => {
    const r = ws.getRow(5 + ri);
    if (row._group) {
      // Group header (e.g. one per worker) across the full width.
      ws.mergeCells(5 + ri, 1, 5 + ri, cols.length);
      const cell = r.getCell(1);
      cell.value = { richText: [
        { text: row._group, font: { bold: true, size: 11, color: { argb: COLORS.navy } } },
        { text: row._groupNote ? `     ${row._groupNote}` : '', font: { size: 9, color: { argb: COLORS.teal } } }
      ] };
      cell.fill = fill(COLORS.tealSoft);
      cell.border = { top: { style: 'medium', color: { argb: COLORS.teal } } };
      cell.alignment = { vertical: 'middle', indent: 1 };
      r.height = 22;
      return;
    }
    cols.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      cell.value = cellValue(c, row[c.key]);
      if (NUM_FMT[c.type]) cell.numFmt = NUM_FMT[c.type];
      cell.border = { bottom: thin };
      cell.alignment = { vertical: 'middle', horizontal: ['text', 'id'].includes(c.type) ? 'left' : 'center' };
      if (ri % 2 === 1) cell.fill = fill(COLORS.zebra);
      if (c.type === 'status' && STATUS_FILL[row[c.key]]) {
        const [fg, bg] = STATUS_FILL[row[c.key]];
        cell.font = { bold: true, color: { argb: fg } };
        cell.fill = fill(bg);
      }
      if (c.type === 'code' && CODE_FILL[row[c.key]]) {
        const [fg, bg] = CODE_FILL[row[c.key]];
        cell.font = { bold: true, color: { argb: fg } };
        cell.fill = fill(bg);
      }
      if (c.key === 'worker') cell.font = { bold: true };
    });
  });

  if (section.rows.length === 0) {
    ws.getCell(5, 1).value = 'No records.';
    ws.getCell(5, 1).font = { italic: true, color: { argb: COLORS.muted } };
  } else {
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + section.rows.length, column: cols.length } };
  }

  if (section.totals && section.rows.length) {
    const r = ws.getRow(5 + section.rows.length);
    cols.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      const v = section.totals[c.key];
      cell.value = i === 0 && v == null ? 'TOTAL' : c.type === 'code' ? (v || null) : cellValue(c, v);
      if (NUM_FMT[c.type] && c.type !== 'date') cell.numFmt = NUM_FMT[c.type];
      cell.font = { bold: true, color: { argb: COLORS.navy } };
      cell.fill = fill(COLORS.tealSoft);
      cell.border = { top: { style: 'medium', color: { argb: COLORS.teal } } };
      cell.alignment = { vertical: 'middle', horizontal: ['text', 'id'].includes(c.type) || i === 0 ? 'left' : 'center' };
    });
    r.height = 20;
  }

  ws.pageSetup = {
    orientation: model.landscape || cols.length > 9 ? 'landscape' : 'portrait',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9,
    printTitlesRow: '4:4',
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
  };
  ws.headerFooter.oddFooter = `&L${xlsxText(model.title)} · ${xlsxText(model.period.label)}${downloadFooter(meta)}&RPage &P of &N`;
}

// Page footers treat & as a code, so user text doubles it.
function xlsxText(s) {
  return String(s ?? '').replace(/&/g, '&&');
}
// Second footer line on printed sheets: who downloaded the file, and when.
function downloadFooter(meta) {
  return meta.download ? `\nDownloaded by ${xlsxText(meta.download.by)} on ${xlsxText(meta.download.atText)} · Ref ${meta.download.ref}` : '';
}

async function renderXlsx(model, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'UCAA Casuals Attendance Portal';
  wb.created = meta.generatedAt;
  if (meta.download) {
    wb.lastModifiedBy = meta.download.by;
    wb.description = meta.download.text;
  }
  writeOverview(wb, model, meta);
  const overview = wb.getWorksheet('Overview');
  overview.headerFooter.oddFooter = `&L${xlsxText(model.title)}${downloadFooter(meta)}&RPage &P of &N`;
  const used = new Set(['overview']);
  for (const section of model.sections) writeSection(wb, section, model, meta, used);
  return wb.xlsx.writeBuffer();
}

module.exports = { renderXlsx };
