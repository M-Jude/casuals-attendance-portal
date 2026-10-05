// Approval reminders and escalation — run on a schedule from server.js.
//   - When a crew's shift ends, its supervisor is told it's ready (in-app).
//   - When a permanent-staff shift ends, HR is told it's ready (in-app); an
//     older monthly batch, when its month ends (in-app + email).
//   - 24h after a batch became approvable, if still not approved, everyone
//     who can approve it is emailed a reminder, then again every 24h.
//   - 48h after a shift became approvable, if still not approved, it
//     escalates to HR and the Admin Assistant (in-app + email); a crew's
//     supervisors are emailed that it was escalated.
// Every email lists each batch's records, issues and escalation timing.

const prisma = require('../prismaClient');
const { isEscalationDue, isOverdueReminderDue, approversOf, escalationDueAt, unitLabel } = require('./approvalLogic');
const { dateStrOf } = require('./scheduleResolver');
const { notifyUsers, usersWithRoles } = require('../services/notify');

const MAX_LISTED = 15;

// Reminders and escalations only cover batches from APPROVAL_TRACKING_FROM
// (YYYY-MM-DD) onwards — set it to the go-live date so switching approvals
// on doesn't flood everyone with every historical shift.
function isTracked(unit) {
  const from = process.env.APPROVAL_TRACKING_FROM;
  if (!from) return true;
  return unit.kind === 'hr-month' ? unit.month >= from.slice(0, 7) : dateStrOf(unit.date) >= from;
}

