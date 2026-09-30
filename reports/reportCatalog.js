// The report catalog: what reports exist, which periods each accepts, and
// the pure builders that turn already-fetched rows into a report model.
//
// A model is format-neutral — the CSV, Excel and PDF renderers (and the
// on-screen preview) all draw the same thing:
//   { type, title, subtitle, period, kpis: [{ label, value, sub, tone }],
//     sections: [{ title, note, columns, rows, totals }], notes, landscape }
// Column types: text | id | date | time | datetime | hours | int | pct |
// status | code | minutes.
//
// No database or HTTP here — see routes/reports.js for loading.

const DAY_MS = 24 * 3600 * 1000;
const EAT_OFFSET_MS = 3 * 3600 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const STATUS_LABEL = {
  'on-time': 'On time',
  early: 'Early',
  late: 'Late',
  'no-checkout': 'No checkout',
  'no-checkin': 'No check-in',
  'no-show': 'No-show',
  'in-progress': 'In progress'
};

const NO_CREW = 'Not in a crew';
const MAX_REGISTER_DAYS = 31;

// ---------------------------------------------------------------- catalog

const PERIODS = ['day', 'week', 'month', 'range', 'all'];
const MANAGERS = ['sysadmin', 'hr', 'admin_assistant', 'supervisor'];
const EVERYONE = [...MANAGERS, 'finance'];

const REPORT_TYPES = [
  {
    id: 'daily', name: 'Daily attendance', roles: EVERYONE, periods: ['day'], defaultPeriod: 'day',
    description: 'Everyone on one date, split into Day and Night shift, with check-in/out, hours and status.'
  },
  {
    id: 'timesheet', name: 'Clock-in / clock-out timesheet', roles: EVERYONE, periods: ['day', 'week', 'month', 'range', 'all'], defaultPeriod: 'week', allowsWorker: true,
    description: 'Every worker, every day: actual clock-in and clock-out times, every badge in between, minutes late or early, and hours. Grouped by worker.'
  },
  {
    id: 'summary', name: 'Attendance summary', roles: EVERYONE, periods: ['week', 'month', 'range', 'all'], defaultPeriod: 'month',
    description: 'One line per worker: shifts worked, hours, lateness, no-shows and attendance rate. Use it as the weekly, monthly or all-time report.'
  },
  {
    id: 'individual', name: 'Individual worker', roles: EVERYONE, periods: ['week', 'month', 'range', 'all'], defaultPeriod: 'month', needsWorker: true,
    description: "One worker's shift-by-shift record with totals and a week-by-week breakdown."
  },
  {
    id: 'register', name: 'Attendance register', roles: EVERYONE, periods: ['week', 'month', 'range'], defaultPeriod: 'month',
    description: 'Timesheet grid: workers down the side, dates across, D / N / A in each cell. Up to 31 days.'
  },
  {
    id: 'hours', name: 'Hours & payroll', roles: EVERYONE, periods: ['week', 'month', 'range', 'all'], defaultPeriod: 'month',
    description: 'Shifts and hours per worker, split into approved and still awaiting approval. A double shift counts as two.'
  },
  {
    id: 'exceptions', name: 'Exceptions', roles: EVERYONE, periods: ['day', 'week', 'month', 'range', 'all'], defaultPeriod: 'week',
    description: 'Late arrivals (with minutes late), no-shows, missing punches, early check-outs, multiple punches and unscheduled shifts.'
  },
  {
    id: 'daily-totals', name: 'Daily headcount', roles: EVERYONE, periods: ['week', 'month', 'range', 'all'], defaultPeriod: 'month',
    description: 'One line per date: how many worked Day and Night, late, no-shows and hours.'
  },
  {
    id: 'crew', name: 'Crew performance', roles: EVERYONE, periods: ['day', 'week', 'month', 'range', 'all'], defaultPeriod: 'week',
    description: 'Each crew shift by shift: scheduled, worked, late, no-shows, hours and approval state.'
  },
  {
    id: 'approvals', name: 'Approval status', roles: MANAGERS, periods: ['week', 'month', 'range', 'all'], defaultPeriod: 'month',
    description: 'Every approval batch in the period: who approved it and when, what is pending and what was escalated.'
  },
  {
    id: 'detailed', name: 'Detailed records', roles: EVERYONE, periods: ['day', 'week', 'month', 'range', 'all'], defaultPeriod: 'week',
    description: 'Every shift record in the period with all fields — the raw material for your own analysis.'
  }
];

// ---------------------------------------------------------------- column choice
//
// The columns a user can show or hide, per report. Keys match the builders'
// column keys (test/reportsTest.js checks they stay in sync); "dates" stands
// for all of the register's per-date columns.

const COLUMN_LABELS = {
  id: 'Employee ID', worker: 'Worker', crew: 'Crew', date: 'Date', shift: 'Shift',
  checkIn: 'Clock in', checkOut: 'Clock out', hours: 'Hours', status: 'Status',
  flags: 'Flags / notes', approval: 'Approval', badges: 'All badges',
  lateBy: 'Late by', earlyBy: 'Left early by',
  worked: 'Shifts worked', day: 'Day shifts', night: 'Night shifts', avg: 'Avg h/shift',
  punctual: 'On time', late: 'Late', missing: 'Missing punch', noShow: 'No-show',
  earlyOut: 'Early out', rate: 'Attendance %', week: 'Week', dates: 'Date columns',
  dayTotal: 'Day total', nightTotal: 'Night total', absent: 'Absent',
  approvedShifts: 'Approved shifts', approvedHours: 'Approved hours',
  pendingShifts: 'Pending shifts', pendingHours: 'Pending hours', changed: 'Changed after approval',
  scheduled: 'Scheduled start / end', minutes: 'Minutes late / early', source: 'Expected because',
  issues: 'Total exceptions', workers: 'Workers', approved: 'Approved %',
  batch: 'Batch', state: 'State', records: 'Records', dueAt: 'Approvable from',
  escalatedAt: 'Escalated', approvedAt: 'Approved at', approvedBy: 'Approved by',
  waitHours: 'Wait (h)', comment: 'Comment'
};

