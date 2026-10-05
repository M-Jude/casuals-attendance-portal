// Pure approval rules — no database access — shared by
// sync/computeDailySummaries.js (locking approved rows on recompute),
// routes/approvals.js (who may approve what) and sync/approvalJobs.js
// (due reminders and 48h escalation).

const { shiftGeometry, eatToUtcMs } = require('./shiftEngine');

const ESCALATE_AFTER_MS = 48 * 60 * 60 * 1000;
const REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

// Fields that make up a row's reported attendance. A recompute that changes
// any of these on an approved row needs re-approval.
const COMPARED_FIELDS = [
  'source', 'checkIn', 'checkOut', 'checkInImplied', 'checkOutImplied', 'status', 'lateIn',
  'earlyCheckOut', 'hasMultiplePunches', 'hoursWorked', 'regularHours', 'approvalKey'
];

// "in-progress" turns into "no-checkout" by itself once the shift's window
// closes — that's the passage of time, not new information, so it mustn't
// reopen an approved shift.
function normaliseStatus(status) {
  return status === 'in-progress' ? 'no-checkout' : status;
}

// A shift judged against a worker's profiled pattern ("suggested") that HR
// then confirms as their schedule is the same shift — only the label
// changes, so it mustn't reopen an approved shift either.
function normaliseSource(source) {
  return source === 'suggested' ? 'schedule' : source;
}

function comparable(field, value) {
  if (value === null || value === undefined) return null;
  if (field === 'checkIn' || field === 'checkOut') return new Date(value).getTime();
  if (field === 'status') return normaliseStatus(value);
  if (field === 'source') return normaliseSource(value);
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
function planReconcile(existing, fresh) {
  const existingByKey = new Map(existing.map((r) => [rowKey(r), r]));
  // relabels: approved rows whose only difference is suggested -> schedule;
  // the label is brought up to date without touching the approval.
  const plan = { creates: [], updates: [], deletes: [], flags: [], clears: [], relabels: [], reopenKeys: new Set() };

  for (const f of fresh) {
    const e = existingByKey.get(rowKey(f));
    existingByKey.delete(rowKey(f));
    if (!e) {
      plan.creates.push(f);
      plan.reopenKeys.add(f.approvalKey);
    } else if (!e.approvedAt) {
      plan.updates.push({ id: e.id, data: f });
    } else if (sameAttendance(e, f)) {
      if (e.changedAfterApproval) {
        plan.clears.push(e.id);
        plan.reopenKeys.add(e.approvalKey); // re-checked: may be fully approved again
      }
      if (e.source !== f.source) plan.relabels.push({ id: e.id, source: f.source });
    } else {
      plan.flags.push({ id: e.id, pendingValues: f });
      plan.reopenKeys.add(e.approvalKey);
      plan.reopenKeys.add(f.approvalKey);
    }
  }

  for (const e of existingByKey.values()) {
    if (!e.approvedAt) plan.deletes.push(e.id);
    else {
      plan.flags.push({ id: e.id, pendingValues: { deleted: true } });
      plan.reopenKeys.add(e.approvalKey);
    }
  }
  return plan;
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
//   sysadmin   — always (super user)
function canApprove(user, unit, now) {
  if (unit.status === 'approved') return { ok: false, reason: 'Already approved.' };
  if (user.role === 'auditor') return { ok: false, reason: 'Auditors can view approvals but not approve them.' };
  if (user.role === 'director') return { ok: false, reason: 'Directors can view approvals but not approve them.' };
  // Approving attendance is a payroll decision, not an IT one: System Admins
  // (UCAA ICT) can see every batch but approving belongs to supervisors, HR
  // and the Admin Assistant.
  if (user.role === 'sysadmin') return { ok: false, reason: 'System Admins can view approvals but not approve them — that’s for the crew’s supervisor, HR or the Admin Assistant.' };
  const due = now >= new Date(unit.dueAt).getTime();
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
