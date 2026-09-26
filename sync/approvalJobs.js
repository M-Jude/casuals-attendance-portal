// Approval reminders and escalation — run on a schedule from server.js.
//   - When a crew's shift ends, its supervisor is told it's ready (in-app).
//   - When a month ends, HR is told the permanent-staff month is ready.
//   - 48h after a crew shift became approvable, if still not approved, it
//     escalates to HR and the Admin Assistant (in-app + email).

const prisma = require('../prismaClient');
const { isEscalationDue } = require('./approvalLogic');
const { dateStrOf } = require('./scheduleResolver');
const { notifyUsers, usersWithRoles } = require('../services/notify');

const MAX_LISTED = 15;

// Reminders and escalations only cover batches from APPROVAL_TRACKING_FROM
// (YYYY-MM-DD) onwards — set it to the go-live date so switching approvals
// on doesn't flood everyone with every historical shift.
function isTracked(unit) {
  const from = process.env.APPROVAL_TRACKING_FROM;
  if (!from) return true;
  return unit.kind === 'crew-shift' ? dateStrOf(unit.date) >= from : unit.month >= from.slice(0, 7);
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
  const label = (u) => (u.kind === 'crew-shift'
    ? `${crewName.get(u.crewId) || 'Crew'} · ${shiftName.get(u.shiftId)} shift · ${dateStrOf(u.date)}`
    : `Permanent staff · ${u.month}`);

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

  // Month-end reminder to HR for permanent-Day/Night workers.
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

  // 48h escalation to HR and the Admin Assistant.
  const overdue = units.filter((u) => isEscalationDue(u, now));
  for (const [tenant, list] of groupBy(overdue, (u) => u.subcontractorName)) {
    await notifyUsers(await usersWithRoles(['hr', 'admin_assistant'], tenant), {
      type: 'approval-escalated',
      title: `${list.length} shift approval${list.length === 1 ? '' : 's'} overdue — escalated to you`,
      body: `These shifts were not approved by their supervisor within 48 hours and are now yours to approve:\n${listLines(list.map(label))}`,
      link: '/?page=approvals',
      email: true
    });
    await prisma.approvalUnit.updateMany({ where: { id: { in: list.map((u) => u.id) } }, data: { escalatedAt: new Date(now) } });
    escalated += list.length;
  }

  if (reminded || escalated) console.log(`Approval jobs: ${reminded} reminder(s), ${escalated} escalation(s).`);
  return { reminded, escalated };
}

module.exports = { runApprovalJobs };