function listLines(labels) {
  const lines = labels.slice(0, MAX_LISTED).map((l) => `• ${l}`);
  if (labels.length > MAX_LISTED) lines.push(`…and ${labels.length - MAX_LISTED} more`);
  return lines.join('\n');
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

async function runApprovalJobs(now = Date.now()) {
  const units = (await prisma.approvalUnit.findMany({
    where: { status: { in: ['pending', 'reopened'] }, dueAt: { lte: new Date(now) } }
  })).filter(isTracked);
  if (units.length === 0) return { reminded: 0, escalated: 0 };

  const [crews, shifts] = await Promise.all([prisma.crew.findMany(), prisma.shift.findMany()]);
  const crewName = new Map(crews.map((c) => [c.id, c.name]));
  const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
  const label = (u) => unitLabel(u, crewName.get(u.crewId), shiftName.get(u.shiftId));

  let reminded = 0;
  let escalated = 0;

  // Ready-for-approval reminders to each crew's supervisors.
  const dueCrew = units.filter((u) => u.kind === 'crew-shift' && !u.dueNotifiedAt);
  for (const [crewId, list] of groupBy(dueCrew, (u) => u.crewId)) {
    const supervisors = await prisma.portalUser.findMany({ where: { role: 'supervisor', crewId, active: true } });
    await notifyUsers(supervisors, {
      type: 'approval-due',
      title: `${list.length} shift${list.length === 1 ? '' : 's'} ready for your approval`,
      body: `These shifts have ended and are waiting for your approval:\n${listLines(list.map(label))}\n\nUnapproved shifts escalate to HR after 48 hours.`,
      link: '/?page=approvals'
    });
    await prisma.approvalUnit.updateMany({ where: { id: { in: list.map((u) => u.id) } }, data: { dueNotifiedAt: new Date(now) } });
    reminded += list.length;
  }

  // Ready-for-approval reminders to HR for permanent-staff shifts.
  const dueHrShifts = units.filter((u) => u.kind === 'hr-shift' && !u.dueNotifiedAt);
  for (const [tenant, list] of groupBy(dueHrShifts, (u) => u.subcontractorName)) {
    await notifyUsers(await usersWithRoles(['hr'], tenant), {
      type: 'approval-due',
      title: `${list.length} permanent-staff shift${list.length === 1 ? '' : 's'} ready for your approval`,
      body: `These shifts have ended and are waiting for your approval:\n${listLines(list.map(label))}\n\nUnapproved shifts escalate to the Admin Assistant after 48 hours.`,
      link: '/?page=approvals'
    });
    await prisma.approvalUnit.updateMany({ where: { id: { in: list.map((u) => u.id) } }, data: { dueNotifiedAt: new Date(now) } });
    reminded += list.length;
  }

  // Month-end reminder to HR for the older monthly batches.
  const dueMonths = units.filter((u) => u.kind === 'hr-month' && !u.dueNotifiedAt);
  for (const [tenant, list] of groupBy(dueMonths, (u) => u.subcontractorName)) {
    await notifyUsers(await usersWithRoles(['hr'], tenant), {
      type: 'approval-due',
      title: 'Permanent staff attendance ready for month-end approval',
      body: `The month has ended — please review and approve:\n${listLines(list.map(label))}`,
      link: '/?page=approvals',
      email: true
    });
    await prisma.approvalUnit.updateMany({ where: { id: { in: list.map((u) => u.id) } }, data: { dueNotifiedAt: new Date(now) } });
    reminded += list.length;
  }

  const toEscalate = units.filter((u) => isEscalationDue(u, now));
  const toRemind = units.filter((u) => !toEscalate.includes(u) && isOverdueReminderDue(u, now));
  const stats = await batchStats([...toEscalate, ...toRemind]);
  const describe = (u) => describeBatch(u, { label: label(u), stats: stats.get(u.key), now });

  // 48h escalation: HR and the Admin Assistant can now approve (in-app +
  // email, with each batch's details), and a crew's supervisors are told
  // their shift went over their heads — they can still approve it.
  for (const [tenant, list] of groupBy(toEscalate, (u) => u.subcontractorName)) {
    const at = new Date(now);
    list.forEach((u) => { u.escalatedAt = at; });
    await notifyUsers(await usersWithRoles(['hr', 'admin_assistant'], tenant), {
      type: 'approval-escalated',
      title: `${list.length} shift approval${list.length === 1 ? '' : 's'} overdue — escalated to you`,
      body: `These shifts were not approved within 48 hours of ending and are now yours to approve:\n\n${list.map(describe).join('\n')}${PAYROLL_NOTE}`,
      link: '/?page=approvals',
      email: true
    });
    for (const [crewId, crewList] of groupBy(list.filter((u) => u.kind === 'crew-shift'), (u) => u.crewId)) {
      const supervisors = await prisma.portalUser.findMany({ where: { role: 'supervisor', crewId, active: true } });
      await notifyUsers(supervisors, {
        type: 'approval-escalated',
        title: `${crewList.length} of your crew’s shift${crewList.length === 1 ? '' : 's'} escalated to HR`,
        body: `These shifts were not approved within 48 hours, so HR and the Admin Assistant have been asked to approve them. You can still approve them yourself:\n\n${crewList.map(describe).join('\n')}`,
        link: '/?page=approvals',
        email: true
      });
    }
    // The escalation email counts as the day's reminder.
    await prisma.approvalUnit.updateMany({ where: { id: { in: list.map((u) => u.id) } }, data: { escalatedAt: at, overdueRemindedAt: at } });
    escalated += list.length;
  }

  // Overdue reminders: 24h after a batch became approvable, then every 24h
  // until it's approved, one email per person listing every overdue batch
  // they can approve.
  const byUser = new Map();
  for (const u of toRemind) {
    const { crewId, roles } = approversOf(u);
    const people = [
      ...(crewId ? await prisma.portalUser.findMany({ where: { role: 'supervisor', crewId, active: true } }) : []),
      ...(roles.length ? await usersWithRoles(roles, u.subcontractorName) : [])
    ];
    for (const p of people) {
      if (!byUser.has(p.id)) byUser.set(p.id, { user: p, list: [] });
      byUser.get(p.id).list.push(u);
    }
  }
  for (const { user, list } of byUser.values()) {
    list.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    await notifyUsers([user], {
      type: 'approval-overdue',
      title: `${list.length} shift approval${list.length === 1 ? '' : 's'} overdue — waiting for you`,
      body: `Hello${user.name ? ` ${user.name}` : ''},\n\nThese have been waiting for approval for more than 24 hours:\n\n${list.map(describe).join('\n')}${PAYROLL_NOTE}`,
      link: '/?page=approvals',
      email: true
    });
  }
  if (toRemind.length) {
    await prisma.approvalUnit.updateMany({ where: { id: { in: toRemind.map((u) => u.id) } }, data: { overdueRemindedAt: new Date(now) } });
    reminded += toRemind.length;
  }

  if (reminded || escalated) console.log(`Approval jobs: ${reminded} reminder(s), ${escalated} escalation(s).`);
  return { reminded, escalated };
}

const PAYROLL_NOTE = '\n\nFinance only sees approved records, so these shifts are held back from payroll until they are approved.';

// Per batch: { rows, byStatus, changed } from its stored rows.
async function batchStats(units) {
  const stats = new Map(units.map((u) => [u.key, { rows: 0, byStatus: {}, changed: 0 }]));
  if (units.length === 0) return stats;
  const counts = await prisma.dailyAttendanceSummary.groupBy({
    by: ['approvalKey', 'status', 'changedAfterApproval'],
    where: { approvalKey: { in: units.map((u) => u.key) } },
    _count: { _all: true }
  });
  for (const c of counts) {
    const s = stats.get(c.approvalKey);
    s.rows += c._count._all;
    s.byStatus[c.status] = (s.byStatus[c.status] || 0) + c._count._all;
    if (c.changedAfterApproval) s.changed += c._count._all;
  }
  return stats;
}

const eat = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Two lines about one batch for a reminder or escalation email: what's in
// it, how long it has waited, and where it stands on escalation.
function describeBatch(unit, { label, stats = { rows: 0, byStatus: {}, changed: 0 }, now }) {
  const b = stats.byStatus;
  const issues = [
    b.late && `${b.late} late`,
    b['no-show'] && `${b['no-show']} absent`,
    (b['no-checkin'] || 0) + (b['no-checkout'] || 0) && plural((b['no-checkin'] || 0) + (b['no-checkout'] || 0), 'missing punch'),
    stats.changed && `${stats.changed} changed after approval`
  ].filter(Boolean);
  const since = Math.max(new Date(unit.dueAt).getTime(), unit.reopenedAt ? new Date(unit.reopenedAt).getTime() : 0);
  const waited = Math.floor((now - since) / 3600000);
  const escalateTo = unit.kind === 'hr-shift' ? 'the Admin Assistant' : 'HR and the Admin Assistant';
  const escalation = unit.kind === 'hr-month' ? ''
    : unit.escalatedAt ? ` Escalated ${eat(unit.escalatedAt)} to ${escalateTo}.`
      : ` Escalates to ${escalateTo} ${eat(escalationDueAt(unit))}.`;
  return `• ${label}${unit.status === 'reopened' ? ' (changed — re-approve)' : ''}: ${plural(stats.rows, 'record')}${issues.length ? ` — ${issues.join(', ')}` : ''}\n`
    + `  ${unit.status === 'reopened' ? 'Reopened' : 'Approvable since'} ${eat(since)} (${waited} h ago).${escalation}`;
}

module.exports = { runApprovalJobs, describeBatch };
