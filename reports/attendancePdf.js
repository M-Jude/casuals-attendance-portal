// Renders the shift-aware attendance summaries into a styled PDF report.
//
// Pure rendering: takes already-fetched DailyAttendanceSummary rows (with
// worker/shift included) plus report metadata, and returns a
// finished PDFKit document. No DB or HTTP concerns live here.
//
// PDFKit's built-in Helvetica only covers WinAnsi, so every string goes
// through safe() and the layout avoids glyphs outside that set (no arrows,
// check marks, etc. — icons are drawn as vector paths instead).

const PDFDocument = require('pdfkit');

const TZ = 'Africa/Kampala';
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36; // side margin
const W = PAGE_W - M * 2; // content width
const TOP_NEXT = 58; // content start on pages after the first (below the running header)
const BOTTOM = PAGE_H - 46; // content must end above the footer

const C = {
  navy: '#0F1B2C',
  navy2: '#1B2C45',
  teal: '#3E8E7E',
  tealDark: '#2A6F62',
  tealSoft: '#E8F3F0',
  ink: '#1B2A40',
  muted: '#66768A',
  faint: '#9AA7B6',
  line: '#E3E9EF',
  hair: '#EDF1F5',
  zebra: '#F7F9FB',
  white: '#FFFFFF',
  onBand: '#AAB8C9'
};

const STATUS = {
  'on-time': { label: 'On time', fg: '#1F7A55', bg: '#E1F3EA', bar: '#3FAF83' },
  early: { label: 'Early', fg: '#1F6FA8', bg: '#E2EFF9', bar: '#5BA4DA' },
  late: { label: 'Late', fg: '#A26307', bg: '#FBEFD5', bar: '#E0A63A' },
  'no-checkout': { label: 'No checkout', fg: '#4A596C', bg: '#E9EDF2', bar: '#8B9BAF' },
  'no-checkin': { label: 'No check-in', fg: '#4A596C', bg: '#E9EDF2', bar: '#A9B6C5' },
  'no-show': { label: 'No-show', fg: '#B3362A', bg: '#FBE5E2', bar: '#D9594C' },
  'in-progress': { label: 'In progress', fg: '#1F6FA8', bg: '#E2EFF9', bar: '#9CC7EA' }
};
const STATUS_ORDER = ['on-time', 'early', 'late', 'no-checkout', 'no-checkin', 'no-show', 'in-progress'];
const STATUS_RANK = { 'no-show': 0, late: 1, 'no-checkout': 2, 'no-checkin': 2, early: 3, 'on-time': 4, 'in-progress': 5 };

const SORT_LABELS = {
  'date-desc': 'Date (newest first)',
  'date-asc': 'Date (oldest first)',
  'name-asc': 'Name (A-Z)',
  'name-desc': 'Name (Z-A)',
  'id-asc': 'Employee ID (A-Z)',
  'id-desc': 'Employee ID (Z-A)',
  status: 'Status (issues first)'
};
const GROUP_LABELS = { date: 'Grouped by date', worker: 'Grouped by employee', none: 'No grouping' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------- formatting ----------

// Anything outside WinAnsi would render as garbage in the built-in fonts.
function safe(value) {
  return String(value ?? '').replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, '?');
}

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
});
function kampalaParts(date) {
  const p = {};
  for (const part of clockFmt.formatToParts(date)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}
const pad2 = (n) => String(n).padStart(2, '0');

function fmtTime(date) {
  if (!date) return null;
  const p = kampalaParts(new Date(date));
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function dateStrOf(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// "2026-09-18" -> "18 Sep 2026" (the string is an anchor date, not a
// timestamp, so no timezone shifting is applied).
function fmtDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${pad2(d)} ${MONTHS[m - 1]} ${y}`;
}
function fmtDayShort(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${pad2(d)} ${MONTHS[m - 1]}`;
}
function weekdayOf(dateStr) {
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}
function fmtStamp(date) {
  const p = kampalaParts(date);
  return `${pad2(p.day)} ${MONTHS[p.month - 1]} ${p.year}, ${pad2(p.hour)}:${pad2(p.minute)} EAT`;
}
const fmtHours = (h) => (h == null ? null : h.toFixed(1));
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

// ---------- view preparation (mirrors the dashboard's filter/sort/group) ----------

function sortRows(rows, sortBy) {
  const out = [...rows];
  const byId = (a, b) => a.worker.biostarUserId.localeCompare(b.worker.biostarUserId, undefined, { numeric: true });
  switch (sortBy) {
    case 'date-asc': out.sort((a, b) => a.date - b.date); break;
    case 'name-asc': out.sort((a, b) => a.worker.name.localeCompare(b.worker.name)); break;
    case 'name-desc': out.sort((a, b) => b.worker.name.localeCompare(a.worker.name)); break;
    case 'id-asc': out.sort(byId); break;
    case 'id-desc': out.sort((a, b) => byId(b, a)); break;
    case 'status': out.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]); break;
    default: out.sort((a, b) => b.date - a.date); // date-desc
  }
  return out;
}

