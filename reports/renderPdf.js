// Report model -> PDF, in the same visual style as the dashboard's attendance
// report (reports/attendancePdf.js): navy title band, key-figure cards, then
// each section as a table with a repeating header, banded rows, status pills
// and a totals line. Wide reports (the register, detailed records) are laid
// out landscape.

const PDFDocument = require('pdfkit');
const { C, STATUS, safe, txt, fit, emblem } = require('./attendancePdf');
const { formatCell, generatedStamp, dayMark, DAY_MARK_COLOR } = require('./reportFormat');

const M = 36;
const TONE = { navy: C.navy2, teal: C.teal, ok: STATUS['on-time'].bar, warn: STATUS.late.bar, grey: STATUS['no-checkout'].bar, critical: STATUS['no-show'].bar };
const CODE = { D: ['#9A5B00', '#FFF3D6'], N: ['#4338CA', '#E9EBFD'], DN: [C.tealDark, C.tealSoft], A: ['#B3362A', '#FBE5E2'] };
const NUMERIC = new Set(['hours', 'int', 'pct', 'minutes', 'time', 'code']);

function layout(landscape) {
  const pageW = landscape ? 841.89 : 595.28;
  const pageH = landscape ? 595.28 : 841.89;
  return { pageW, pageH, W: pageW - M * 2, bottom: pageH - 46, topNext: 58 };
}

function drawBand(doc, L, model, meta) {
  const h = 104;
  doc.rect(0, 0, L.pageW, h).fill(C.navy);
  doc.save();
  doc.rect(0, 0, L.pageW, h).clip();
  doc.opacity(0.1).circle(L.pageW - 30, -10, 110).fill(C.teal);
  doc.opacity(0.06).circle(L.pageW - 120, h + 30, 80).fill(C.teal);
  doc.restore();
  doc.rect(0, h, L.pageW, 3).fill(C.teal);

  emblem(doc, M, 26, 36);
  txt(doc, meta.orgName.toUpperCase(), M + 48, 27, { size: 7, font: 'Helvetica-Bold', color: '#7FC4B4', spacing: 1.2 });
  const rightW = 230;
  const leftW = L.W - 48 - rightW - 16;
  // Shrink a long title before resorting to an ellipsis.
  let titleSize = 21;
  while (titleSize > 15 && doc.font('Helvetica-Bold').fontSize(titleSize).widthOfString(safe(model.title)) > leftW) titleSize -= 0.5;
  txt(doc, fit(doc, model.title, leftW, 'Helvetica-Bold', titleSize), M + 48, 38 + (21 - titleSize) / 2, { size: titleSize, font: 'Helvetica-Bold', color: C.white });
  txt(doc, fit(doc, model.subtitle || `Subcontractor: ${meta.subcontractorName}`, leftW, 'Helvetica', 9.5), M + 48, 67, { size: 9.5, color: C.onBand });

  const rx = L.pageW - M - rightW;
  txt(doc, 'REPORT PERIOD', rx, 30, { size: 7, font: 'Helvetica-Bold', color: '#7FC4B4', spacing: 1.2, width: rightW, align: 'right' });
  txt(doc, fit(doc, model.period.label, rightW, 'Helvetica-Bold', 12), rx, 42, { size: 12, font: 'Helvetica-Bold', color: C.white, width: rightW, align: 'right' });
  txt(doc, `Generated ${generatedStamp(meta.generatedAt)}`, rx, 62, { size: 7.8, color: C.onBand, width: rightW, align: 'right' });
  txt(doc, fit(doc, `by ${meta.generatedBy}`, rightW, 'Helvetica', 7.8), rx, 73, { size: 7.8, color: C.onBand, width: rightW, align: 'right' });
  return h + 3;
}

