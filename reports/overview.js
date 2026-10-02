// The figures behind the Overview page and the Director's weekly digest:
// headcount, shifts and hours (by crew and Day/Night), attendance quality
// and approval discipline. Pure, no database: the route and the digest job
// load the rows.

const { doubleShiftRuns } = require('./doubleShift');
const { escalationDueAt } = require('../sync/approvalLogic');

const HR_LABEL = 'Permanent staff';
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

// A shift someone turned up for (in progress or finished, punches complete or not).
const worked = (r) => r.status !== 'no-show';

/**
 * rows   — DailyAttendanceSummary rows with { id, date, status, hoursWorked,
 *          lateIn, earlyCheckOut, approvalCrewId, approvedAt,
 *          changedAfterApproval, worker: { id }, shift: { name } }
 * units  — ApprovalUnits for the period
 * crews  — [{ id, name }]
 */
function computeOverview({ rows, units = [], crews = [], now = Date.now() }) {
  const crewName = new Map(crews.map((c) => [c.id, c.name]));
  const done = rows.filter(worked);

  const totals = {
    workers: new Set(done.map((r) => r.worker.id)).size,
    shiftsWorked: done.length,
    dayShifts: done.filter((r) => r.shift.name === 'Day').length,
    nightShifts: done.filter((r) => r.shift.name === 'Night').length,
    hours: round1(done.reduce((sum, r) => sum + (r.hoursWorked || 0), 0)),
    noShows: rows.length - done.length,
    late: rows.filter((r) => r.lateIn).length,
    earlyOut: rows.filter((r) => r.earlyCheckOut).length,
    missingPunch: rows.filter((r) => r.status === 'no-checkout' || r.status === 'no-checkin').length,
    doubleShifts: new Set([...doubleShiftRuns(done).values()].map((run) => run.id)).size,
    approvedShifts: done.filter((r) => r.approvedAt).length,
    changedAfterApproval: rows.filter((r) => r.changedAfterApproval).length
  };
  totals.attendanceRate = pct(totals.shiftsWorked, rows.length);
  totals.pendingShifts = totals.shiftsWorked - totals.approvedShifts;

  // By crew (the crew whose supervisor approves; none = permanent staff).
  const byCrewMap = new Map();
  for (const r of rows) {
    const key = r.approvalCrewId ?? 'hr';
    if (!byCrewMap.has(key)) byCrewMap.set(key, { crew: r.approvalCrewId ? (crewName.get(r.approvalCrewId) || `Crew #${r.approvalCrewId}`) : HR_LABEL, workers: new Set(), shifts: 0, hours: 0, noShows: 0, late: 0 });
    const c = byCrewMap.get(key);
    if (worked(r)) { c.shifts++; c.hours += r.hoursWorked || 0; c.workers.add(r.worker.id); } else c.noShows++;
    if (r.lateIn) c.late++;
  }
  const byCrew = [...byCrewMap.values()]
    .map((c) => ({ ...c, workers: c.workers.size, hours: round1(c.hours), attendanceRate: pct(c.shifts, c.shifts + c.noShows) }))
    .sort((a, b) => (a.crew === HR_LABEL) - (b.crew === HR_LABEL) || a.crew.localeCompare(b.crew));

  // Approval discipline: approved within the 48h before escalation = on time.
  const due = units.filter((u) => new Date(u.dueAt).getTime() <= now);
  const approved = due.filter((u) => u.status === 'approved' && u.approvedAt);
  const approvals = {
    batches: due.length,
    approved: approved.length,
    approvedOnTime: approved.filter((u) => u.kind !== 'crew-shift' || new Date(u.approvedAt) <= escalationDueAt(u)).length,
    waiting: due.filter((u) => u.status !== 'approved').length,
    escalated: due.filter((u) => u.escalatedAt).length,
    reopened: due.filter((u) => u.status === 'reopened').length
  };
  approvals.onTimeRate = pct(approvals.approvedOnTime, approvals.approved);

  return { totals, byCrew, approvals };
}

// Change from the previous period, for the headline figures.
function compare(current, previous) {
  const keys = ['workers', 'shiftsWorked', 'hours', 'noShows', 'late', 'earlyOut', 'missingPunch', 'doubleShifts', 'attendanceRate'];
  return Object.fromEntries(keys.map((k) => {
    const a = current.totals[k];
    const b = previous.totals[k];
    return [k, a === null || b === null || b === undefined ? null : round1(a - b)];
  }));
}

// Things worth a look, in words.
function attention(overview, change) {
  const out = [];
  const { totals, approvals } = overview;
  if (approvals.escalated) out.push(`${approvals.escalated} approval batch${approvals.escalated === 1 ? ' was' : 'es were'} escalated to HR (not approved within 48 hours).`);
  if (approvals.waiting) out.push(`${approvals.waiting} batch${approvals.waiting === 1 ? ' is' : 'es are'} still waiting for approval.`);
  if (totals.changedAfterApproval) out.push(`${totals.changedAfterApproval} approved shift${totals.changedAfterApproval === 1 ? '' : 's'} changed afterwards and need${totals.changedAfterApproval === 1 ? 's' : ''} re-approval.`);
  if (change && change.noShows > 0 && totals.noShows >= 5) out.push(`Absences are up by ${change.noShows} on the previous period.`);
  if (totals.missingPunch) out.push(`${totals.missingPunch} shift${totals.missingPunch === 1 ? '' : 's'} with a missing check-in or check-out.`);
  return out;
}

const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB'));

// The weekly digest email for the Director.
function digestText({ overview, change, periodLabel, portalUrl }) {
  const { totals, byCrew, approvals } = overview;
  const delta = (k, unit = '') => (change && change[k] !== null && change[k] !== undefined && change[k] !== 0 ? ` (${change[k] > 0 ? '+' : ''}${fmtNum(change[k])}${unit} on the week before)` : '');
  const lines = [
    `Ark Group casuals at UCAA — ${periodLabel}`,
    '',
    `Workers who worked: ${fmtNum(totals.workers)}${delta('workers')}`,
    `Shifts worked: ${fmtNum(totals.shiftsWorked)} (Day ${fmtNum(totals.dayShifts)}, Night ${fmtNum(totals.nightShifts)})${delta('shiftsWorked')}`,
    `Hours worked: ${fmtNum(totals.hours)}${delta('hours')}`,
    `Attendance: ${totals.attendanceRate === null ? '—' : `${totals.attendanceRate}%`}${delta('attendanceRate', ' pts')}`,
    `Absent: ${fmtNum(totals.noShows)} · Late arrivals: ${fmtNum(totals.late)} · Early check-outs: ${fmtNum(totals.earlyOut)} · Missing punches: ${fmtNum(totals.missingPunch)} · Double shifts: ${fmtNum(totals.doubleShifts)}`,
    '',
    'By crew:',
    ...byCrew.map((c) => `  ${c.crew}: ${fmtNum(c.shifts)} shifts, ${fmtNum(c.hours)} h, ${fmtNum(c.noShows)} absent, ${fmtNum(c.late)} late`),
    '',
    `Approvals: ${approvals.approved} of ${approvals.batches} batches approved${approvals.onTimeRate === null ? '' : ` (${approvals.onTimeRate}% on time)`}, ${approvals.waiting} waiting, ${approvals.escalated} escalated.`
  ];
  const notes = attention(overview, change);
  if (notes.length) lines.push('', 'Worth a look:', ...notes.map((n) => `  - ${n}`));
  if (portalUrl) lines.push('', `Open the overview: ${portalUrl}/?page=overview`);
  return lines.join('\n');
}

module.exports = { computeOverview, compare, attention, digestText };
