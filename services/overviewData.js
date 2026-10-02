// Loads what reports/overview.js needs for a date range: shift records (as
// the viewer may see them), approval batches and crews.

const prisma = require('../prismaClient');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOnly = (s) => new Date(`${s}T00:00:00.000Z`);

// Every "YYYY-MM" month wholly inside [from, to] — its HR monthly batch
// belongs to the period.
function wholeMonths(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (first > to) break;
    if (first >= from && last <= to) out.push(first.slice(0, 7));
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

// visibility: extra conditions on the rows (summaryVisibility(user)), which
// also carries the subcontractor.
async function loadPeriod({ subcontractorName, visibility = {}, from, to }) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('Bad date range.');
  const months = wholeMonths(from, to);
  const [rows, units, crews] = await Promise.all([
    prisma.dailyAttendanceSummary.findMany({
      where: { date: { gte: dateOnly(from), lte: dateOnly(to) }, worker: { subcontractorName }, ...visibility },
      select: {
        id: true, date: true, status: true, hoursWorked: true, lateIn: true, earlyCheckOut: true,
        approvalCrewId: true, approvedAt: true, changedAfterApproval: true,
        worker: { select: { id: true } }, shift: { select: { name: true } }
      }
    }),
    prisma.approvalUnit.findMany({
      where: {
        subcontractorName,
        OR: [
          { kind: 'crew-shift', date: { gte: dateOnly(from), lte: dateOnly(to) } },
          ...(months.length ? [{ kind: 'hr-month', month: { in: months } }] : [])
        ]
      }
    }),
    prisma.crew.findMany({ where: { subcontractorName }, select: { id: true, name: true } })
  ]);
  return { rows, units, crews };
}

module.exports = { loadPeriod, wholeMonths };