const REPORT_COLUMNS = {
  daily: ['id', 'worker', 'crew', 'checkIn', 'checkOut', 'hours', 'status', 'flags', 'approval'],
  timesheet: ['id', 'worker', 'date', 'shift', 'checkIn', 'checkOut', 'hours', 'status', 'lateBy', 'earlyBy', 'badges', 'flags'],
  summary: ['id', 'worker', 'crew', 'worked', 'day', 'night', 'hours', 'avg', 'punctual', 'late', 'missing', 'noShow', 'earlyOut', 'rate'],
  individual: ['date', 'week', 'shift', 'checkIn', 'checkOut', 'hours', 'status', 'badges', 'flags', 'approval', 'worked', 'day', 'night', 'late', 'missing', 'noShow'],
  register: ['id', 'worker', 'dates', 'dayTotal', 'nightTotal', 'absent', 'hours'],
  hours: ['id', 'worker', 'crew', 'day', 'night', 'worked', 'hours', 'approvedShifts', 'approvedHours', 'pendingShifts', 'pendingHours', 'changed'],
  exceptions: ['date', 'shift', 'id', 'worker', 'crew', 'scheduled', 'checkIn', 'checkOut', 'minutes', 'missing', 'source', 'status', 'hours', 'late', 'noShow', 'earlyOut', 'issues'],
  'daily-totals': ['date', 'day', 'night', 'worked', 'late', 'missing', 'noShow', 'hours', 'approved'],
  crew: ['crew', 'date', 'shift', 'workers', 'scheduled', 'worked', 'late', 'missing', 'noShow', 'hours', 'rate', 'approved', 'approval'],
  approvals: ['batch', 'state', 'records', 'dueAt', 'escalatedAt', 'approvedAt', 'approvedBy', 'waitHours', 'comment'],
  detailed: ['date', 'shift', 'id', 'worker', 'crew', 'checkIn', 'checkOut', 'hours', 'status', 'flags', 'approval']
};

// The key a column is chosen by.
const choiceKey = (col) => (col.type === 'code' ? 'dates' : col.key);

/**
 * Drops the hidden columns from every section. A section is never left
 * with no columns — if every one of its columns is hidden it keeps them all.
 */
function applyColumnChoice(model, hidden) {
  if (!hidden || hidden.size === 0) return model;
  return {
    ...model,
    hiddenColumns: [...hidden],
    sections: model.sections.map((s) => {
      const columns = s.columns.filter((c) => !hidden.has(choiceKey(c)));
      return columns.length ? { ...s, columns } : s;
    })
  };
}

function catalogFor(role) {
  return REPORT_TYPES.filter((t) => t.roles.includes(role)).map(({ roles, ...t }) => ({
    ...t,
    columns: (REPORT_COLUMNS[t.id] || []).map((key) => ({ key, label: COLUMN_LABELS[key] || key }))
  }));
}

// ---------------------------------------------------------------- dates

