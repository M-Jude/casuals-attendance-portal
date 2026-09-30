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

function generatedStamp(date) {
  return `${fmtDateTime(date)} EAT`;
}

module.exports = { formatCell, fmtDateTime, generatedStamp };