function drawChips(doc, L, y, chips) {
  let x = M;
  let rowY = y;
  doc.font('Helvetica').fontSize(7.5);
  for (const chip of chips) {
    const label = safe(chip);
    const w = doc.widthOfString(label) + 16;
    if (x + w > M + L.W) { x = M; rowY += 22; }
    doc.roundedRect(x, rowY, w, 16, 8).fill('#EEF2F6');
    txt(doc, label, x + 8, rowY + 4.4, { size: 7.5, color: C.muted });
    x += w + 6;
  }
  return rowY + 16;
}

function drawKpis(doc, L, y, kpis) {
  const per = L.W > 700 ? 6 : 4;
  const gap = 9;
  const cw = (L.W - gap * (per - 1)) / per;
  const ch = 56;
  kpis.forEach((k, i) => {
    const x = M + (i % per) * (cw + gap);
    const cy = y + Math.floor(i / per) * (ch + gap);
    doc.roundedRect(x, cy, cw, ch, 5).fillAndStroke(C.white, C.line);
    doc.save();
    doc.roundedRect(x, cy, cw, ch, 5).clip();
    doc.rect(x, cy, 3.5, ch).fill(TONE[k.tone] || C.teal);
    doc.restore();
    txt(doc, fit(doc, k.label.toUpperCase(), cw - 20 - k.label.length * 0.8, 'Helvetica-Bold', 6.4), x + 12, cy + 9, { size: 6.4, font: 'Helvetica-Bold', color: C.muted, spacing: 0.8 });
    txt(doc, fit(doc, k.value, cw - 20, 'Helvetica-Bold', 18), x + 12, cy + 20, { size: 18, font: 'Helvetica-Bold', color: C.navy });
    txt(doc, fit(doc, k.sub || '', cw - 20, 'Helvetica', 6.6), x + 12, cy + 43, { size: 6.6, color: C.faint });
  });
  const rows = Math.ceil(kpis.length / per);
  return y + rows * ch + (rows - 1) * gap;
}

function makeCursor(doc, L) {
  const cur = { y: 0, onNewPage: null };
  cur.ensure = (h) => {
    if (cur.y + h <= L.bottom) return false;
    doc.addPage();
    cur.y = L.topNext;
    if (cur.onNewPage) cur.onNewPage();
    return true;
  };
  return cur;
}

function sectionTitle(doc, L, cur, title, note) {
  cur.ensure(60);
  doc.rect(M, cur.y + 1, 3, 11).fill(C.teal);
  txt(doc, fit(doc, title, L.W * 0.5, 'Helvetica-Bold', 11), M + 10, cur.y, { size: 11, font: 'Helvetica-Bold', color: C.navy });
  if (note) {
    const tw = doc.font('Helvetica-Bold').fontSize(11).widthOfString(safe(fit(doc, title, L.W * 0.5, 'Helvetica-Bold', 11)));
    txt(doc, fit(doc, note, L.W - tw - 20, 'Helvetica', 7.5), M + 10 + tw + 8, cur.y + 2.5, { size: 7.5, color: C.faint });
  }
  cur.y += 20;
}

function columnWidths(cols, W) {
  const total = cols.reduce((a, c) => a + (c.width || 1), 0);
  return cols.map((c) => ((c.width || 1) / total) * W);
}

// A header label on one line, or split over two when it doesn't fit.
function headerLines(doc, label, width, size) {
  const text = safe(label.toUpperCase());
  doc.font('Helvetica-Bold').fontSize(size);
  if (doc.widthOfString(text) <= width || !text.includes(' ')) return [fit(doc, text, width, 'Helvetica-Bold', size)];
  const words = text.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const worst = Math.max(doc.widthOfString(a), doc.widthOfString(b));
    if (!best || worst < best.worst) best = { a, b, worst };
  }
  return [fit(doc, best.a, width, 'Helvetica-Bold', size), fit(doc, best.b, width, 'Helvetica-Bold', size)];
}