function countByStatus(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const r of rows) if (counts[r.status] !== undefined) counts[r.status]++;
  return counts;
}

function groupRows(rows, groupBy) {
  if (groupBy === 'none') return [{ key: 'all', label: null, rows }];

  const groups = new Map();
  for (const row of rows) {
    const dateStr = dateStrOf(row.date);
    const key = groupBy === 'date' ? dateStr : row.worker.id;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: groupBy === 'date' ? `${weekdayOf(dateStr)}, ${fmtDay(dateStr)}` : `${row.worker.name} (${row.worker.biostarUserId})`,
        sortKey: groupBy === 'date' ? dateStr : row.worker.name.toLowerCase(),
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }

  const list = Array.from(groups.values());
  list.sort((a, b) => (groupBy === 'date' ? b.sortKey.localeCompare(a.sortKey) : a.sortKey.localeCompare(b.sortKey)));
  return list;
}

// Mirrored by src/attendanceStats.js's computeAnalytics() for the
// dashboard's on-screen analytics panel — keep the two in sync.
function computeStats(rows) {
  const counts = countByStatus(rows);
  const workers = new Set();
  const byDate = new Map();
  const byShift = new Map();
  const perWorker = new Map();
  let hoursTotal = 0;
  let hoursN = 0;
  let earlyCheckOuts = 0;
  let multiPunch = 0;
  let unscheduled = 0;
  let unapproved = 0;

  for (const r of rows) {
    workers.add(r.worker.id);

    const d = dateStrOf(r.date);
    if (!byDate.has(d)) byDate.set(d, Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])));
    if (byDate.get(d)[r.status] !== undefined) byDate.get(d)[r.status]++;

    byShift.set(r.shift.name, (byShift.get(r.shift.name) || 0) + 1);

    if (r.hoursWorked != null) { hoursTotal += r.hoursWorked; hoursN++; }
    if (r.earlyCheckOut) earlyCheckOuts++;
    if (r.hasMultiplePunches) multiPunch++;
    if (r.source === 'unscheduled') unscheduled++;
    if (!r.approvedAt || r.changedAfterApproval) unapproved++;

    if (!perWorker.has(r.worker.id)) {
      perWorker.set(r.worker.id, { worker: r.worker, late: 0, noCheckout: 0, noShow: 0, earlyOut: 0, shifts: 0 });
    }
    const w = perWorker.get(r.worker.id);
    w.shifts++;
    if (r.status === 'late') w.late++;
    if (r.status === 'no-checkout') w.noCheckout++;
    if (r.status === 'no-show') w.noShow++;
    if (r.earlyCheckOut) w.earlyOut++;
  }

  const completed = counts['on-time'] + counts.early + counts.late;
  const attention = [...perWorker.values()]
    .map((w) => ({ ...w, issues: w.late + w.noCheckout + w.noShow }))
    .filter((w) => w.issues > 0)
    .sort((a, b) => b.issues - a.issues || b.noShow - a.noShow || a.worker.name.localeCompare(b.worker.name));

  return {
    total: rows.length,
    counts,
    workers: workers.size,
    completed,
    punctual: counts['on-time'] + counts.early,
    hoursTotal,
    hoursAvg: hoursN ? hoursTotal / hoursN : 0,
    earlyCheckOuts,
    multiPunch,
    unscheduled,
    unapproved,
    byShift,
    days: [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    attention
  };
}

// ---------- drawing primitives ----------

