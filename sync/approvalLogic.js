// Pure approval rules — no database access — shared by
// sync/computeDailySummaries.js (locking approved rows on recompute),
// routes/approvals.js (who may approve what) and sync/approvalJobs.js
// (due reminders and 48h escalation).

const { shiftGeometry, eatToUtcMs } = require('./shiftEngine');

const ESCALATE_AFTER_MS = 48 * 60 * 60 * 1000;
const REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

// Fields that make up a row's reported attendance. A recompute that changes
// any of these on an approved row needs re-approval. Not `source` (the
// label: scheduled, exception, "Schedule not confirmed", unscheduled): with
// the same times and status it's the same shift, so a label change is
// brought up to date without reopening anything (plan.relabels).
const COMPARED_FIELDS = [
  'checkIn', 'checkOut', 'checkInImplied', 'checkOutImplied', 'status', 'lateIn',
  'earlyCheckOut', 'hasMultiplePunches', 'hoursWorked', 'regularHours', 'approvalKey'
];

// "in-progress" turns into "no-checkout" by itself once the shift's window
// closes — that's the passage of time, not new information, so it mustn't
// reopen an approved shift.
function normaliseStatus(status) {
  return status === 'in-progress' ? 'no-checkout' : status;
}

function comparable(field, value) {
  if (value === null || value === undefined) return null;
  if (field === 'checkIn' || field === 'checkOut') return new Date(value).getTime();
  if (field === 'status') return normaliseStatus(value);
  return value;
}

function sameAttendance(a, b) {
  return COMPARED_FIELDS.every((f) => comparable(f, a[f]) === comparable(f, b[f]));
}

function rowKey(r) {
  const date = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date;
  return `${r.casualWorkerId}|${date}|${r.shiftId}`;
}

// Decides what a recompute does to the stored rows it covers.
//   existing — stored DailyAttendanceSummary rows in the recomputed range
//   fresh    — newly computed rows for the same range (plain objects with the
//              stored field names, date as YYYY-MM-DD)
// Unapproved rows are simply replaced. Approved rows are never overwritten:
// a difference is parked in pendingValues and the row flagged, and its
// approval unit reopened.
//
// guard (optional) protects approved history from guesses — dates where the
// worker has no confirmed schedule or exception, so they're judged against
// the nightly profiler's suggested pattern, which can change any night:
//   guard.guessed(row)    — the row's date is judged against a guess
//   guard.active(punchId) — the badge still counts (not set aside or gone)
//   guard.approvedKey(k)  — batch k has been approved before
// On such dates, an approved row whose badges are unchanged is kept as
// approved (a held change on it is dropped), and a new row the guess adds
// to an approved batch with no new badges (e.g. an absence the guess
// implies) isn't added. A badge that's new, set aside or removed still
// counts as a change.
function planReconcile(existing, fresh, guard = null) {
  const existingByKey = new Map(existing.map((r) => [rowKey(r), r]));
  // relabels: approved rows whose only difference is the label (source);
  // brought up to date without touching the approval.
  const plan = { creates: [], updates: [], deletes: [], flags: [], clears: [], relabels: [], reopenKeys: new Set() };

  // Badges already in this worker's approved rows, per worker.
  const approvedPunches = new Map();
  for (const e of existing) {
    if (!e.approvedAt) continue;
    if (!approvedPunches.has(e.casualWorkerId)) approvedPunches.set(e.casualWorkerId, new Set());
    for (const id of punchesOf(e)) approvedPunches.get(e.casualWorkerId).add(id);
  }
  const guessOnly = {
    // An approved row the guess would change without any badge changing.
    keep: (e, f) => !!guard && guard.guessed(e)
      && (f ? samePunches(e, f) : punchesOf(e).every((id) => guard.active(id))),
    // A row the guess would add to an approved batch with no new badges.
    skip: (f) => !!guard && guard.guessed(f) && guard.approvedKey(f.approvalKey)
      && punchesOf(f).every((id) => approvedPunches.get(f.casualWorkerId)?.has(id))
  };
  const keepApproved = (e) => {
    if (e.changedAfterApproval) {
      plan.clears.push(e.id);
      plan.reopenKeys.add(e.approvalKey); // re-checked: may be fully approved again
    }
  };

  for (const f of fresh) {
    const e = existingByKey.get(rowKey(f));
    existingByKey.delete(rowKey(f));
    if ((!e || !e.approvedAt) && guessOnly.skip(f)) {
      // Not added — and one added earlier, before this guard, is taken out.
      if (e) { plan.deletes.push(e.id); plan.reopenKeys.add(e.approvalKey); }
      continue;
    }
    if (!e) {
      plan.creates.push(f);
      plan.reopenKeys.add(f.approvalKey);
    } else if (!e.approvedAt) {
      plan.updates.push({ id: e.id, data: f });
    } else if (sameAttendance(e, f)) {
      keepApproved(e);
      if (e.source !== f.source) plan.relabels.push({ id: e.id, source: f.source });
    } else if (guessOnly.keep(e, f)) {
      keepApproved(e);
    } else {
      plan.flags.push({ id: e.id, pendingValues: f });
      plan.reopenKeys.add(e.approvalKey);
      plan.reopenKeys.add(f.approvalKey);
    }
  }

  for (const e of existingByKey.values()) {
    if (!e.approvedAt) plan.deletes.push(e.id);
    else if (guessOnly.keep(e, null)) keepApproved(e);
    else {
      plan.flags.push({ id: e.id, pendingValues: { deleted: true } });
      plan.reopenKeys.add(e.approvalKey);
    }
  }
  return plan;
}

