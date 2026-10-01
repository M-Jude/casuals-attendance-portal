// Cell formatting shared by the CSV and PDF renderers (the Excel renderer
// writes typed values with number formats instead). See reportCatalog.js for
// the column types.

const { TAG_LABEL, fmtDay, weekdayOf, eatClock } = require('./reportCatalog');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDateTime(ts) {
  const d = new Date(new Date(ts).getTime() + 3 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 16)}`;
}

// `blank` is what an empty value prints as.
function formatCell(col, value, { blank = '' } = {}) {
  if (value == null || value === '') return blank;
  switch (col.type) {
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${weekdayOf(value).slice(0, 3)} ${fmtDay(value)}` : String(value);
    case 'time':
      return value instanceof Date || typeof value === 'number' || /T/.test(String(value)) ? eatClock(value) : String(value);
    case 'datetime':
      return fmtDateTime(value);
    case 'hours':
      return typeof value === 'number' ? value.toFixed(2) : String(value);
    case 'pct':
      return typeof value === 'number' ? `${value.toFixed(value % 1 ? 1 : 0)}%` : String(value);
    case 'minutes':
      return typeof value === 'number' ? `${value} min` : String(value);
    case 'status':
      // Late in / Early out tags (see statusTags in reportCatalog.js).
      return String(value).split(',').map((k) => TAG_LABEL[k] || k).join(' · ');
    default:
      return String(value);
  }
}

// "(+1)" after a clock-out on a later day than the line's date (a double
// shift, see withNextDayOut in reportCatalog.js); '' otherwise. Renderers
// that can colour it show it in DAY_MARK_COLOR.
const DAY_MARK_COLOR = '#1D4ED8';
function dayMark(row, key) {
  const n = row?._dayOffset?.[key];
  return n ? `(+${n})` : '';
}

function generatedStamp(date) {
  return `${fmtDateTime(date)} EAT`;
}

module.exports = { formatCell, fmtDateTime, generatedStamp, dayMark, DAY_MARK_COLOR };
