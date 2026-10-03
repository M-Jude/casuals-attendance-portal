// Unit tests for sync/approvalLogic.js — pure, no database.
//   node test/approvalLogicTest.js

const { planReconcile, canApprove, isEscalationDue, unitDueAt, crewUnitKey, hrUnitKey, hrUnitKind, unitLabel } = require('../sync/approvalLogic');

const DAY = { id: 1, name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '05:00', latestCheckOut: '05:00' };
const NIGHT = { id: 2, name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 30, earlyOutGraceMinutes: 0, earliestCheckIn: '14:00', latestCheckOut: '12:00' };
const HOUR = 3600 * 1000;

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

function row(overrides = {}) {
  return {
    casualWorkerId: 1, date: '2026-09-21', shiftId: 1, source: 'schedule',
    checkIn: new Date('2026-09-21T04:55:00Z'), checkOut: new Date('2026-09-21T14:05:00Z'),
    checkInImplied: false, checkOutImplied: false, status: 'on-time', lateIn: false,
    earlyCheckOut: false, hasMultiplePunches: false, hoursWorked: 9.17, regularHours: 9,
    approvalKey: crewUnitKey(3, '2026-09-21', 1), ...overrides
  };
}
function stored(overrides = {}) {
  return { id: 10, ...row(), date: new Date('2026-09-21T00:00:00Z'), approvedAt: null, changedAfterApproval: false, ...overrides };
}

// --- Recompute vs stored rows ---
{
  const p = planReconcile([stored()], [row({ checkOut: new Date('2026-09-21T14:30:00Z') })]);
  check('Unapproved row: replaced by the recomputed values', p.updates.length === 1 && p.flags.length === 0);

  const approved = stored({ approvedAt: new Date() });
  const same = planReconcile([approved], [row()]);
  check('Approved row, nothing changed: left alone', same.updates.length + same.flags.length + same.creates.length + same.deletes.length === 0);

  const changed = planReconcile([approved], [row({ checkOut: new Date('2026-09-21T16:46:00Z') })]);
  check('Approved row changed: locked, new values parked for re-approval', changed.flags.length === 1 && changed.updates.length === 0 && changed.flags[0].pendingValues.checkOut);
  check('Approved row changed: its batch is reopened', changed.reopenKeys.has(approved.approvalKey));

  const gone = planReconcile([approved], []);
  check('Approved row no longer produced: flagged as pending deletion, not deleted', gone.deletes.length === 0 && gone.flags[0]?.pendingValues.deleted === true);

  const goneUnapproved = planReconcile([stored()], []);
  check('Unapproved row no longer produced: deleted', goneUnapproved.deletes.length === 1);

  const added = planReconcile([], [row()]);
  check('New row: created, and its batch reopened if already approved', added.creates.length === 1 && added.reopenKeys.has(row().approvalKey));

  const ticked = planReconcile([stored({ approvedAt: new Date(), status: 'in-progress', checkOut: null, hoursWorked: null, regularHours: null })], [row({ status: 'no-checkout', checkOut: null, hoursWorked: null, regularHours: null })]);
  check('in-progress → no-checkout by the clock alone does not reopen an approved shift', ticked.flags.length === 0);

  const reverted = planReconcile([stored({ approvedAt: new Date(), changedAfterApproval: true, pendingValues: {} })], [row()]);
  check('Approved row whose change reverted: flag cleared', reverted.clears.length === 1);
}

// --- Due times ---
{
  check('Day shift batch is due at 17:00 EAT', unitDueAt({ kind: 'crew-shift', dateStr: '2026-09-21', shift: DAY }).toISOString() === '2026-09-21T14:00:00.000Z');
  check('Night shift batch is due at 08:00 EAT next morning', unitDueAt({ kind: 'crew-shift', dateStr: '2026-09-21', shift: NIGHT }).toISOString() === '2026-09-22T05:00:00.000Z');
  check('HR month batch is due at the start of the next month (EAT)', unitDueAt({ kind: 'hr-month', month: '2026-12' }).toISOString() === '2026-12-31T21:00:00.000Z');
}

// --- Escalation after 48h ---
{
  const due = new Date('2026-09-21T14:00:00Z');
  const unit = { kind: 'crew-shift', status: 'pending', dueAt: due, escalatedAt: null, reopenedAt: null };
  check('Not escalated at 47h', !isEscalationDue(unit, due.getTime() + 47 * HOUR));
  check('Escalated at 48h', isEscalationDue(unit, due.getTime() + 48 * HOUR));
  check('Approved units never escalate', !isEscalationDue({ ...unit, status: 'approved' }, due.getTime() + 100 * HOUR));
  check('Already-escalated units are not escalated again', !isEscalationDue({ ...unit, escalatedAt: new Date() }, due.getTime() + 100 * HOUR));
  const reopened = { ...unit, status: 'reopened', reopenedAt: new Date(due.getTime() + 72 * HOUR) };
  check('Reopened unit: 48h clock restarts from the reopening', !isEscalationDue(reopened, due.getTime() + 100 * HOUR) && isEscalationDue(reopened, due.getTime() + 120 * HOUR));
  check('HR month batches are not escalated', !isEscalationDue({ ...unit, kind: 'hr-month' }, due.getTime() + 500 * HOUR));
}