function fit(doc, str, maxW, font, size) {
  const s = safe(str);
  doc.font(font).fontSize(size);
  if (doc.widthOfString(s) <= maxW) return s;
  let cut = s;
  while (cut.length > 1 && doc.widthOfString(`${cut}…`) > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function txt(doc, str, x, y, o = {}) {
  const { size = 8, font = 'Helvetica', color = C.ink, width, align = 'left', spacing = 0 } = o;
  doc.font(font).fontSize(size).fillColor(color);
  doc.text(safe(str), x, y, { width, align, lineBreak: false, characterSpacing: spacing });
}

function emblem(doc, x, y, size) {
  doc.roundedRect(x, y, size, size, size * 0.24).fill(C.teal);
  doc
    .save()
    .lineWidth(size * 0.12)
    .lineCap('round')
    .lineJoin('round')
    .strokeColor(C.white)
    .moveTo(x + size * 0.26, y + size * 0.53)
    .lineTo(x + size * 0.43, y + size * 0.69)
    .lineTo(x + size * 0.75, y + size * 0.33)
    .stroke()
    .restore();
}

function sectionTitle(doc, cur, title, sub) {
  cur.ensure(34);
  doc.rect(M, cur.y + 1, 3, 11).fill(C.teal);
  txt(doc, title, M + 10, cur.y, { size: 11, font: 'Helvetica-Bold', color: C.navy });
  if (sub) {
    const tw = doc.font('Helvetica-Bold').fontSize(11).widthOfString(safe(title));
    txt(doc, sub, M + 10 + tw + 8, cur.y + 2.5, { size: 7.5, color: C.faint });
  }
  cur.y += 22;
}

function makeCursor(doc) {
  const cur = { y: 0, onNewPage: null };
  cur.ensure = (h) => {
    if (cur.y + h <= BOTTOM) return false;
    doc.addPage();
    cur.y = TOP_NEXT;
    if (cur.onNewPage) cur.onNewPage();
    return true;
  };
  return cur;
}

// ---------- page 1 blocks ----------

function drawBand(doc, meta) {
  const h = 116;
  doc.rect(0, 0, PAGE_W, h).fill(C.navy);

  // Soft decorative circles, clipped to the band.
  doc.save();
  doc.rect(0, 0, PAGE_W, h).clip();
  doc.opacity(0.1).circle(PAGE_W - 30, -10, 110).fill(C.teal);
  doc.opacity(0.06).circle(PAGE_W - 120, h + 30, 80).fill(C.teal);
  doc.restore();
  doc.rect(0, h, PAGE_W, 3).fill(C.teal);

  emblem(doc, M, 30, 38);
  txt(doc, 'UCAA  -  CASUALS ATTENDANCE', M + 50, 31, { size: 7.5, font: 'Helvetica-Bold', color: '#7FC4B4', spacing: 1.3 });
  txt(doc, 'Attendance Report', M + 50, 43, { size: 24, font: 'Helvetica-Bold', color: C.white });
  txt(doc, `Subcontractor: ${meta.subcontractorName}`, M + 50, 76, { size: 9.5, color: C.onBand });

  const rightW = 230;
  const rx = PAGE_W - M - rightW;
  txt(doc, 'REPORT PERIOD', rx, 34, { size: 7, font: 'Helvetica-Bold', color: '#7FC4B4', spacing: 1.3, width: rightW, align: 'right' });
  const period = meta.from === meta.to ? fmtDay(meta.from) : `${fmtDay(meta.from)}  -  ${fmtDay(meta.to)}`;
  txt(doc, period, rx, 46, { size: 12.5, font: 'Helvetica-Bold', color: C.white, width: rightW, align: 'right' });
  txt(doc, `Generated ${fmtStamp(meta.generatedAt)}`, rx, 68, { size: 8, color: C.onBand, width: rightW, align: 'right' });
  return h + 3;
}

function drawChips(doc, y, chips) {
  let x = M;
  let rowY = y;
  doc.font('Helvetica').fontSize(7.5);
  for (const chip of chips) {
    const label = safe(chip);
    const w = doc.widthOfString(label) + 16;
    if (x + w > M + W) { x = M; rowY += 22; }
    doc.roundedRect(x, rowY, w, 16, 8).fill('#EEF2F6');
    txt(doc, label, x + 8, rowY + 4.4, { size: 7.5, color: C.muted });
    x += w + 6;
  }
  return rowY + 16;
}

function drawKpis(doc, y, stats) {
  const gap = 9;
  const cw = (W - gap * 3) / 4;
  const ch = 60;
  const punctuality = stats.completed ? `${pct(stats.punctual, stats.completed)}%` : '-';

  const cards = [
    { label: 'SHIFT RECORDS', value: String(stats.total), sub: `across ${stats.days.length} day${stats.days.length === 1 ? '' : 's'}`, color: C.navy2 },
    { label: 'WORKERS', value: String(stats.workers), sub: 'with attendance in range', color: C.navy2 },
    { label: 'COMPLETED SHIFTS', value: String(stats.completed), sub: `${pct(stats.completed, stats.total)}% of records have in + out`, color: C.teal },
    { label: 'HOURS WORKED', value: stats.hoursTotal.toFixed(1), sub: stats.completed ? `avg ${stats.hoursAvg.toFixed(1)} h per shift` : 'no completed shifts', color: C.teal },
    { label: 'PUNCTUALITY', value: punctuality, sub: `${stats.punctual} of ${stats.completed} completed shifts`, color: STATUS['on-time'].bar },
    { label: 'LATE ARRIVALS', value: String(stats.counts.late), sub: `${pct(stats.counts.late, stats.total)}% of records`, color: STATUS.late.bar },
    { label: 'NO CHECKOUT', value: String(stats.counts['no-checkout']), sub: `${pct(stats.counts['no-checkout'], stats.total)}% of records`, color: STATUS['no-checkout'].bar },
    { label: 'NO-SHOWS', value: String(stats.counts['no-show']), sub: 'scheduled, no punch activity', color: STATUS['no-show'].bar }
  ];

  cards.forEach((card, i) => {
    const x = M + (i % 4) * (cw + gap);
    const cy = y + Math.floor(i / 4) * (ch + gap);
    doc.roundedRect(x, cy, cw, ch, 5).fillAndStroke(C.white, C.line);
    doc.save();
    doc.roundedRect(x, cy, cw, ch, 5).clip();
    doc.rect(x, cy, 3.5, ch).fill(card.color);
    doc.restore();
    txt(doc, card.label, x + 13, cy + 9, { size: 6.5, font: 'Helvetica-Bold', color: C.muted, spacing: 0.9 });
    txt(doc, card.value, x + 13, cy + 21, { size: 20, font: 'Helvetica-Bold', color: C.navy });
    txt(doc, fit(doc, card.sub, cw - 22, 'Helvetica', 6.8), x + 13, cy + 47, { size: 6.8, color: C.faint });
  });

  return y + 2 * ch + gap;
}

function drawStatusBreakdown(doc, cur, stats, shifts) {
  sectionTitle(doc, cur, 'Attendance breakdown', 'by status');
  cur.ensure(96);

  // Stacked proportion bar.
  const barH = 16;
  const total = stats.total || 1;
  doc.save();
  doc.roundedRect(M, cur.y, W, barH, 8).clip();
  let x = M;
  for (const s of STATUS_ORDER) {
    const w = (stats.counts[s] / total) * W;
    if (w <= 0) continue;
    doc.rect(x, cur.y, w, barH).fill(STATUS[s].bar);
    x += w;
  }
  doc.restore();
  x = M;
  for (const s of STATUS_ORDER) {
    const w = (stats.counts[s] / total) * W;
    if (w >= 34) {
      txt(doc, `${pct(stats.counts[s], stats.total)}%`, x, cur.y + 4.6, { size: 7, font: 'Helvetica-Bold', color: C.white, width: w, align: 'center' });
    }
    x += w;
  }
  cur.y += barH + 12;

  // Legend cells.
  const cw = W / STATUS_ORDER.length;
  STATUS_ORDER.forEach((s, i) => {
    const lx = M + i * cw;
    doc.circle(lx + 4, cur.y + 4.5, 3.5).fill(STATUS[s].bar);
    txt(doc, STATUS[s].label, lx + 12, cur.y, { size: 8, color: C.muted });
    txt(doc, String(stats.counts[s]), lx, cur.y + 13, { size: 15, font: 'Helvetica-Bold', color: STATUS[s].fg });
    const cw2 = doc.font('Helvetica-Bold').fontSize(15).widthOfString(String(stats.counts[s]));
    txt(doc, `${pct(stats.counts[s], stats.total)}%`, lx + cw2 + 5, cur.y + 19, { size: 8, color: C.faint });
  });
  cur.y += 40;

  // Shift split + flag summary.
  const shiftBits = shifts.map((sh) => `${sh.name} shift (${sh.startTime}-${sh.endTime}): ${stats.byShift.get(sh.name) || 0}`);
  const grace = shifts[0] ? `Grace period: ${shifts[0].graceMinutes} min` : null;
  txt(doc, [...shiftBits, grace].filter(Boolean).join('     |     '), M, cur.y, { size: 7.8, color: C.muted });
  cur.y += 13;
  txt(
    doc,
    `Early check-outs: ${stats.earlyCheckOuts}     |     Shifts with multiple punches: ${stats.multiPunch}     |     Unscheduled: ${stats.unscheduled}     |     Not yet approved: ${stats.unapproved}`,
    M, cur.y, { size: 7.8, color: C.muted }
  );
  cur.y += 26;
}

function drawDailyChart(doc, cur, stats) {
  const days = stats.days;
  if (days.length < 2 || days.length > 62) return; // a single bar (or a wall of them) says nothing

  const chartH = 86;
  const labelH = 24;
  sectionTitle(doc, cur, 'Records per day', 'stacked by status');
  cur.ensure(chartH + labelH + 12);

  const gutter = 26;
  const plotX = M + gutter;
  const plotW = W - gutter;
  const top = cur.y + 8;
  const base = top + chartH;

  const maxTotal = Math.max(...days.map(([, c]) => Object.values(c).reduce((a, b) => a + b, 0)));
  const step = maxTotal <= 10 ? 2 : maxTotal <= 40 ? 10 : maxTotal <= 100 ? 20 : maxTotal <= 250 ? 50 : 100;
  const max = Math.ceil(maxTotal / step) * step || step;

  // Gridlines + y labels.
  for (let g = 0; g <= 2; g++) {
    const gy = base - (g / 2) * chartH;
    doc.save().lineWidth(0.5).strokeColor(g === 0 ? C.faint : C.line).moveTo(plotX, gy).lineTo(M + W, gy).stroke().restore();
    txt(doc, String(Math.round((g / 2) * max)), M, gy - 3, { size: 6.5, color: C.faint, width: gutter - 6, align: 'right' });
  }

  const slot = plotW / days.length;
  const barW = Math.min(30, slot * 0.68);
  const labelEvery = Math.max(1, Math.ceil(13 / slot));

  days.forEach(([dateStr, counts], i) => {
    const bx = plotX + i * slot + (slot - barW) / 2;
    let by = base;
    for (const s of STATUS_ORDER) {
      const bh = (counts[s] / max) * chartH;
      if (bh <= 0) continue;
      doc.rect(bx, by - bh, barW, bh).fill(STATUS[s].bar);
      by -= bh;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (slot >= 15) txt(doc, String(total), bx - 6, by - 9, { size: 6.5, font: 'Helvetica-Bold', color: C.ink, width: barW + 12, align: 'center' });

    if (i % labelEvery === 0) {
      txt(doc, dateStr.slice(8, 10), bx - 8, base + 4, { size: 7, font: 'Helvetica-Bold', color: C.muted, width: barW + 16, align: 'center' });
      if (slot >= 22) txt(doc, weekdayOf(dateStr).slice(0, 3), bx - 8, base + 13, { size: 6, color: C.faint, width: barW + 16, align: 'center' });
    }
  });

  const first = days[0][0];
  const last = days[days.length - 1][0];
  txt(doc, `${fmtDayShort(first)} - ${fmtDayShort(last)} ${last.slice(0, 4)}`, plotX, base + labelH + 1, { size: 6.5, color: C.faint });
  cur.y = base + labelH + 22;
}

// ---------- tables ----------

function drawTableHeader(doc, y, cols, x0 = M) {
  doc.rect(x0, y, W, 20).fill(C.navy2);
  let x = x0;
  for (const col of cols) {
    txt(doc, col.label, x + 7, y + 6.8, { size: 6.4, font: 'Helvetica-Bold', color: '#C7D2DF', spacing: 0.7, width: col.w - 14, align: col.align || 'left' });
    x += col.w;
  }
}

function drawAttention(doc, cur, stats) {
  if (stats.attention.length === 0) return;
  const list = stats.attention.slice(0, 10);
  sectionTitle(doc, cur, 'Workers needing attention', `top ${list.length} by late arrivals, no checkouts and no-shows`);

  const cols = [
    { label: 'WORKER', w: 205 },
    { label: 'LATE', w: 62, align: 'center' },
    { label: 'NO CHECKOUT', w: 82, align: 'center' },
    { label: 'NO-SHOW', w: 64, align: 'center' },
    { label: 'EARLY OUT', w: 60, align: 'center' },
    { label: 'SHIFTS', w: W - 205 - 62 - 82 - 64 - 60, align: 'center' }
  ];
  const redraw = () => drawTableHeader(doc, cur.y, cols);
  cur.ensure(20 + 26 * 2);
  redraw();
  cur.y += 20;

  const rowH = 26;
  list.forEach((w, i) => {
    if (cur.ensure(rowH)) { redraw(); cur.y += 20; }
    if (i % 2 === 1) doc.rect(M, cur.y, W, rowH).fill(C.zebra);
    doc.moveTo(M, cur.y + rowH).lineTo(M + W, cur.y + rowH).lineWidth(0.5).strokeColor(C.hair).stroke();

    txt(doc, fit(doc, w.worker.name, cols[0].w - 14, 'Helvetica-Bold', 8.2), M + 7, cur.y + 5, { size: 8.2, font: 'Helvetica-Bold', color: C.ink });
    txt(doc, w.worker.biostarUserId, M + 7, cur.y + 15.5, { size: 6.6, color: C.faint });

    let x = M + cols[0].w;
    const vals = [
      [w.late, STATUS.late.fg], [w.noCheckout, STATUS['no-checkout'].fg], [w.noShow, STATUS['no-show'].fg], [w.earlyOut, STATUS.late.fg], [w.shifts, C.muted]
    ];
    vals.forEach(([v, color], k) => {
      const col = cols[k + 1];
      txt(doc, v ? String(v) : '-', x, cur.y + 9, { size: 9, font: v ? 'Helvetica-Bold' : 'Helvetica', color: v ? color : C.faint, width: col.w, align: 'center' });
      x += col.w;
    });
    cur.y += rowH;
  });
  cur.y += 22;
}

function detailCols(showDate) {
  const fixed = [
    { key: 'id', label: 'EMPLOYEE ID', w: 66 },
    { key: 'name', label: 'WORKER', w: showDate ? 126 : 170 },
    ...(showDate ? [{ key: 'date', label: 'DATE', w: 48 }] : []),
    { key: 'shift', label: 'SHIFT', w: 50 },
    { key: 'in', label: 'IN', w: 38 },
    { key: 'out', label: 'OUT', w: 38 },
    { key: 'hours', label: 'HRS', w: 36 },
    { key: 'status', label: 'STATUS', w: 66 }
  ];
  const used = fixed.reduce((a, c) => a + c.w, 0);
  fixed.push({ key: 'flags', label: 'FLAGS', w: W - used });
  return fixed;
}

function drawStatusPill(doc, status, x, cy) {
  const st = STATUS[status] || { label: status, fg: C.muted, bg: C.zebra };
  doc.font('Helvetica-Bold').fontSize(6.6);
  const label = safe(st.label);
  const w = doc.widthOfString(label) + 12;
  doc.roundedRect(x, cy - 6.5, w, 13, 6.5).fill(st.bg);
  txt(doc, label, x, cy - 3.3, { size: 6.6, font: 'Helvetica-Bold', color: st.fg, width: w, align: 'center' });
}

function drawDetailRow(doc, y, row, cols, i) {
  const rowH = 24;
  if (i % 2 === 1) doc.rect(M, y, W, rowH).fill(C.zebra);
  doc.moveTo(M, y + rowH).lineTo(M + W, y + rowH).lineWidth(0.5).strokeColor(C.hair).stroke();
  const mid = y + rowH / 2;

  const allFlags = [];
  if (row.changedAfterApproval) allFlags.push('Changed after approval');
  else if (!row.approvedAt) allFlags.push('Not yet approved');
  if (row.lateIn && row.status !== 'late') allFlags.push('Late in');
  if (row.earlyCheckOut) allFlags.push('Early check-out');
  if (row.hasMultiplePunches) allFlags.push('Multiple punches');
  if (row.checkInImplied || row.checkOutImplied) allFlags.push('Implied time');
  // Two lines fit in a row; the rest are summarised.
  const flags = allFlags.length > 2 ? [allFlags[0], `${allFlags[1]} +${allFlags.length - 2}`] : allFlags;
  const sourceNote = row.source === 'exception' ? 'exception' : row.source === 'unscheduled' ? 'unscheduled' : null;

  let x = M;
  for (const col of cols) {
    const inner = col.w - 12;
    const px = x + 7;
    switch (col.key) {
      case 'id':
        txt(doc, fit(doc, row.worker.biostarUserId, inner, 'Helvetica', 7.6), px, mid - 4, { size: 7.6, color: C.muted });
        break;
      case 'name':
        txt(doc, fit(doc, row.worker.name, inner, 'Helvetica-Bold', 8), px, mid - 4.2, { size: 8, font: 'Helvetica-Bold', color: C.ink });
        break;
      case 'date':
        txt(doc, fmtDayShort(dateStrOf(row.date)), px, mid - 4, { size: 7.6, color: C.muted });
        break;
      case 'shift':
        if (sourceNote) {
          txt(doc, row.shift.name, px, mid - 8, { size: 7.8, color: C.ink });
          txt(doc, fit(doc, sourceNote, inner, 'Helvetica', 5.8), px, mid + 1.2, { size: 5.8, color: STATUS.late.fg });
        } else {
          txt(doc, row.shift.name, px, mid - 4, { size: 7.8, color: C.ink });
        }
        break;
      case 'in':
      case 'out': {
        const t = fmtTime(col.key === 'in' ? row.checkIn : row.checkOut);
        txt(doc, t || '-', px, mid - 4, { size: 8, color: t ? C.ink : C.faint });
        break;
      }
      case 'hours': {
        const h = fmtHours(row.hoursWorked);
        txt(doc, h || '-', px, mid - 4, { size: 8, color: h ? C.ink : C.faint });
        break;
      }
      case 'status':
        drawStatusPill(doc, row.status, x + 6, mid);
        break;
      case 'flags':
        flags.forEach((f, k) => {
          const fy = flags.length === 1 ? mid - 3 : mid - 8 + k * 8.4;
          txt(doc, f, px, fy, { size: 6.6, color: STATUS.late.fg });
        });
        break;
      default:
        break;
    }
    x += col.w;
  }
  return rowH;
}

function groupCountsText(rows) {
  const c = countByStatus(rows);
  const bits = [`${rows.length} record${rows.length === 1 ? '' : 's'}`];
  if (c.late) bits.push(`${c.late} late`);
  if (c['no-checkout']) bits.push(`${c['no-checkout']} no checkout`);
  if (c['no-checkin']) bits.push(`${c['no-checkin']} no check-in`);
  if (c['no-show']) bits.push(`${c['no-show']} no-show`);
  return bits.join('  -  ');
}

function drawGroupHeader(doc, y, group, continued) {
  const h = 26;
  doc.rect(M, y, W, h).fill(C.tealSoft);
  doc.rect(M, y, 3.5, h).fill(C.teal);
  const label = continued ? `${group.label} (continued)` : group.label;
  txt(doc, fit(doc, label, W * 0.6, 'Helvetica-Bold', 9), M + 13, y + 8.3, { size: 9, font: 'Helvetica-Bold', color: C.navy });
  txt(doc, groupCountsText(group.rows), M + W * 0.45, y + 9.2, { size: 7.2, color: C.tealDark, width: W * 0.55 - 10, align: 'right' });
  return h;
}

function drawDetail(doc, cur, groups, groupBy) {
  const showDate = groupBy !== 'date';
  const cols = detailCols(showDate);
  const totalRows = groups.reduce((a, g) => a + g.rows.length, 0);

  sectionTitle(doc, cur, 'Detailed records', `${totalRows} row${totalRows === 1 ? '' : 's'}`);

  let activeGroup = null;
  const headerH = 20;
  const rowH = 24;

  // After any page break inside this section: repeat the column header, and
  // the group header so a group split across pages stays labelled.
  cur.onNewPage = () => {
    drawTableHeader(doc, cur.y, cols);
    cur.y += headerH;
    if (activeGroup && activeGroup.label) cur.y += drawGroupHeader(doc, cur.y, activeGroup, true);
  };

  cur.ensure(headerH + 26 + rowH * 2);
  drawTableHeader(doc, cur.y, cols);
  cur.y += headerH;

  groups.forEach((group, gi) => {
    activeGroup = null;
    if (group.label) {
      const needed = 26 + rowH * 2;
      if (cur.y + needed > BOTTOM) {
        doc.addPage();
        cur.y = TOP_NEXT;
        drawTableHeader(doc, cur.y, cols);
        cur.y += headerH;
      }
      cur.y += drawGroupHeader(doc, cur.y, group, false);
    }
    activeGroup = group;

    group.rows.forEach((row, i) => {
      cur.ensure(rowH);
      drawDetailRow(doc, cur.y, row, cols, i);
      cur.y += rowH;
    });
    if (gi < groups.length - 1) cur.y += 8;
  });
  cur.onNewPage = null;
  cur.y += 22;
}

function drawNotes(doc, cur, shifts) {
  const grace = shifts[0]?.graceMinutes ?? 15;
  const shiftLine = shifts.length
    ? shifts.map((s) => `${s.name} ${s.startTime}-${s.endTime}`).join(', ')
    : 'as configured in the portal';
  const items = [
    ['Early', `Checked in more than ${grace} minutes before the shift start.`],
    ['On time', `Checked in within ${grace} minutes either side of the shift start.`],
    ['Late', `Checked in more than ${grace} minutes after the shift start.`],
    ['No checkout', 'A check-in was recorded but no check-out. Late/on-time timing is not classified for these records.'],
    ['No check-in', 'A check-out was recorded but no check-in for that shift.'],
    ['No-show', 'The worker was scheduled for the shift (crew rotation, permanent schedule or a supervisor exception) but has no punches for it.'],
    ['Flags', `"Early check-out" means leaving before the scheduled shift end. "Multiple punches" means extra badges between the check-in and check-out - worth a manual look. "Implied time" is a double shift with no badge at the changeover, split at the scheduled handover. "Unscheduled" shifts were worked outside the worker's schedule.`],
    ['Hours', 'Check-out minus check-in. No meal or break deduction and no overtime rules are applied.'],
    ['Approval', `Records are approved by the crew's supervisor after each shift (escalated to HR and the Admin Assistant after 48 hours), or by HR at month end for permanent staff. Approved records are locked; later changes show as "Changed after approval" until re-approved.`],
    ['Times', `All times are East Africa Time (EAT, UTC+3). Shifts: ${shiftLine}. Night shifts are dated by the evening they start.`]
  ];

  const labelW = 62;
  doc.font('Helvetica').fontSize(7.4);
  const heights = items.map(([, body]) => Math.max(11, doc.heightOfString(safe(body), { width: W - labelW - 28, lineGap: 1.6 })) + 4);
  const boxH = 34 + heights.reduce((a, b) => a + b, 0);

  cur.ensure(boxH + 8);
  doc.roundedRect(M, cur.y, W, boxH, 6).fillAndStroke('#F5F8FA', C.line);
  txt(doc, 'HOW TO READ THIS REPORT', M + 14, cur.y + 12, { size: 7, font: 'Helvetica-Bold', color: C.tealDark, spacing: 1.1 });

  let y = cur.y + 28;
  items.forEach(([label, body], i) => {
    txt(doc, label, M + 14, y, { size: 7.4, font: 'Helvetica-Bold', color: C.ink });
    doc.font('Helvetica').fontSize(7.4).fillColor(C.muted).text(safe(body), M + 14 + labelW, y, { width: W - labelW - 28, lineGap: 1.6 });
    y += heights[i];
  });
  cur.y += boxH + 10;
}

// ---------- per-page chrome (applied after content, once page count is known) ----------

function drawRunningHeader(doc, meta) {
  emblem(doc, M, 18, 18);
  txt(doc, 'Attendance Report', M + 26, 21, { size: 9.5, font: 'Helvetica-Bold', color: C.navy });
  txt(doc, meta.subcontractorName, M + 26, 32, { size: 6.8, color: C.faint });
  const period = meta.from === meta.to ? fmtDay(meta.from) : `${fmtDay(meta.from)}  -  ${fmtDay(meta.to)}`;
  txt(doc, period, M, 24, { size: 8, color: C.muted, width: W, align: 'right' });
  doc.moveTo(M, 46).lineTo(M + W, 46).lineWidth(0.6).strokeColor(C.line).stroke();
}

function drawFooter(doc, meta, page, pages) {
  const y = PAGE_H - 34;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(C.line).stroke();
  txt(doc, `UCAA Casuals  |  Attendance Report  |  ${meta.subcontractorName}`, M, y + 8, { size: 7, color: C.muted });
  txt(doc, `Confidential - generated ${fmtStamp(meta.generatedAt)}`, M, y + 18, { size: 6.4, color: C.faint });
  txt(doc, `Page ${page} of ${pages}`, M, y + 8, { size: 7.5, font: 'Helvetica-Bold', color: C.navy, width: W, align: 'right' });
}

// ---------- public API ----------

/**
 * @param {object}   opts
 * @param {Array}    opts.rows    DailyAttendanceSummary rows (worker/shift included)
 * @param {Array}    opts.shifts  Shift rows, for the legend and shift split
 * @param {object}   opts.meta    { subcontractorName, from, to (YYYY-MM-DD), generatedAt: Date,
 *                                  filters: { id, name }, sortBy, groupBy }
 * @returns {PDFDocument} an ended document — pipe it to the response
 */
function buildAttendanceReport({ rows, shifts, meta }) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    bufferPages: true,
    info: {
      Title: `Attendance Report ${meta.from} to ${meta.to}`,
      Author: 'UCAA Casuals Attendance Portal',
      Subject: `Casuals attendance for ${meta.subcontractorName}`,
      Creator: 'UCAA Casuals Attendance Portal'
    }
  });

  const sorted = sortRows(rows, meta.sortBy);
  const groups = groupRows(sorted, meta.groupBy);
  const stats = computeStats(sorted);
  const cur = makeCursor(doc);

  const bandBottom = drawBand(doc, meta);

  const chips = [`${stats.total} records`, `${stats.workers} workers`, `${stats.days.length} day${stats.days.length === 1 ? '' : 's'}`];
  if (meta.filters.id) chips.push(`Employee ID contains "${meta.filters.id}"`);
  if (meta.filters.name) chips.push(`Name contains "${meta.filters.name}"`);
  chips.push(GROUP_LABELS[meta.groupBy], `Ordered by: ${SORT_LABELS[meta.sortBy]}`);

  let y = drawChips(doc, bandBottom + 16, chips) + 18;
  y = drawKpis(doc, y, stats) + 26;
  cur.y = y;

  drawStatusBreakdown(doc, cur, stats, shifts);
  drawDailyChart(doc, cur, stats);
  drawAttention(doc, cur, stats);
  drawDetail(doc, cur, groups, meta.groupBy);
  drawNotes(doc, cur, shifts);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    if (i > 0) drawRunningHeader(doc, meta);
    drawFooter(doc, meta, i + 1, range.count);
  }

  doc.end();
  return doc;
}

module.exports = { buildAttendanceReport, SORT_LABELS, GROUP_LABELS };