const pad2 = (n) => String(n).padStart(2, '0');
const dateStrOf = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (dateStr, n) => dateStrOf(new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS));
const weekdayOf = (dateStr) => WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
function fmtDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${pad2(d)} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}
function datesIn(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
// Monday of the week containing dateStr.
function mondayOf(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return addDays(dateStr, -((dow + 6) % 7));
}
// Shift start (or end) instant for a shift dated dateStr at "HH:mm" EAT.
function eatInstant(dateStr, hhmm, plusDays = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.parse(`${dateStr}T00:00:00Z`) + plusDays * DAY_MS + (h * 60 + m) * 60000 - EAT_OFFSET_MS;
}
function eatClock(ts) {
  return new Date(new Date(ts).getTime() + EAT_OFFSET_MS).toISOString().slice(11, 16);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Turns the request's period parameters into { kind, from, to, label }.
 * `bounds` ({ min, max } date strings) is only needed for kind "all".
 * Returns { error } for bad input.
 */
function resolvePeriod(q, bounds) {
  const kind = PERIODS.includes(q.period) ? q.period : null;
  if (!kind) return { error: 'Choose a period.' };

  if (kind === 'day') {
    if (!DATE_RE.test(q.date || '')) return { error: 'Choose a date.' };
    return { kind, from: q.date, to: q.date, label: `${weekdayOf(q.date)}, ${fmtDay(q.date)}` };
  }
  if (kind === 'week') {
    if (!DATE_RE.test(q.date || '')) return { error: 'Choose a date in the week.' };
    const from = mondayOf(q.date);
    const to = addDays(from, 6);
    return { kind, from, to, label: `Week of ${fmtDay(from)} - ${fmtDay(to)}` };
  }
  if (kind === 'month') {
    if (!MONTH_RE.test(q.month || '')) return { error: 'Choose a month.' };
    const [y, m] = q.month.split('-').map(Number);
    if (m < 1 || m > 12) return { error: 'Choose a month.' };
    const from = `${q.month}-01`;
    const to = dateStrOf(new Date(Date.UTC(y, m, 0)));
    return { kind, from, to, label: `${MONTHS[m - 1]} ${y}` };
  }
  if (kind === 'range') {
    if (!DATE_RE.test(q.from || '') || !DATE_RE.test(q.to || '')) return { error: 'Choose a start and end date.' };
    if (q.from > q.to) return { error: 'The start date must not be after the end date.' };
    return { kind, from: q.from, to: q.to, label: q.from === q.to ? fmtDay(q.from) : `${fmtDay(q.from)} - ${fmtDay(q.to)}` };
  }
  // all
  if (!bounds || !bounds.min) return { error: 'There are no records yet.' };
  return { kind, from: bounds.min, to: bounds.max, label: `All time (${fmtDay(bounds.min)} - ${fmtDay(bounds.max)})` };
}

// ---------------------------------------------------------------- row helpers

const worked = (r) => r.status !== 'no-show';
const punctual = (r) => r.status === 'on-time' || r.status === 'early';
const missingPunch = (r) => r.status === 'no-checkout' || r.status === 'no-checkin';
const pctOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const round2 = (n) => Math.round(n * 100) / 100;

function approvalState(r) {
  if (r.changedAfterApproval) return 'Changed after approval';
  return r.approvedAt ? 'Approved' : 'Pending';
}

// The Status column shows only a late check-in and/or an early check-out
// ("late-in", "early-out", or both comma-joined); anything else is blank.
// Mirrors statusTags() in src/shiftStatus.js.
const TAG_LABEL = { 'late-in': 'Late in', 'early-out': 'Early out' };
function statusTags(r) {
  const tags = [];
  if (r.status === 'late' || r.lateIn) tags.push('late-in');
  if (r.earlyCheckOut) tags.push('early-out');
  return tags.join(',');
}

// No schedule and a single badge: which shift it belongs to was guessed.
// Mirrors isGuessed() in src/shiftStatus.js.
const isGuessed = (r) => r.source === 'unscheduled' && (!r.checkIn || !r.checkOut);

// Flags no longer repeat Late in / Early out — those are the Status column.
function flagsOf(r) {
  const f = [];
  if (r.hasMultiplePunches) f.push('Multiple punches');
  if (r.checkInImplied || r.checkOutImplied) f.push('Implied time');
  if (r.source === 'unscheduled') f.push(isGuessed(r) ? 'Unscheduled, shift guessed' : 'Unscheduled');
  if (r.source === 'exception') f.push('Exception');
  if (r.source === 'suggested') f.push('Schedule not confirmed');
  return f.join(', ');
}

const byName = (a, b) => a.worker.name.localeCompare(b.worker.name) || a.worker.biostarUserId.localeCompare(b.worker.biostarUserId);
const byDateShiftName = (a, b) => dateStrOf(a.date).localeCompare(dateStrOf(b.date)) || a.shift.id - b.shift.id || byName(a, b);

// The worker's own crew on the shift's date (from their confirmed schedule),
// not the crew whose supervisor approves the record — someone covering a
// shift, or permanent staff, is "Not in a crew" even when routed to a crew's
// supervisor. ctx.crewOf(workerId, dateStr) is supplied by the route; without
// it (tests), the approving crew is used.
function crewNameOf(ctx, r) {
  const crewId = ctx.crewOf ? ctx.crewOf(r.worker.id, dateStrOf(r.date)) : r.approvalCrewId;
  return (crewId && ctx.crewsById.get(crewId)?.name) || NO_CREW;
}

// Per-worker tallies, used by several reports.
function tallyByWorker(ctx, rows) {
  const map = new Map();
  for (const r of [...rows].sort((a, b) => a.date - b.date)) {
    if (!map.has(r.worker.id)) {
      map.set(r.worker.id, {
        worker: r.worker, crew: NO_CREW, records: 0, worked: 0, day: 0, night: 0, hours: 0, hoursN: 0,
        punctual: 0, late: 0, missing: 0, noShow: 0, earlyOut: 0,
        approvedShifts: 0, approvedHours: 0, pendingShifts: 0, pendingHours: 0, changed: 0
      });
    }
    const t = map.get(r.worker.id);
    t.crew = crewNameOf(ctx, r); // latest row wins
    t.records++;
    if (worked(r)) {
      t.worked++;
      if (r.shift.name === 'Night') t.night++; else t.day++;
      const approved = r.approvedAt && !r.changedAfterApproval;
      if (approved) { t.approvedShifts++; t.approvedHours += r.hoursWorked || 0; } else { t.pendingShifts++; t.pendingHours += r.hoursWorked || 0; }
    }
    if (r.hoursWorked != null) { t.hours += r.hoursWorked; t.hoursN++; }
    if (punctual(r)) t.punctual++;
    if (r.status === 'late') t.late++;
    if (missingPunch(r)) t.missing++;
    if (r.status === 'no-show') t.noShow++;
    if (r.earlyCheckOut) t.earlyOut++;
    if (r.changedAfterApproval) t.changed++;
  }
  return [...map.values()].sort((a, b) => a.worker.name.localeCompare(b.worker.name));
}

function overallKpis(rows) {
  const w = rows.filter(worked);
  const hours = rows.reduce((a, r) => a + (r.hoursWorked || 0), 0);
  const completed = rows.filter((r) => punctual(r) || r.status === 'late').length;
  const noShow = rows.filter((r) => r.status === 'no-show').length;
  return [
    { label: 'Workers', value: String(new Set(rows.map((r) => r.worker.id)).size), sub: 'with records in the period', tone: 'navy' },
    { label: 'Shifts worked', value: String(w.length), sub: `${w.filter((r) => r.shift.name !== 'Night').length} Day / ${w.filter((r) => r.shift.name === 'Night').length} Night`, tone: 'navy' },
    { label: 'Hours worked', value: hours.toFixed(1), sub: completed ? `avg ${(hours / Math.max(1, rows.filter((r) => r.hoursWorked != null).length)).toFixed(1)} h per shift` : 'no completed shifts', tone: 'teal' },
    { label: 'Punctuality', value: completed ? `${Math.round((rows.filter(punctual).length / completed) * 100)}%` : '-', sub: `${rows.filter(punctual).length} of ${completed} completed shifts`, tone: 'ok' },
    { label: 'Late arrivals', value: String(rows.filter((r) => r.status === 'late').length), sub: 'checked in after the grace period', tone: 'warn' },
    { label: 'Missing punches', value: String(rows.filter(missingPunch).length), sub: 'no check-out or no check-in', tone: 'grey' },
    { label: 'No-shows', value: String(noShow), sub: 'scheduled, no punch activity', tone: 'critical' },
    { label: 'Attendance rate', value: w.length + noShow ? `${Math.round((w.length / (w.length + noShow)) * 100)}%` : '-', sub: 'shifts worked / scheduled', tone: 'ok' }
  ];
}

// Common columns.
const COL = {
  id: { key: 'id', label: 'Employee ID', type: 'id', width: 1.25 },
  worker: { key: 'worker', label: 'Worker', type: 'text', width: 2.2 },
  crew: { key: 'crew', label: 'Crew', type: 'text', width: 1.2 },
  date: { key: 'date', label: 'Date', type: 'date', width: 1.5 },
  shift: { key: 'shift', label: 'Shift', type: 'text', width: 0.8 },
  in: { key: 'checkIn', label: 'Clock in', type: 'time', width: 0.8 },
  out: { key: 'checkOut', label: 'Clock out', type: 'time', width: 0.8 },
  hours: { key: 'hours', label: 'Hours', type: 'hours', width: 0.8 },
  status: { key: 'status', label: 'Status', type: 'status', width: 1.2 },
  flags: { key: 'flags', label: 'Flags', type: 'text', width: 2 },
  approval: { key: 'approval', label: 'Approval', type: 'text', width: 1.3 }
};

function shiftRecordRow(ctx, r) {
  return {
    id: r.worker.biostarUserId,
    worker: r.worker.name,
    crew: crewNameOf(ctx, r),
    date: dateStrOf(r.date),
    shift: r.shift.name,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    hours: r.hoursWorked,
    status: statusTags(r),
    flags: flagsOf(r),
    approval: approvalState(r),
    badges: (ctx.punchTimes?.get(r.id) || []).map((t) => eatClock(t)).join(', ')
  };
}

function shiftLabel(ctx, shiftName) {
  const s = ctx.shifts.find((x) => x.name === shiftName);
  return s ? `${s.name} shift (${s.startTime}-${s.endTime})` : `${shiftName} shift`;
}

// ---------------------------------------------------------------- builders

function buildDaily(ctx, rows) {
  const sections = ctx.shifts
    .map((s) => {
      const list = rows.filter((r) => r.shift.id === s.id).sort(byName);
      if (list.length === 0) return null;
      const w = list.filter(worked);
      return {
        title: shiftLabel(ctx, s.name),
        note: `${list.length} scheduled or present · ${w.length} worked · ${list.filter((r) => r.status === 'late').length} late · ${list.filter((r) => r.status === 'no-show').length} no-show`,
        columns: [COL.id, COL.worker, COL.crew, COL.in, COL.out, COL.hours, COL.status, COL.flags, COL.approval],
        rows: list.map((r) => shiftRecordRow(ctx, r)),
        totals: { worker: `${w.length} worked of ${list.length}`, hours: round2(list.reduce((a, r) => a + (r.hoursWorked || 0), 0)) }
      };
    })
    .filter(Boolean);
  return { title: 'Daily attendance report', kpis: overallKpis(rows), sections };
}

function summaryColumns() {
  return [
    COL.id, COL.worker, COL.crew,
    { key: 'worked', label: 'Shifts worked', type: 'int', width: 0.9 },
    { key: 'day', label: 'Day', type: 'int', width: 0.6 },
    { key: 'night', label: 'Night', type: 'int', width: 0.6 },
    { key: 'hours', label: 'Hours', type: 'hours', width: 0.8 },
    { key: 'avg', label: 'Avg h/shift', type: 'hours', width: 0.8 },
    { key: 'punctual', label: 'On time', type: 'int', width: 0.7 },
    { key: 'late', label: 'Late', type: 'int', width: 0.6 },
    { key: 'missing', label: 'Missing punch', type: 'int', width: 0.9 },
    { key: 'noShow', label: 'No-show', type: 'int', width: 0.7 },
    { key: 'earlyOut', label: 'Early out', type: 'int', width: 0.7 },
    { key: 'rate', label: 'Attendance', type: 'pct', width: 0.9 }
  ];
}

function buildSummary(ctx, rows, period) {
  const tallies = tallyByWorker(ctx, rows);
  const out = tallies.map((t) => ({
    id: t.worker.biostarUserId, worker: t.worker.name, crew: t.crew,
    worked: t.worked, day: t.day, night: t.night, hours: round2(t.hours), avg: t.hoursN ? round2(t.hours / t.hoursN) : null,
    punctual: t.punctual, late: t.late, missing: t.missing, noShow: t.noShow, earlyOut: t.earlyOut,
    rate: pctOf(t.worked, t.worked + t.noShow)
  }));
  const sum = (k) => out.reduce((a, r) => a + (r[k] || 0), 0);
  const title = { week: 'Weekly attendance summary', month: 'Monthly attendance summary', all: 'All-time attendance summary' }[period.kind] || 'Attendance summary';
  return {
    title,
    kpis: overallKpis(rows),
    sections: [{
      title: 'Per worker',
      note: `${out.length} worker${out.length === 1 ? '' : 's'}`,
      columns: summaryColumns(),
      rows: out,
      totals: {
        worker: `${out.length} workers`, worked: sum('worked'), day: sum('day'), night: sum('night'), hours: round2(sum('hours')),
        avg: rows.some((r) => r.hoursWorked != null) ? round2(sum('hours') / rows.filter((r) => r.hoursWorked != null).length) : null,
        punctual: sum('punctual'), late: sum('late'), missing: sum('missing'), noShow: sum('noShow'), earlyOut: sum('earlyOut'),
        rate: pctOf(sum('worked'), sum('worked') + sum('noShow'))
      }
    }]
  };
}

function buildIndividual(ctx, rows, period) {
  const worker = ctx.worker;
  const list = [...rows].sort((a, b) => a.date - b.date || a.shift.id - b.shift.id);
  const t = tallyByWorker(ctx, list)[0];
  const crew = t ? t.crew : NO_CREW;

  const sections = [{
    title: 'Shift by shift',
    note: `${list.length} record${list.length === 1 ? '' : 's'}`,
    columns: [COL.date, COL.shift, COL.in, COL.out, COL.hours, COL.status, { key: 'badges', label: 'All badges', type: 'text', width: 1.8 }, COL.flags, COL.approval],
    rows: list.map((r) => shiftRecordRow(ctx, r)),
    totals: { date: `${t ? t.worked : 0} shifts worked`, hours: round2(list.reduce((a, r) => a + (r.hoursWorked || 0), 0)) }
  }];

  if (daysBetween(period.from, period.to) > 7 && list.length) {
    const weeks = new Map();
    for (const r of list) {
      const wk = mondayOf(dateStrOf(r.date));
      if (!weeks.has(wk)) weeks.set(wk, []);
      weeks.get(wk).push(r);
    }
    sections.push({
      title: 'Week by week',
      columns: [
        { key: 'week', label: 'Week', type: 'text', width: 2.2 },
        { key: 'worked', label: 'Shifts worked', type: 'int', width: 1 },
        { key: 'day', label: 'Day', type: 'int', width: 0.7 },
        { key: 'night', label: 'Night', type: 'int', width: 0.7 },
        { key: 'hours', label: 'Hours', type: 'hours', width: 0.8 },
        { key: 'late', label: 'Late', type: 'int', width: 0.7 },
        { key: 'missing', label: 'Missing punch', type: 'int', width: 1 },
        { key: 'noShow', label: 'No-show', type: 'int', width: 0.8 }
      ],
      rows: [...weeks.entries()].map(([wk, rs]) => ({
        week: `${fmtDay(wk)} - ${fmtDay(addDays(wk, 6))}`,
        worked: rs.filter(worked).length,
        day: rs.filter((r) => worked(r) && r.shift.name !== 'Night').length,
        night: rs.filter((r) => worked(r) && r.shift.name === 'Night').length,
        hours: round2(rs.reduce((a, r) => a + (r.hoursWorked || 0), 0)),
        late: rs.filter((r) => r.status === 'late').length,
        missing: rs.filter(missingPunch).length,
        noShow: rs.filter((r) => r.status === 'no-show').length
      })),
      totals: null
    });
  }

  const noShow = t ? t.noShow : 0;
  const w = t ? t.worked : 0;
  const completed = t ? t.punctual + t.late : 0;
  return {
    title: 'Individual worker report',
    subtitle: `${worker.name} (${worker.biostarUserId}) · ${crew}`,
    kpis: [
      { label: 'Shifts worked', value: String(w), sub: t ? `${t.day} Day / ${t.night} Night` : 'none', tone: 'navy' },
      { label: 'Hours worked', value: t ? t.hours.toFixed(1) : '0.0', sub: t && t.hoursN ? `avg ${(t.hours / t.hoursN).toFixed(1)} h per shift` : 'no completed shifts', tone: 'teal' },
      { label: 'Punctuality', value: completed ? `${Math.round((t.punctual / completed) * 100)}%` : '-', sub: `${t ? t.punctual : 0} of ${completed} completed shifts`, tone: 'ok' },
      { label: 'Attendance rate', value: w + noShow ? `${Math.round((w / (w + noShow)) * 100)}%` : '-', sub: 'shifts worked / scheduled', tone: 'ok' },
      { label: 'Late arrivals', value: String(t ? t.late : 0), sub: 'after the grace period', tone: 'warn' },
      { label: 'Missing punches', value: String(t ? t.missing : 0), sub: 'no check-out or check-in', tone: 'grey' },
      { label: 'No-shows', value: String(noShow), sub: 'scheduled, no punches', tone: 'critical' },
      { label: 'Early check-outs', value: String(t ? t.earlyOut : 0), sub: 'left before shift end', tone: 'warn' }
    ],
    sections
  };
}

function buildRegister(ctx, rows, period) {
  if (daysBetween(period.from, period.to) > MAX_REGISTER_DAYS) {
    return { error: `The register covers at most ${MAX_REGISTER_DAYS} days. Choose a week or a month.` };
  }
  const dates = datesIn(period.from, period.to);
  const byWorker = new Map();
  for (const r of rows) {
    if (!byWorker.has(r.worker.id)) byWorker.set(r.worker.id, { worker: r.worker, cells: new Map(), crew: NO_CREW, lastDate: '' });
    const w = byWorker.get(r.worker.id);
    const d = dateStrOf(r.date);
    if (d >= w.lastDate) { w.lastDate = d; w.crew = crewNameOf(ctx, r); }
    if (!w.cells.has(d)) w.cells.set(d, []);
    w.cells.get(d).push(r);
  }

  const cellCode = (list) => {
    if (!list) return '';
    const done = list.filter(worked);
    if (done.length === 0) return 'A';
    const day = done.some((r) => r.shift.name !== 'Night');
    const night = done.some((r) => r.shift.name === 'Night');
    return day && night ? 'DN' : night ? 'N' : 'D';
  };

  const out = [...byWorker.values()]
    .sort((a, b) => a.worker.name.localeCompare(b.worker.name))
    .map((w) => {
      const row = { id: w.worker.biostarUserId, worker: w.worker.name, crew: w.crew };
      let day = 0; let night = 0; let absent = 0; let hours = 0;
      for (const d of dates) {
        const list = w.cells.get(d);
        row[`d${d}`] = cellCode(list);
        for (const r of list || []) {
          if (!worked(r)) absent++;
          else if (r.shift.name === 'Night') night++; else day++;
          hours += r.hoursWorked || 0;
        }
      }
      Object.assign(row, { dayTotal: day, nightTotal: night, absent, hours: round2(hours) });
      return row;
    });

  const sum = (k) => out.reduce((a, r) => a + (r[k] || 0), 0);
  const totals = { worker: `${out.length} workers`, dayTotal: sum('dayTotal'), nightTotal: sum('nightTotal'), absent: sum('absent'), hours: round2(sum('hours')) };
  for (const d of dates) {
    const n = out.filter((r) => r[`d${d}`] && r[`d${d}`] !== 'A').length;
    totals[`d${d}`] = n ? String(n) : '';
  }

  return {
    title: 'Attendance register',
    landscape: true,
    kpis: overallKpis(rows),
    sections: [{
      title: 'Register',
      note: 'D = Day shift worked · N = Night shift worked · DN = double shift · A = absent (scheduled, no punches) · blank = not scheduled',
      columns: [
        { ...COL.id, width: 1.3 }, { ...COL.worker, width: 3 },
        ...dates.map((d) => ({ key: `d${d}`, label: `${d.slice(8, 10)} ${weekdayOf(d).slice(0, 2)}`, type: 'code', width: 0.5 })),
        { key: 'dayTotal', label: 'Day', type: 'int', width: 0.7 },
        { key: 'nightTotal', label: 'Night', type: 'int', width: 0.75 },
        { key: 'absent', label: 'Absent', type: 'int', width: 0.9 },
        { key: 'hours', label: 'Hours', type: 'hours', width: 0.8 }
      ],
      rows: out,
      totals
    }],
    notes: ['The totals row under each date is the number of workers present that day.']
  };
}

function buildHours(ctx, rows) {
  const tallies = tallyByWorker(ctx, rows).filter((t) => t.worked > 0 || t.records > 0);
  const out = tallies.map((t) => ({
    id: t.worker.biostarUserId, worker: t.worker.name, crew: t.crew,
    day: t.day, night: t.night, worked: t.worked, hours: round2(t.hours),
    approvedShifts: t.approvedShifts, approvedHours: round2(t.approvedHours),
    pendingShifts: t.pendingShifts, pendingHours: round2(t.pendingHours), changed: t.changed
  }));
  const sum = (k) => out.reduce((a, r) => a + (r[k] || 0), 0);
  return {
    title: 'Hours & payroll report',
    kpis: [
      { label: 'Workers', value: String(out.length), sub: 'with records in the period', tone: 'navy' },
      { label: 'Shifts worked', value: String(sum('worked')), sub: `${sum('day')} Day / ${sum('night')} Night`, tone: 'navy' },
      { label: 'Hours worked', value: sum('hours').toFixed(1), sub: 'no meal deduction', tone: 'teal' },
      { label: 'Approved hours', value: sum('approvedHours').toFixed(1), sub: `${sum('approvedShifts')} approved shifts`, tone: 'ok' },
      { label: 'Awaiting approval', value: sum('pendingHours').toFixed(1), sub: `${sum('pendingShifts')} shifts not yet approved`, tone: 'warn' },
      { label: 'Re-approval needed', value: String(sum('changed')), sub: 'changed after approval', tone: 'critical' }
    ],
    sections: [{
      title: 'Per worker',
      note: 'A double shift counts as two shifts.',
      columns: [
        COL.id, COL.worker, COL.crew,
        { key: 'day', label: 'Day shifts', type: 'int', width: 0.8 },
        { key: 'night', label: 'Night shifts', type: 'int', width: 0.8 },
        { key: 'worked', label: 'Total shifts', type: 'int', width: 0.8 },
        { key: 'hours', label: 'Total hours', type: 'hours', width: 0.9 },
        { key: 'approvedShifts', label: 'Approved shifts', type: 'int', width: 0.9 },
        { key: 'approvedHours', label: 'Approved hours', type: 'hours', width: 0.9 },
        { key: 'pendingShifts', label: 'Pending shifts', type: 'int', width: 0.9 },
        { key: 'pendingHours', label: 'Pending hours', type: 'hours', width: 0.9 },
        { key: 'changed', label: 'Changed', type: 'int', width: 0.7 }
      ],
      rows: out,
      totals: {
        worker: `${out.length} workers`, day: sum('day'), night: sum('night'), worked: sum('worked'), hours: round2(sum('hours')),
        approvedShifts: sum('approvedShifts'), approvedHours: round2(sum('approvedHours')),
        pendingShifts: sum('pendingShifts'), pendingHours: round2(sum('pendingHours')), changed: sum('changed')
      }
    }]
  };
}

function buildExceptions(ctx, rows) {
  const shiftById = new Map(ctx.shifts.map((s) => [s.id, s]));
  const sorted = [...rows].sort(byDateShiftName);
  const base = (r) => ({ date: dateStrOf(r.date), shift: r.shift.name, id: r.worker.biostarUserId, worker: r.worker.name, crew: crewNameOf(ctx, r) });
  const lead = [COL.date, COL.shift, COL.id, COL.worker, COL.crew];

  const late = sorted.filter((r) => (r.status === 'late' || r.lateIn) && r.checkIn).map((r) => {
    const s = shiftById.get(r.shift.id);
    return { ...base(r), scheduled: s.startTime, checkIn: r.checkIn, minutes: Math.max(0, Math.round((new Date(r.checkIn).getTime() - eatInstant(dateStrOf(r.date), s.startTime)) / 60000)) };
  });
  const noShows = sorted.filter((r) => r.status === 'no-show').map((r) => ({ ...base(r), source: { schedule: 'Scheduled', exception: 'Exception', suggested: 'Pattern (not confirmed)' }[r.source] || r.source }));
  const missing = sorted.filter(missingPunch).map((r) => ({ ...base(r), checkIn: r.checkIn, checkOut: r.checkOut, missing: r.status === 'no-checkout' ? 'Check-out' : 'Check-in' }));
  const earlyOut = sorted.filter((r) => r.earlyCheckOut && r.checkOut).map((r) => {
    const s = shiftById.get(r.shift.id);
    const endsNextDay = s.endTime <= s.startTime;
    return { ...base(r), scheduled: s.endTime, checkOut: r.checkOut, minutes: Math.max(0, Math.round((eatInstant(dateStrOf(r.date), s.endTime, endsNextDay ? 1 : 0) - new Date(r.checkOut).getTime()) / 60000)) };
  });
  const multi = sorted.filter((r) => r.hasMultiplePunches).map((r) => ({ ...base(r), checkIn: r.checkIn, checkOut: r.checkOut, status: statusTags(r) }));
  const unscheduled = sorted.filter((r) => r.source === 'unscheduled').map((r) => ({ ...base(r), checkIn: r.checkIn, checkOut: r.checkOut, hours: r.hoursWorked }));

  const sections = [
    late.length && {
      title: 'Late arrivals', note: `${late.length} · average ${Math.round(late.reduce((a, r) => a + r.minutes, 0) / late.length)} min late`,
      columns: [...lead, { key: 'scheduled', label: 'Starts', type: 'text', width: 0.7 }, COL.in, { key: 'minutes', label: 'Minutes late', type: 'minutes', width: 0.9 }],
      rows: late, totals: null
    },
    noShows.length && {
      title: 'No-shows', note: `${noShows.length} scheduled shifts with no punches`,
      columns: [...lead, { key: 'source', label: 'Expected because', type: 'text', width: 1.6 }], rows: noShows, totals: null
    },
    missing.length && {
      title: 'Missing punches', note: `${missing.length} shifts with only one side recorded`,
      columns: [...lead, COL.in, COL.out, { key: 'missing', label: 'Missing', type: 'text', width: 0.9 }], rows: missing, totals: null
    },
    earlyOut.length && {
      title: 'Early check-outs', note: `${earlyOut.length} left before the shift end`,
      columns: [...lead, { key: 'scheduled', label: 'Ends', type: 'text', width: 0.7 }, COL.out, { key: 'minutes', label: 'Minutes early', type: 'minutes', width: 0.9 }],
      rows: earlyOut, totals: null
    },
    multi.length && {
      title: 'Multiple punches', note: `${multi.length} shifts with extra badges between in and out — worth a look`,
      columns: [...lead, COL.in, COL.out, COL.status], rows: multi, totals: null
    },
    unscheduled.length && {
      title: 'Unscheduled shifts', note: `${unscheduled.length} shifts worked outside the worker's schedule`,
      columns: [...lead, COL.in, COL.out, COL.hours], rows: unscheduled, totals: null
    }
  ].filter(Boolean);

  // Workers with the most issues.
  const tallies = tallyByWorker(ctx, rows)
    .map((t) => ({ id: t.worker.biostarUserId, worker: t.worker.name, crew: t.crew, late: t.late, missing: t.missing, noShow: t.noShow, earlyOut: t.earlyOut, issues: t.late + t.missing + t.noShow + t.earlyOut }))
    .filter((t) => t.issues > 0)
    .sort((a, b) => b.issues - a.issues || b.noShow - a.noShow || a.worker.localeCompare(b.worker))
    .slice(0, 20);
  if (tallies.length) {
    sections.unshift({
      title: 'Workers with the most exceptions', note: `top ${tallies.length}`,
      columns: [COL.id, COL.worker, COL.crew,
        { key: 'late', label: 'Late', type: 'int', width: 0.6 }, { key: 'missing', label: 'Missing punch', type: 'int', width: 0.9 },
        { key: 'noShow', label: 'No-show', type: 'int', width: 0.7 }, { key: 'earlyOut', label: 'Early out', type: 'int', width: 0.7 },
        { key: 'issues', label: 'Total', type: 'int', width: 0.6 }],
      rows: tallies, totals: null
    });
  }

  return {
    title: 'Exceptions report',
    kpis: [
      { label: 'Late arrivals', value: String(late.length), sub: late.length ? `avg ${Math.round(late.reduce((a, r) => a + r.minutes, 0) / late.length)} min late` : 'none', tone: 'warn' },
      { label: 'No-shows', value: String(noShows.length), sub: 'scheduled, no punches', tone: 'critical' },
      { label: 'Missing punches', value: String(missing.length), sub: 'only one side recorded', tone: 'grey' },
      { label: 'Early check-outs', value: String(earlyOut.length), sub: 'left before shift end', tone: 'warn' },
      { label: 'Multiple punches', value: String(multi.length), sub: 'extra badges mid-shift', tone: 'grey' },
      { label: 'Unscheduled', value: String(unscheduled.length), sub: 'outside the schedule', tone: 'navy' }
    ],
    sections
  };
}

function buildDailyTotals(ctx, rows) {
  const byDate = new Map();
  for (const r of rows) {
    const d = dateStrOf(r.date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const out = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, list]) => {
    const w = list.filter(worked);
    return {
      date: d,
      day: w.filter((r) => r.shift.name !== 'Night').length,
      night: w.filter((r) => r.shift.name === 'Night').length,
      worked: w.length,
      late: list.filter((r) => r.status === 'late').length,
      missing: list.filter(missingPunch).length,
      noShow: list.filter((r) => r.status === 'no-show').length,
      hours: round2(list.reduce((a, r) => a + (r.hoursWorked || 0), 0)),
      approved: pctOf(list.filter((r) => r.approvedAt && !r.changedAfterApproval).length, list.length)
    };
  });
  const sum = (k) => out.reduce((a, r) => a + (r[k] || 0), 0);
  return {
    title: 'Daily headcount report',
    kpis: overallKpis(rows),
    sections: [{
      title: 'Per day',
      note: `${out.length} day${out.length === 1 ? '' : 's'} · average ${out.length ? Math.round(sum('worked') / out.length) : 0} shifts worked per day`,
      columns: [
        { ...COL.date, width: 1.8 },
        { key: 'day', label: 'Day shift', type: 'int', width: 0.8 },
        { key: 'night', label: 'Night shift', type: 'int', width: 0.8 },
        { key: 'worked', label: 'Total worked', type: 'int', width: 0.9 },
        { key: 'late', label: 'Late', type: 'int', width: 0.6 },
        { key: 'missing', label: 'Missing punch', type: 'int', width: 0.9 },
        { key: 'noShow', label: 'No-show', type: 'int', width: 0.7 },
        { key: 'hours', label: 'Hours', type: 'hours', width: 0.8 },
        { key: 'approved', label: 'Approved', type: 'pct', width: 0.8 }
      ],
      rows: out,
      totals: {
        date: `${out.length} days`, day: sum('day'), night: sum('night'), worked: sum('worked'), late: sum('late'),
        missing: sum('missing'), noShow: sum('noShow'), hours: round2(sum('hours')),
        approved: pctOf(rows.filter((r) => r.approvedAt && !r.changedAfterApproval).length, rows.length)
      }
    }]
  };
}

function buildCrew(ctx, rows) {
  const byCrew = new Map();
  for (const r of rows) {
    const name = crewNameOf(ctx, r);
    if (!byCrew.has(name)) byCrew.set(name, []);
    byCrew.get(name).push(r);
  }
  const crewNames = [...byCrew.keys()].sort((a, b) => (a === NO_CREW) - (b === NO_CREW) || a.localeCompare(b));

  const overview = crewNames.map((name) => {
    const list = byCrew.get(name);
    const w = list.filter(worked);
    return {
      crew: name,
      workers: new Set(list.map((r) => r.worker.id)).size,
      scheduled: list.length,
      worked: w.length,
      late: list.filter((r) => r.status === 'late').length,
      missing: list.filter(missingPunch).length,
      noShow: list.filter((r) => r.status === 'no-show').length,
      hours: round2(list.reduce((a, r) => a + (r.hoursWorked || 0), 0)),
      rate: pctOf(w.length, w.length + list.filter((r) => r.status === 'no-show').length),
      approved: pctOf(list.filter((r) => r.approvedAt && !r.changedAfterApproval).length, list.length)
    };
  });

  const countCols = [
    { key: 'scheduled', label: 'Records', type: 'int', width: 0.7 },
    { key: 'worked', label: 'Worked', type: 'int', width: 0.7 },
    { key: 'late', label: 'Late', type: 'int', width: 0.6 },
    { key: 'missing', label: 'Missing punch', type: 'int', width: 0.9 },
    { key: 'noShow', label: 'No-show', type: 'int', width: 0.7 },
    { key: 'hours', label: 'Hours', type: 'hours', width: 0.8 }
  ];

  const sections = [{
    title: 'Crews at a glance',
    columns: [{ key: 'crew', label: 'Crew', type: 'text', width: 2 }, { key: 'workers', label: 'Workers', type: 'int', width: 0.7 }, ...countCols,
      { key: 'rate', label: 'Attendance', type: 'pct', width: 0.8 }, { key: 'approved', label: 'Approved', type: 'pct', width: 0.8 }],
    rows: overview,
    totals: null
  }];

  for (const name of crewNames) {
    const groups = new Map();
    for (const r of byCrew.get(name)) {
      const k = `${dateStrOf(r.date)}|${r.shift.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const list = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([k, rs]) => {
      const approvedN = rs.filter((r) => r.approvedAt && !r.changedAfterApproval).length;
      return {
        date: k.split('|')[0], shift: rs[0].shift.name, scheduled: rs.length, worked: rs.filter(worked).length,
        late: rs.filter((r) => r.status === 'late').length, missing: rs.filter(missingPunch).length,
        noShow: rs.filter((r) => r.status === 'no-show').length, hours: round2(rs.reduce((a, r) => a + (r.hoursWorked || 0), 0)),
        approval: approvedN === rs.length ? 'Approved' : approvedN === 0 ? 'Pending' : `${approvedN} of ${rs.length} approved`
      };
    });
    const sum = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
    sections.push({
      title: name,
      note: `${list.length} shift${list.length === 1 ? '' : 's'}`,
      columns: [COL.date, COL.shift, ...countCols, COL.approval],
      rows: list,
      totals: { date: 'Total', scheduled: sum('scheduled'), worked: sum('worked'), late: sum('late'), missing: sum('missing'), noShow: sum('noShow'), hours: round2(sum('hours')) }
    });
  }
  return { title: 'Crew performance report', kpis: overallKpis(rows), sections };
}

// units: ApprovalUnit rows already limited to the period and the user's scope,
// each with { label, crewName, shiftName, rows, approvedByName }.
function buildApprovals(ctx, units) {
  const now = ctx.now ?? Date.now();
  const stateOf = (u) => {
    if (u.status === 'approved') return 'Approved';
    if (now < new Date(u.dueAt).getTime()) return 'Shift in progress';
    if (u.escalatedAt) return 'Escalated';
    if (u.status === 'reopened') return 'Changed - re-approve';
    return 'Awaiting approval';
  };
  const out = [...units].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)).map((u) => ({
    batch: u.label,
    kind: u.kind === 'crew-shift' ? 'Crew shift' : 'HR month',
    state: stateOf(u),
    records: u.rows,
    dueAt: u.dueAt,
    escalatedAt: u.escalatedAt,
    approvedAt: u.approvedAt,
    approvedBy: u.approvedByName || '',
    waitHours: u.approvedAt ? round2((new Date(u.approvedAt) - new Date(u.dueAt)) / 3600000) : null,
    comment: u.comment || ''
  }));
  const count = (s) => out.filter((r) => r.state === s).length;
  const waits = out.filter((r) => r.waitHours != null && r.waitHours >= 0);
  return {
    title: 'Approval status report',
    kpis: [
      { label: 'Batches', value: String(out.length), sub: 'crew shifts and HR months', tone: 'navy' },
      { label: 'Approved', value: String(count('Approved')), sub: `${pctOf(count('Approved'), out.length) ?? 0}% of batches`, tone: 'ok' },
      { label: 'Awaiting approval', value: String(count('Awaiting approval') + count('Changed - re-approve')), sub: 'past due, not escalated yet', tone: 'warn' },
      { label: 'Escalated', value: String(count('Escalated')), sub: 'unapproved after 48 hours', tone: 'critical' },
      { label: 'Average wait', value: waits.length ? `${Math.round(waits.reduce((a, r) => a + r.waitHours, 0) / waits.length)} h` : '-', sub: 'from approvable to approved', tone: 'teal' }
    ],
    sections: [{
      title: 'Approval batches',
      note: `${out.length} batch${out.length === 1 ? '' : 'es'}`,
      columns: [
        { key: 'batch', label: 'Batch', type: 'text', width: 2.4 },
        { key: 'state', label: 'State', type: 'text', width: 1.3 },
        { key: 'records', label: 'Records', type: 'int', width: 0.7 },
        { key: 'dueAt', label: 'Approvable from', type: 'datetime', width: 1.4 },
        { key: 'escalatedAt', label: 'Escalated', type: 'datetime', width: 1.4 },
        { key: 'approvedAt', label: 'Approved', type: 'datetime', width: 1.4 },
        { key: 'approvedBy', label: 'Approved by', type: 'text', width: 1.4 },
        { key: 'waitHours', label: 'Wait (h)', type: 'hours', width: 0.7 },
        { key: 'comment', label: 'Comment', type: 'text', width: 2 }
      ],
      rows: out,
      totals: null
    }],
    landscape: true
  };
}

function buildDetailed(ctx, rows) {
  const list = [...rows].sort(byDateShiftName);
  return {
    title: 'Detailed attendance records',
    kpis: overallKpis(rows),
    landscape: true,
    sections: [{
      title: 'All records',
      note: `${list.length} record${list.length === 1 ? '' : 's'}`,
      columns: [COL.date, COL.shift, COL.id, COL.worker, COL.crew, COL.in, COL.out, COL.hours, COL.status, COL.flags, COL.approval],
      rows: list.map((r) => shiftRecordRow(ctx, r)),
      totals: { date: `${list.length} records`, hours: round2(list.reduce((a, r) => a + (r.hoursWorked || 0), 0)) }
    }]
  };
}

// Clock-in / clock-out detail, one line per worker per shift, grouped by
// worker. ctx.punchTimes: Map(summaryId -> [timestamps]) of the badges each
// shift captured. Rows with _group are group headers for the renderers.
function buildTimesheet(ctx, rows) {
  const shiftById = new Map(ctx.shifts.map((s) => [s.id, s]));
  const byWorker = new Map();
  for (const r of rows) {
    if (!byWorker.has(r.worker.id)) byWorker.set(r.worker.id, []);
    byWorker.get(r.worker.id).push(r);
  }
  const workers = [...byWorker.values()].sort((a, b) => byName(a[0], b[0]));

  const out = [];
  for (const list of workers) {
    list.sort((a, b) => a.date - b.date || a.shift.id - b.shift.id);
    const w = list[0].worker;
    const done = list.filter(worked);
    const hours = list.reduce((a, r) => a + (r.hoursWorked || 0), 0);
    const late = list.filter((r) => r.status === 'late' || r.lateIn).length;
    const absent = list.length - done.length;
    const bits = [crewNameOf(ctx, list[list.length - 1]), `${done.length} shift${done.length === 1 ? '' : 's'} worked`, `${hours.toFixed(2)} h`];
    if (late) bits.push(`${late} late`);
    if (absent) bits.push(`${absent} absent`);
    out.push({ _group: `${w.name} (${w.biostarUserId})`, _groupNote: bits.join(' · ') });

    for (const r of list) {
      const s = shiftById.get(r.shift.id);
      const dateStr = dateStrOf(r.date);
      const lateBy = s && r.checkIn && (r.status === 'late' || r.lateIn)
        ? Math.max(0, Math.round((new Date(r.checkIn).getTime() - eatInstant(dateStr, s.startTime)) / 60000))
        : null;
      const earlyBy = s && r.checkOut && r.earlyCheckOut
        ? Math.max(0, Math.round((eatInstant(dateStr, s.endTime, s.endTime <= s.startTime ? 1 : 0) - new Date(r.checkOut).getTime()) / 60000))
        : null;
      const badges = (ctx.punchTimes?.get(r.id) || []).map((t) => eatClock(t));
      out.push({
        id: w.biostarUserId, worker: w.name, date: dateStr, shift: r.shift.name,
        checkIn: r.checkIn, checkOut: r.checkOut, hours: r.hoursWorked, status: statusTags(r),
        lateBy, earlyBy, badges: badges.join(', '), flags: flagsOf(r)
      });
    }
  }

  const workedRows = rows.filter(worked);
  return {
    title: 'Clock-in / clock-out timesheet',
    landscape: true,
    kpis: overallKpis(rows),
    sections: [{
      title: 'Timesheet',
      note: `${workers.length} worker${workers.length === 1 ? '' : 's'} · ${rows.length} shift record${rows.length === 1 ? '' : 's'}`,
      columns: [
        { ...COL.id, hideInGroups: true },
        { ...COL.worker, hideInGroups: true },
        { ...COL.date, width: 1.4 },
        { ...COL.shift, width: 0.7 },
        { ...COL.in, width: 0.8 },
        { ...COL.out, width: 0.8 },
        { ...COL.hours, width: 0.7 },
        { ...COL.status, width: 1.1 },
        { key: 'lateBy', label: 'Late by', type: 'minutes', width: 0.8 },
        { key: 'earlyBy', label: 'Left early by', type: 'minutes', width: 0.9 },
        { key: 'badges', label: 'All badges (in order)', type: 'text', width: 2.2 },
        { ...COL.flags, label: 'Notes', width: 1.9 }
      ],
      rows: out,
      totals: { date: `${workedRows.length} shifts worked`, hours: round2(rows.reduce((a, r) => a + (r.hoursWorked || 0), 0)) }
    }],
    notes: [
      'Clock in is the first badge of the shift and clock out the last. "All badges" lists every badge the shift captured, including repeats; badges within 5 minutes of each other count as one.',
      'An implied time is a double shift with no badge at the changeover, split at the scheduled handover time.'
    ]
  };
}

const BUILDERS = {
  daily: buildDaily,
  timesheet: buildTimesheet,
  summary: buildSummary,
  individual: buildIndividual,
  register: buildRegister,
  hours: buildHours,
  exceptions: buildExceptions,
  'daily-totals': buildDailyTotals,
  crew: buildCrew,
  approvals: buildApprovals,
  detailed: buildDetailed
};

function standardNotes(ctx) {
  const shiftLine = ctx.shifts.map((s) => `${s.name} ${s.startTime}-${s.endTime}`).join(', ');
  const grace = ctx.shifts[0]?.graceMinutes ?? 30;
  return [
    `Times are East Africa Time (EAT, UTC+3). Shifts: ${shiftLine}. Night shifts are dated by the evening they start.`,
    `Late means checking in more than ${grace} minutes after the shift start. Hours are check-in to check-out with no meal deduction.`,
    'Approved records are locked; "Changed after approval" means new punches arrived since, and the approved values stand until re-approved.'
  ];
}

/**
 * @param {string} type    a REPORT_TYPES id
 * @param {object} ctx     { shifts, crewsById: Map, worker?, now?, scopeNote? }
 * @param {Array}  data    summary rows (worker/shift included) — or approval units for "approvals"
 * @param {object} period  from resolvePeriod()
 * @returns report model, or { error }
 */
function buildReport(type, ctx, data, period) {
  const builder = BUILDERS[type];
  if (!builder) return { error: 'Unknown report.' };
  const model = builder(ctx, data, period);
  if (model.error) return model;
  return {
    type,
    subtitle: null,
    landscape: false,
    ...model,
    period,
    notes: [...(model.notes || []), ...standardNotes(ctx)]
  };
}

module.exports = {
  REPORT_TYPES,
  catalogFor,
  applyColumnChoice,
  choiceKey,
  REPORT_COLUMNS,
  resolvePeriod,
  buildReport,
  STATUS_LABEL,
  TAG_LABEL,
  statusTags,
  fmtDay,
  weekdayOf,
  eatClock,
  mondayOf,
  addDays,
  MAX_REGISTER_DAYS
};