// --- Who may approve ---
{
  const due = new Date('2026-09-21T14:00:00Z');
  const after = due.getTime() + HOUR;
  const unit = { kind: 'crew-shift', crewId: 3, status: 'pending', dueAt: due, escalatedAt: null };
  check('Supervisor of the crew can approve after the shift ends', canApprove({ role: 'supervisor', crewId: 3 }, unit, after).ok);
  check('Supervisor cannot approve before the shift ends', !canApprove({ role: 'supervisor', crewId: 3 }, unit, due.getTime() - HOUR).ok);
  check('Another crew’s supervisor cannot approve', !canApprove({ role: 'supervisor', crewId: 4 }, unit, after).ok);
  check('HR cannot approve a crew shift before escalation', !canApprove({ role: 'hr' }, unit, after).ok);
  check('HR can approve once escalated', canApprove({ role: 'hr' }, { ...unit, escalatedAt: new Date() }, after).ok);
  check('Admin Assistant can approve once escalated', canApprove({ role: 'admin_assistant' }, { ...unit, escalatedAt: new Date() }, after).ok);
  check('Finance can never approve', !canApprove({ role: 'finance' }, { ...unit, escalatedAt: new Date() }, after).ok);
  check('System admin cannot approve (separation of duties), and is told why', !canApprove({ role: 'sysadmin' }, unit, due.getTime() + HOUR).ok && /System Admins/.test(canApprove({ role: 'sysadmin' }, unit, due.getTime() + HOUR).reason));
  const month = { kind: 'hr-month', status: 'pending', dueAt: new Date('2026-09-30T21:00:00Z') };
  check('HR approves the permanent-Day month once it has ended', canApprove({ role: 'hr' }, month, Date.parse('2026-10-01T06:00:00Z')).ok);
  check('HR cannot approve the month before it ends', !canApprove({ role: 'hr' }, month, Date.parse('2026-09-30T06:00:00Z')).ok);
  check('Supervisors cannot approve the HR month', !canApprove({ role: 'supervisor', crewId: 3 }, month, Date.parse('2026-10-01T06:00:00Z')).ok);
}

// --- Permanent staff: HR approves shift by shift from 1 Oct 2026 ---
{
  check('Before the cutover: monthly batch', hrUnitKind('2026-09-30') === 'hr-month' && hrUnitKey('A', '2026-09-30', 1) === 'hr:A:2026-09');
  check('From the cutover: one batch per shift per date', hrUnitKind('2026-10-01') === 'hr-shift'
    && hrUnitKey('A', '2026-10-01', 1) === 'hr:A:2026-10-01:1' && hrUnitKey('A', '2026-10-01', 2) === 'hr:A:2026-10-01:2');
  check('HR Night batch is due at 08:00 EAT next morning', unitDueAt({ kind: 'hr-shift', dateStr: '2026-10-01', shift: NIGHT }).toISOString() === '2026-10-02T05:00:00.000Z');
  check('Labels', unitLabel({ kind: 'hr-shift', date: new Date('2026-10-02T00:00:00Z') }, null, 'Day') === 'Permanent staff · Day · 2026-10-02'
    && unitLabel({ kind: 'hr-month', month: '2026-09' }) === 'Permanent staff · 2026-09'
    && unitLabel({ kind: 'crew-shift', date: new Date('2026-10-02T00:00:00Z') }, 'Crew A', 'Night') === 'Crew A · Night · 2026-10-02');

  const due = new Date('2026-10-02T14:00:00Z');
  const after = due.getTime() + HOUR;
  const shift = { kind: 'hr-shift', crewId: null, status: 'pending', dueAt: due, escalatedAt: null, reopenedAt: null };
  check('HR approves a permanent-staff shift once it ends', canApprove({ role: 'hr' }, shift, after).ok);
  check('HR cannot approve it before the shift ends', !canApprove({ role: 'hr' }, shift, due.getTime() - HOUR).ok);
  check('Admin Assistant cannot approve it before escalation', !canApprove({ role: 'admin_assistant' }, shift, after).ok);
  check('Admin Assistant can approve it once escalated', canApprove({ role: 'admin_assistant' }, { ...shift, escalatedAt: new Date() }, after).ok);
  check('Supervisors cannot approve it', !canApprove({ role: 'supervisor', crewId: 3 }, shift, after).ok);
  check('Supervisor with no crew cannot approve it', !canApprove({ role: 'supervisor', crewId: null }, shift, after).ok);
  check('Auditor and System Admin cannot approve it', !canApprove({ role: 'auditor' }, shift, after).ok && !canApprove({ role: 'sysadmin' }, shift, after).ok);
  check('It escalates after 48h', !isEscalationDue(shift, due.getTime() + 47 * HOUR) && isEscalationDue(shift, due.getTime() + 48 * HOUR));
}

// --- Confirming a suggested schedule is a label change, not a new attendance ---
{
  const approved = stored({ source: 'suggested', approvedAt: new Date('2026-09-22T10:00:00Z') });
  const p = planReconcile([approved], [row({ source: 'schedule' })]);
  check('Suggested → confirmed schedule on an approved row: not flagged for re-approval', p.flags.length === 0);
  check('  its label is brought up to date', p.relabels.length === 1 && p.relabels[0].source === 'schedule');
  const p2 = planReconcile([approved], [row({ source: 'unscheduled' })]);
  check('Other source changes on an approved row still need re-approval', p2.flags.length === 1);
  const held = stored({ source: 'suggested', approvedAt: new Date(), changedAfterApproval: true });
  const p3 = planReconcile([held], [row({ source: 'schedule' })]);
  check('A held row now matching its approved values is cleared, and its batch re-checked', p3.clears.length === 1 && p3.reopenKeys.has(held.approvalKey));
}

console.log('\nChecks:');
let allPassed = true;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) allPassed = false;
}
process.exit(allPassed ? 0 : 1);