function drawHeader(doc, y, cols, widths, h, size) {
  const W = widths.reduce((a, b) => a + b, 0);
  doc.rect(M, y, W, h).fill(C.navy2);
  let x = M;
  cols.forEach((c, i) => {
    const w = widths[i];
    const align = NUMERIC.has(c.type) || c.type === 'status' ? 'center' : 'left';
    if (c.type === 'code') {
      const [a, b] = c.label.split(' ');
      txt(doc, a, x, y + 4, { size: size, font: 'Helvetica-Bold', color: '#E3E9F0', width: w, align: 'center' });
      txt(doc, b || '', x, y + 4 + size + 2, { size: size - 1, color: '#9FB0C4', width: w, align: 'center' });
    } else {
      const pad = w > 30 ? 5 : 2;
      // A single word that still doesn't fit is shrunk (down to 5pt) before it is cut.
      let hs = size - 0.8;
      const label = safe(c.label.toUpperCase());
      while (!label.includes(' ') && hs > 5 && doc.font('Helvetica-Bold').fontSize(hs).widthOfString(label) > w - pad * 2) hs -= 0.2;
      const lines = headerLines(doc, c.label, w - pad * 2, hs);
      const top = y + h / 2 - (lines.length * (hs + 1.8)) / 2 + 0.8;
      lines.forEach((ln, k) => txt(doc, ln, x + pad, top + k * (hs + 1.8), { size: hs, font: 'Helvetica-Bold', color: '#C7D2DF', width: w - pad * 2, align }));
    }
    x += w;
  });
}

// Status column tags: Late in / Early out only.
const TAG_PILL = {
  'late-in': { label: 'Late in', fg: STATUS.late.fg, bg: STATUS.late.bg },
  'early-out': { label: 'Early out', fg: STATUS['no-show'].fg, bg: STATUS['no-show'].bg }
};
const PILL_H = 12;
const PILL_GAP = 2.5;

// One pill per tag, stacked and centred in the cell.
function drawStatusTags(doc, raw, x, w, cy, size) {
  const tags = String(raw).split(',').filter(Boolean);
  const top = cy - (tags.length * PILL_H + (tags.length - 1) * PILL_GAP) / 2 + PILL_H / 2;
  tags.forEach((t, i) => drawStatusPill(doc, t, x, w, top + i * (PILL_H + PILL_GAP), size));
}

function drawStatusPill(doc, status, x, w, cy, size) {
  const st = TAG_PILL[status] || STATUS[status] || { label: status, fg: C.muted, bg: C.zebra };
  doc.font('Helvetica-Bold').fontSize(size - 1);
  const label = safe(st.label);
  const pw = Math.min(w - 4, doc.widthOfString(label) + 10);
  const px = x + (w - pw) / 2;
  doc.roundedRect(px, cy - 6, pw, 12, 6).fill(st.bg);
  txt(doc, fit(doc, st.label, pw - 4, 'Helvetica-Bold', size - 1), px, cy - (size - 1) / 2 + 0.3, { size: size - 1, font: 'Helvetica-Bold', color: st.fg, width: pw, align: 'center' });
}