const punchesOf = (r) => (Array.isArray(r.punchIds) ? r.punchIds : []);
function samePunches(a, b) {
  const x = new Set(punchesOf(a));
  const y = punchesOf(b);
  return x.size === new Set(y).size && y.every((id) => x.has(id));
}

function crewUnitKey(crewId, dateStr, shiftId) {
  return `crew:${crewId}:${dateStr}:${shiftId}`;
}

// HR's batches (permanent staff and anyone not on a crew): from
// HR_DAILY_FROM, one per shift per date (hr-shift), like a crew's; before
// it, one per month (hr-month). The cutover is fixed so a recompute of older
// dates keeps their rows in the monthly batch they were approved in.
const HR_DAILY_FROM = '2026-10-01';

function hrUnitKind(dateStr) {
  return dateStr < HR_DAILY_FROM ? 'hr-month' : 'hr-shift';
}

function hrUnitKey(subcontractorName, dateStr, shiftId) {
  return hrUnitKind(dateStr) === 'hr-month'
    ? `hr:${subcontractorName}:${dateStr.slice(0, 7)}`
    : `hr:${subcontractorName}:${dateStr}:${shiftId}`;
}

// A batch's name, e.g. "Crew A · Day · 2026-10-02",
// "Permanent staff · Night · 2026-10-02" or "Permanent staff · 2026-09".
function unitLabel(unit, crewName, shiftName) {
  if (unit.kind === 'hr-month') return `Permanent staff · ${unit.month}`;
  const who = unit.kind === 'crew-shift' ? crewName || 'Crew' : 'Permanent staff';
  return `${who} · ${shiftName || ''} · ${new Date(unit.date).toISOString().slice(0, 10)}`;
}

// When an approval unit becomes approvable: a crew or HR shift once the
// shift's scheduled end has passed; an HR month on the first day of the next
// month.
function unitDueAt({ kind, dateStr, shift, month }) {
  if (kind === 'crew-shift' || kind === 'hr-shift') return new Date(shiftGeometry(shift, dateStr).end);
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return new Date(eatToUtcMs(next, '00:00'));
}

// The 48h escalation clock restarts when an approved unit is reopened by a
// later change.
function escalationDueAt(unit) {
  const start = Math.max(new Date(unit.dueAt).getTime(), unit.reopenedAt ? new Date(unit.reopenedAt).getTime() : 0);
  return new Date(start + ESCALATE_AFTER_MS);
}

