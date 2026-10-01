// Aggregates DailyAttendanceSummary rows (the same shape GET /api/attendance/summary
// returns) into portal-facing analytics. Deliberately mirrors computeStats() in
// reports/attendancePdf.js field-for-field, so the on-screen analytics panel and
// the downloaded PDF report always agree on the same numbers for the same rows —
// keep the two in sync if either changes.

import { doubleShiftRuns, countDoubleShifts } from './doubleShift';

export const STATUS_ORDER = ['on-time', 'early', 'late', 'no-checkout', 'no-checkin', 'no-show', 'in-progress'];

const dateStrOf = (row) => row.date.slice(0, 10);

export function computeAnalytics(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
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
    if (counts[r.status] !== undefined) counts[r.status]++;
    workers.add(r.worker.id);

    const d = dateStrOf(r);
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
    doubleShifts: countDoubleShifts(doubleShiftRuns(rows)),
    byShift,
    days: [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    attention
  };
}

export const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