// Long text cells wrap onto as many slightly smaller lines as they need —
// the row grows to fit, so nothing is cut off. Returns { lines, size }.
const LINE_GAP = 1.8;
function wrapText(doc, text, width, font, size) {
  const s = safe(text);
  doc.font(font).fontSize(size);
  if (doc.widthOfString(s) <= width) return { lines: [s], size };
  const small = size - 1.2;
  doc.fontSize(small);
  const lines = [];
  let line = '';
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (doc.widthOfString(next) <= width) { line = next; continue; }
    if (line) lines.push(line);
    // A single word wider than the column is broken by characters.
    let rest = word;
    while (doc.widthOfString(rest) > width && rest.length > 1) {
      let n = rest.length - 1;
      while (n > 1 && doc.widthOfString(rest.slice(0, n)) > width) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return { lines, size: small };
}

// Height a row needs so every wrapped text cell fits (at least `base`).
function rowHeight(doc, cols, widths, row, size, base) {
  let h = base;
  cols.forEach((c, i) => {
    if (c.type === 'status') {
      const n = String(row[c.key] || '').split(',').filter(Boolean).length;
      if (n > 1) h = Math.max(h, n * PILL_H + (n - 1) * PILL_GAP + 6);
      return;
    }
    if (c.type !== 'text') return;
    const w = widths[i];
    const pad = w > 30 ? 5 : 1;
    const font = c.key === 'worker' ? 'Helvetica-Bold' : 'Helvetica';
    const { lines, size: fs } = wrapText(doc, formatCell(c, row[c.key], { blank: '-' }), w - pad * 2, font, size);
    h = Math.max(h, lines.length * (fs + LINE_GAP) + 7);
  });
  return Math.ceil(h);
}

function drawRow(doc, y, cols, widths, row, { h, size, zebra, totals }) {
  const W = widths.reduce((a, b) => a + b, 0);
  if (totals) {
    doc.rect(M, y, W, h).fill(C.tealSoft);
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor(C.teal).stroke();
  } else if (zebra) {
    doc.rect(M, y, W, h).fill(C.zebra);
  }
  doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.5).strokeColor(C.hair).stroke();
  const mid = y + h / 2;

  let x = M;
  cols.forEach((c, i) => {
    const w = widths[i];
    const raw = row[c.key];
    const pad = w > 30 ? 5 : 1;
    if (c.type === 'status') {
      if (!totals && raw) drawStatusTags(doc, raw, x, w, mid, size); // blank when neither applies
    } else if (!totals && c.type === 'code') {
      if (raw) {
        // N+ / +D (a double shift across midnight) share the DN colours.
        const [fg, bg] = CODE[raw.includes('+') ? 'DN' : raw] || [C.muted, C.zebra];
        doc.roundedRect(x + 1.5, y + 2, w - 3, h - 4, 2).fill(bg);
        txt(doc, raw, x, mid - (size - 1) / 2, { size: size - 1, font: 'Helvetica-Bold', color: fg, width: w, align: 'center' });
      }
    } else {
      let text = totals && i === 0 && raw == null ? 'TOTAL' : formatCell(c, raw, { blank: totals ? '' : '-' });
      const bold = totals || c.key === 'worker';
      const font = bold ? 'Helvetica-Bold' : 'Helvetica';
      const color = totals ? C.navy : text === '-' ? C.faint : c.type === 'id' ? C.muted : C.ink;
      const align = NUMERIC.has(c.type) ? 'center' : 'left';
      if (c.type === 'text' && !totals) {
        const { lines, size: fs } = wrapText(doc, text, w - pad * 2, font, size);
        const top = mid - (lines.length * (fs + LINE_GAP)) / 2 + LINE_GAP / 2 + 0.3;
        lines.forEach((ln, k) => txt(doc, ln, x + pad, top + k * (fs + LINE_GAP), { size: fs, font, color, width: w - pad * 2, align }));
      } else if (!totals && dayMark(row, c.key)) {
        // Time then a blue "(+1)", centred together; shrinks to fit like below.
        const mark = dayMark(row, c.key);
        const head = (fs) => doc.font(font).fontSize(fs).widthOfString(safe(`${text} `));
        const both = (fs) => head(fs) + doc.font('Helvetica-Bold').fontSize(fs).widthOfString(mark);
        let fs = size;
        while (fs > size - 2.5 && both(fs) > w - pad * 2) fs -= 0.25;
        const tw = head(fs);
        const x0 = x + Math.max(pad, (w - both(fs)) / 2);
        txt(doc, text, x0, mid - fs / 2 + 0.5, { size: fs, font, color });
        txt(doc, mark, x0 + tw, mid - fs / 2 + 0.5, { size: fs, font: 'Helvetica-Bold', color: DAY_MARK_COLOR });
      } else {
        // Numbers and dates shrink a little to fit rather than lose digits.
        let fs = size;
        while (fs > size - 2.5 && doc.font(font).fontSize(fs).widthOfString(safe(text)) > w - pad * 2) fs -= 0.25;
        text = fit(doc, text, w - pad * 2, font, fs);
        txt(doc, text, x + pad, mid - fs / 2 + 0.5, { size: fs, font, color, width: w - pad * 2, align });
      }
    }
    x += w;
  });
}

