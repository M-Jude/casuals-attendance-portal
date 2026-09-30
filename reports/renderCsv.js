// Report model -> CSV laid out to read well when opened in Excel or Google
// Sheets: a title block, the key figures, then each section as its own
// labelled table with a TOTAL line, separated by blank rows. Values are
// formatted for people (times in EAT, "On time", "12.50") rather than raw
// database values. UTF-8 with a BOM and CRLF line ends so Excel opens it
// with the right encoding.

const { formatCell, generatedStamp } = require('./reportFormat');

function esc(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const line = (cells) => cells.map(esc).join(',');

function renderCsv(model, meta) {
  const out = [];
  const blank = () => out.push('');

  out.push(line([meta.orgName.toUpperCase()]));
  out.push(line([model.title.toUpperCase()]));
  if (model.subtitle) out.push(line([model.subtitle]));
  blank();
  out.push(line(['Period', model.period.label]));
  out.push(line(['Dates', `${model.period.from} to ${model.period.to}`]));
  out.push(line(['Subcontractor', meta.subcontractorName]));
  out.push(line(['Generated', `${generatedStamp(meta.generatedAt)} by ${meta.generatedBy}`]));
  if (meta.download) {
    out.push(line(['Downloaded by', meta.download.by]));
    out.push(line(['Downloaded at', meta.download.atText]));
    out.push(line(['Download reference', meta.download.ref]));
  }
  if (meta.scopeNote) out.push(line(['Scope', meta.scopeNote]));
  for (const f of meta.filters || []) out.push(line(['Filter', f]));

  if (model.kpis?.length) {
    blank();
    out.push(line(['KEY FIGURES']));
    for (const k of model.kpis) out.push(line([k.label, k.value, k.sub || '']));
  }

  for (const section of model.sections) {
    blank();
    out.push(line([`${section.title.toUpperCase()}${section.note ? `  (${section.note})` : ''}`]));
    out.push(line(section.columns.map((c) => c.label)));
    if (section.rows.length === 0) {
      out.push(line(['No records.']));
      continue;
    }
    section.rows.forEach((row, i) => {
      // Group header (e.g. one per worker): a blank line, then the label.
      if (row._group) {
        if (i > 0) blank();
        out.push(line([row._group, row._groupNote || '']));
        return;
      }
      out.push(line(section.columns.map((c) => formatCell(c, row[c.key]))));
    });
    if (section.totals) {
      out.push(line(section.columns.map((c, i) => {
        const v = section.totals[c.key];
        if (i === 0 && v == null) return 'TOTAL';
        return formatCell(c, v);
      })));
    }
  }

  if (model.notes?.length) {
    blank();
    out.push(line(['NOTES']));
    for (const n of model.notes) out.push(line([n]));
  }

  return `﻿${out.join('\r\n')}\r\n`;
}

module.exports = { renderCsv };