// An unapproved batch is overdue 24h after it became approvable (or was
// reopened), and its approvers are reminded then and every 24h after, until
// it's approved. An escalation counts as a reminder.
function isOverdueReminderDue(unit, now) {
  if (unit.status === 'approved') return false;
  const start = Math.max(new Date(unit.dueAt).getTime(), unit.reopenedAt ? new Date(unit.reopenedAt).getTime() : 0);
  const last = unit.overdueRemindedAt ? new Date(unit.overdueRemindedAt).getTime() : 0;
  return now >= Math.max(start, last) + REMIND_EVERY_MS;
}

// Who can approve a batch right now (and so is reminded about it): the
// crew's supervisors (crewId) and/or everyone with one of `roles`.
function approversOf(unit) {
  const escalated = !!unit.escalatedAt;
  if (unit.kind === 'crew-shift') return { crewId: unit.crewId, roles: escalated ? ['hr', 'admin_assistant'] : [] };
  if (unit.kind === 'hr-shift') return { crewId: null, roles: escalated ? ['hr', 'admin_assistant'] : ['hr'] };
  return { crewId: null, roles: ['hr'] };
}

function isEscalationDue(unit, now) {
  return (unit.kind === 'crew-shift' || unit.kind === 'hr-shift') && unit.status !== 'approved' && !unit.escalatedAt && now >= escalationDueAt(unit).getTime();
}

// Who may approve a unit right now:
//   crew-shift — the crew's supervisor once the shift has ended; HR or the
//                Admin Assistant once it has been escalated
//   hr-shift   — HR once the shift has ended; the Admin Assistant too once
//                it has been escalated
//   hr-month   — HR once the month has ended
//   sysadmin   — any batch once it's approvable (its shift or month has
//                ended), without waiting for escalation
function canApprove(user, unit, now) {
  if (unit.status === 'approved') return { ok: false, reason: 'Already approved.' };
  if (user.role === 'auditor') return { ok: false, reason: 'Auditors can view approvals but not approve them.' };
  if (user.role === 'director') return { ok: false, reason: 'Directors can view approvals but not approve them.' };
  const due = now >= new Date(unit.dueAt).getTime();
  if (user.role === 'sysadmin') {
    return due ? { ok: true } : { ok: false, reason: unit.kind === 'hr-month' ? 'The month has not ended yet.' : 'This shift has not ended yet.' };
  }
  if (unit.kind === 'crew-shift') {
    if (user.role === 'supervisor' && user.crewId === unit.crewId) {
      return due ? { ok: true } : { ok: false, reason: 'This shift has not ended yet.' };
    }
    if ((user.role === 'hr' || user.role === 'admin_assistant') && unit.escalatedAt) return { ok: true };
    return { ok: false, reason: 'Only this crew’s supervisor can approve, or HR / Admin Assistant once escalated.' };
  }
  if (unit.kind === 'hr-shift') {
    if (user.role === 'hr') return due ? { ok: true } : { ok: false, reason: 'This shift has not ended yet.' };
    if (user.role === 'admin_assistant' && unit.escalatedAt) return { ok: true };
    return { ok: false, reason: 'Only HR can approve permanent staff, or the Admin Assistant once escalated.' };
  }
  if (unit.kind === 'hr-month' && user.role === 'hr') {
    return due ? { ok: true } : { ok: false, reason: 'The month has not ended yet.' };
  }
  return { ok: false, reason: 'You cannot approve this.' };
}


module.exports = {
  planReconcile,
  sameAttendance,
  crewUnitKey,
  hrUnitKey,
  hrUnitKind,
  unitLabel,
  unitDueAt,
  escalationDueAt,
  isEscalationDue,
  isOverdueReminderDue,
  approversOf,
  canApprove,
  ESCALATE_AFTER_MS,
  COMPARED_FIELDS
};