const GROUP_H = 22;
function drawGroupRow(doc, L, y, group, continued) {
  doc.rect(M, y, L.W, GROUP_H).fill(C.tealSoft);
  doc.rect(M, y, 3.5, GROUP_H).fill(C.teal);
  const label = continued ? `${group._group} (continued)` : group._group;
  const lw = Math.min(L.W * 0.5, doc.font('Helvetica-Bold').fontSize(8.8).widthOfString(safe(label)) + 4);
  txt(doc, fit(doc, label, L.W * 0.5, 'Helvetica-Bold', 8.8), M + 12, y + 7, { size: 8.8, font: 'Helvetica-Bold', color: C.navy });
  if (group._groupNote) {
    txt(doc, fit(doc, group._groupNote, L.W - lw - 30, 'Helvetica', 7.4), M + 12 + lw + 10, y + 8, { size: 7.4, color: C.tealDark });
  }
  return GROUP_H;
}

function drawSection(doc, L, cur, section) {
  sectionTitle(doc, L, cur, section.title, section.note);
  // With group headers (e.g. one per worker) the columns that repeat the
  // group's label are dropped — the header already says it.
  const grouped = section.rows.some((r) => r._group);
  const cols = grouped ? section.columns.filter((c) => !c.hideInGroups) : section.columns;
  const widths = columnWidths(cols, L.W);
  const dense = cols.length > 14;
  const size = dense ? 6.4 : cols.length > 10 ? 7 : 7.6;
  const hasCode = cols.some((c) => c.type === 'code');
  const wraps = cols.some((c, i) => c.type !== 'code' && headerLines(doc, c.label, widths[i] - (widths[i] > 30 ? 10 : 4), size - 0.8).length > 1);
  const headH = hasCode || wraps ? 24 : 20;
  const rowH = dense ? 15 : 18;

  if (section.rows.length === 0) {
    txt(doc, 'No records for this period.', M, cur.y, { size: 8, color: C.faint });
    cur.y += 26;
    return;
  }

  cur.ensure(headH + rowH * 2);
  drawHeader(doc, cur.y, cols, widths, headH, size);
  cur.y += headH;
  // Set after the first header so a break right here doesn't draw it twice.
  // A group split across pages gets its header repeated, marked continued.
  let activeGroup = null;
  cur.onNewPage = () => {
    drawHeader(doc, cur.y, cols, widths, headH, size);
    cur.y += headH;
    if (activeGroup) cur.y += drawGroupRow(doc, L, cur.y, activeGroup, true);
  };

  let stripe = 0;
  section.rows.forEach((row) => {
    if (row._group) {
      activeGroup = null;
      cur.ensure(GROUP_H + rowH * 2); // keep a group header with its first rows
      cur.y += drawGroupRow(doc, L, cur.y, row, false);
      activeGroup = row;
      stripe = 0;
      return;
    }
    const h = rowHeight(doc, cols, widths, row, size, rowH);
    cur.ensure(h);
    drawRow(doc, cur.y, cols, widths, row, { h, size, zebra: stripe++ % 2 === 1 });
    cur.y += h;
  });
  if (section.totals) {
    cur.ensure(rowH + 2);
    drawRow(doc, cur.y, cols, widths, section.totals, { h: rowH + 2, size, totals: true });
    cur.y += rowH + 2;
  }
  cur.onNewPage = null;
  cur.y += 22;
}

function drawNotes(doc, L, cur, notes) {
  if (!notes?.length) return;
  doc.font('Helvetica').fontSize(7.4);
  const heights = notes.map((n) => doc.heightOfString(safe(n), { width: L.W - 28, lineGap: 1.6 }) + 4);
  const boxH = 30 + heights.reduce((a, b) => a + b, 0);
  cur.ensure(boxH + 8);
  doc.roundedRect(M, cur.y, L.W, boxH, 6).fillAndStroke('#F5F8FA', C.line);
  txt(doc, 'HOW TO READ THIS REPORT', M + 14, cur.y + 11, { size: 7, font: 'Helvetica-Bold', color: C.tealDark, spacing: 1.1 });
  let y = cur.y + 25;
  notes.forEach((n, i) => {
    doc.font('Helvetica').fontSize(7.4).fillColor(C.muted).text(safe(n), M + 14, y, { width: L.W - 28, lineGap: 1.6 });
    y += heights[i];
  });
  cur.y += boxH + 10;
}

function drawRunningHeader(doc, L, model, meta) {
  emblem(doc, M, 18, 18);
  txt(doc, fit(doc, model.title, L.W * 0.55, 'Helvetica-Bold', 9.5), M + 26, 21, { size: 9.5, font: 'Helvetica-Bold', color: C.navy });
  txt(doc, fit(doc, model.subtitle || meta.subcontractorName, L.W * 0.55, 'Helvetica', 6.8), M + 26, 32, { size: 6.8, color: C.faint });
  txt(doc, model.period.label, M, 24, { size: 8, color: C.muted, width: L.W, align: 'right' });
  doc.moveTo(M, 46).lineTo(M + L.W, 46).lineWidth(0.6).strokeColor(C.line).stroke();
}

function drawFooter(doc, L, model, meta, page, pages) {
  const y = L.pageH - 34;
  doc.moveTo(M, y).lineTo(M + L.W, y).lineWidth(0.6).strokeColor(C.line).stroke();
  txt(doc, `${meta.orgName}  |  ${model.title}  |  ${meta.subcontractorName}`, M, y + 8, { size: 7, color: C.muted });
  const stampLine = meta.download
    ? `Confidential - downloaded by ${meta.download.by} on ${meta.download.atText} - Ref ${meta.download.ref}`
    : `Confidential - generated ${generatedStamp(meta.generatedAt)}`;
  txt(doc, fit(doc, stampLine, L.W - 70, 'Helvetica', 6.4), M, y + 18, { size: 6.4, color: C.faint });
  txt(doc, `Page ${page} of ${pages}`, M, y + 8, { size: 7.5, font: 'Helvetica-Bold', color: C.navy, width: L.W, align: 'right' });
}

/**
 * @returns {PDFDocument} an ended document — pipe it to the response
 */
function renderPdf(model, meta) {
  const landscape = !!model.landscape || model.sections.some((s) => s.columns.length >= 11);
  const L = layout(landscape);
  const doc = new PDFDocument({
    size: 'A4',
    layout: landscape ? 'landscape' : 'portrait',
    margin: 0,
    bufferPages: true,
    info: {
      Title: `${model.title} - ${model.period.label}`,
      Author: meta.orgName,
      Creator: 'UCAA Casuals Attendance Portal',
      ...(meta.download ? { Subject: meta.download.text, Keywords: `download-ref:${meta.download.ref}` } : {})
    }
  });
  const cur = makeCursor(doc, L);

  const bandBottom = drawBand(doc, L, model, meta);
  const chips = [model.period.from === model.period.to ? model.period.from : `${model.period.from} to ${model.period.to}`];
  if (meta.scopeNote) chips.push(meta.scopeNote);
  chips.push(...(meta.filters || []));
  let y = drawChips(doc, L, bandBottom + 14, chips) + 16;
  if (model.kpis?.length) y = drawKpis(doc, L, y, model.kpis) + 24;
  cur.y = y;

  for (const section of model.sections) drawSection(doc, L, cur, section);
  if (model.sections.length === 0) {
    txt(doc, 'No records for this period.', M, cur.y, { size: 9, color: C.faint });
    cur.y += 30;
  }
  drawNotes(doc, L, cur, model.notes);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    if (i > 0) drawRunningHeader(doc, L, model, meta);
    drawFooter(doc, L, model, meta, i + 1, range.count);
  }
  doc.end();
  return doc;
}

module.exports = { renderPdf };
