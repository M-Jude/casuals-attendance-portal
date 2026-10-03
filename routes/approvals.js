const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole } = require('../middleware/requireRole');
const { canApprove, escalationDueAt, unitLabel } = require('../sync/approvalLogic');
const { dateStrOf } = require('../sync/scheduleResolver');
const { normalizeDoubles } = require('../reports/doubleShift');
const { accountNameResolver } = require('../services/accountNames');

const router = express.Router();
const APPROVERS = ['hr', 'admin_assistant', 'supervisor'];
// Who may look at batches: the approvers, plus the System Admin, the Auditor
// and the Director, who see every batch (unitScope gives roles it doesn't
// name everything) but can't approve: canApprove refuses them.
const VIEWERS = [...APPROVERS, 'sysadmin', 'auditor', 'director'];
const MAX_COMMENT = 2000;

// Which batches a user sees under "my approvals":
//   supervisor      — their crew's shifts
//   hr              — permanent staff's shifts (and older months) + escalated crew shifts
//   admin_assistant — escalated crew and permanent-staff shifts
//   sysadmin        — everything
function unitScope(user, scope) {
  const where = { subcontractorName: user.subcontractorName };
  if (scope === 'all' && ['sysadmin', 'hr', 'admin_assistant'].includes(user.role)) return where;
  if (user.role === 'supervisor') return { ...where, kind: 'crew-shift', crewId: user.crewId ?? -1 };
  if (user.role === 'hr') return { ...where, OR: [{ kind: { in: ['hr-shift', 'hr-month'] } }, { escalatedAt: { not: null } }] };
  if (user.role === 'admin_assistant') return { ...where, escalatedAt: { not: null } };
  return where;
}

async function describeUnits(units, user) {
  if (units.length === 0) return [];
  const [crews, shifts, counts] = await Promise.all([
    prisma.crew.findMany({ where: { id: { in: units.map((u) => u.crewId).filter(Boolean) } } }),
    prisma.shift.findMany(),
    prisma.dailyAttendanceSummary.groupBy({
      by: ['approvalKey', 'status', 'changedAfterApproval'],
      where: { approvalKey: { in: units.map((u) => u.key) } },
      _count: { _all: true }
    })
  ]);
  const crewName = new Map(crews.map((c) => [c.id, c.name]));
  const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
  const now = Date.now();

  return units.map((u) => {
    const mine = counts.filter((c) => c.approvalKey === u.key);
    const byStatus = {};
    let rows = 0;
    let changed = 0;
    for (const c of mine) {
      rows += c._count._all;
      byStatus[c.status] = (byStatus[c.status] || 0) + c._count._all;
      if (c.changedAfterApproval) changed += c._count._all;
    }
    const permission = canApprove(user, u, now);
    return {
      id: u.id,
      kind: u.kind,
      label: unitLabel(u, crewName.get(u.crewId), shiftName.get(u.shiftId)),
      crewName: crewName.get(u.crewId) || null,
      shiftName: shiftName.get(u.shiftId) || null,
      date: u.date ? dateStrOf(u.date) : null,
      month: u.month,
      dueAt: u.dueAt,
      escalatesAt: u.kind !== 'hr-month' && u.status !== 'approved' ? escalationDueAt(u) : null,
      status: u.status,
      open: now < new Date(u.dueAt).getTime(),
      escalatedAt: u.escalatedAt,
      reopenedAt: u.reopenedAt,
      approvedAt: u.approvedAt,
      comment: u.comment,
      rows,
      changed,
      byStatus,
      canApprove: permission.ok,
      cannotApproveReason: permission.ok ? null : permission.reason
    };
  });
}

router.get('/approvals', authenticate, requireRole(...VIEWERS), async (req, res) => {
  const status = ['pending', 'approved', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const where = unitScope(req.user, req.query.scope);
  if (status === 'pending') where.status = { in: ['pending', 'reopened'] };
  if (status === 'approved') where.status = 'approved';

  try {
    const units = await prisma.approvalUnit.findMany({ where, orderBy: [{ dueAt: 'desc' }], take: 2000 });
    res.json({ units: await describeUnits(units, req.user) });
  } catch (err) {
    console.error('Failed to list approvals:', err);
    res.status(500).json({ error: 'Could not load approvals.' });
  }
});

async function loadVisibleUnit(user, id) {
  const unit = await prisma.approvalUnit.findFirst({ where: { id, subcontractorName: user.subcontractorName } });
  if (!unit) return null;
  if (user.role === 'supervisor' && unit.crewId !== user.crewId) return null;
  return unit;
}

// Marks each row that is half of a same-date Day + Night double shift with
// `double`: the other shift (which its own supervisor approves), this
// shift's share of the hours and the double's total, first clock-in and
// last clock-out — so the approver can see the worker really worked both.
async function describeDoubles(rows, key) {
  if (rows.length === 0) return;
  const dates = rows.map((r) => r.date.getTime());
  const partners = await prisma.dailyAttendanceSummary.findMany({
    where: {
      casualWorkerId: { in: [...new Set(rows.map((r) => r.casualWorkerId))] },
      date: { gte: new Date(Math.min(...dates)), lte: new Date(Math.max(...dates)) },
      NOT: { approvalKey: key }
    },
    include: { worker: { select: { id: true, name: true, biostarUserId: true } }, shift: { select: { id: true, name: true } } }
  });
  const normalized = new Map(normalizeDoubles([...rows, ...partners]).map((r) => [r.id, r]));
  const crewIds = [...new Set(partners.map((p) => p.approvalCrewId).filter(Boolean))];
  const crews = new Map((await prisma.crew.findMany({ where: { id: { in: crewIds } } })).map((c) => [c.id, c.name]));
  for (const r of rows) {
    const n = normalized.get(r.id);
    if (!n?.double) continue;
    const partner = normalized.get(n.double.partnerId);
    const [day, night] = n.double.part === 'Day' ? [n, partner] : [partner, n];
    r.double = {
      part: n.double.part,
      partnerShift: partner.shift.name,
      partnerApprover: partner.approvalCrewId ? `${crews.get(partner.approvalCrewId) || 'its crew'}'s supervisor` : 'HR',
      partnerApproved: !!partner.approvedAt && !partner.changedAfterApproval,
      shareHours: n.hoursWorked,
      totalHours: n.double.totalHours,
      changeover: n.double.changeover,
      checkIn: day.checkIn,
      checkOut: night.checkOut
    };
  }
}

router.get('/approvals/:id', authenticate, requireRole(...VIEWERS), async (req, res) => {
  try {
    const unit = await loadVisibleUnit(req.user, parseInt(req.params.id, 10));
    if (!unit) return res.status(404).json({ error: 'Not found.' });
    const [described] = await describeUnits([unit], req.user);
    const rows = await prisma.dailyAttendanceSummary.findMany({
      where: { approvalKey: unit.key },
      include: {
        worker: { select: { id: true, name: true, biostarUserId: true } },
        shift: { select: { id: true, name: true } }
      },
      orderBy: [{ date: 'asc' }, { worker: { name: 'asc' } }]
    });
    await describeDoubles(rows, unit.key);
    // Still named if the approver's account has since been deleted.
    const approver = unit.approvedById
      ? { name: (await accountNameResolver([unit.approvedById]))(unit.approvedById, unit.approvedAt) }
      : null;
    res.json({ unit: { ...described, approvedBy: approver }, rows });
  } catch (err) {
    console.error('Failed to load approval:', err);
    res.status(500).json({ error: 'Could not load this approval.' });
  }
});

// Approves a whole batch: applies any changes that arrived after an earlier
// approval, stamps every row as approved, and records the comments.
router.post('/approvals/:id/approve', authenticate, requireRole(...APPROVERS), async (req, res) => {
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.slice(0, MAX_COMMENT) : null;
  const rowComments = req.body?.rowComments && typeof req.body.rowComments === 'object' ? req.body.rowComments : {};

  try {
    const unit = await loadVisibleUnit(req.user, parseInt(req.params.id, 10));
    if (!unit) return res.status(404).json({ error: 'Not found.' });
    if (unit.status === 'approved') return res.status(409).json({ error: 'This has already been approved.', code: 'ALREADY_DONE' });
    const permission = canApprove(req.user, unit, Date.now());
    if (!permission.ok) return res.status(403).json({ error: permission.reason });

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      // Claim the batch first: only one request can move it to approved, and
      // the row stays locked until this transaction ends, so a double click or
      // two approvers at once can't apply the pending changes twice or
      // overwrite who approved it.
      const claimed = await tx.approvalUnit.updateMany({
        where: { id: unit.id, status: { not: 'approved' } },
        data: { status: 'approved', approvedAt: now, approvedById: req.user.id, comment, reopenedAt: null }
      });
      if (claimed.count === 0) throw Object.assign(new Error('This has already been approved.'), { status: 409 });

      const rows = await tx.dailyAttendanceSummary.findMany({ where: { approvalKey: unit.key } });
      for (const row of rows) {
        const pending = row.changedAfterApproval ? row.pendingValues : null;
        if (pending && pending.deleted) {
          await tx.dailyAttendanceSummary.delete({ where: { id: row.id } });
          continue;
        }
        const data = {
          approvedAt: now,
          approvedById: req.user.id,
          changedAfterApproval: false,
          pendingValues: Prisma.JsonNull
        };
        if (pending) {
          for (const field of ['source', 'status', 'lateIn', 'earlyCheckOut', 'hasMultiplePunches', 'hoursWorked', 'regularHours', 'checkInImplied', 'checkOutImplied', 'punchIds', 'approvalKey', 'approvalCrewId']) {
            if (field in pending) data[field] = pending[field];
          }
          data.checkIn = pending.checkIn ? new Date(pending.checkIn) : null;
          data.checkOut = pending.checkOut ? new Date(pending.checkOut) : null;
        }
        if (typeof rowComments[row.id] === 'string') data.supervisorComment = rowComments[row.id].slice(0, MAX_COMMENT) || null;
        await tx.dailyAttendanceSummary.update({ where: { id: row.id }, data });
      }
    });

    res.json({ success: true });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message, code: 'ALREADY_DONE' });
    console.error('Approval failed:', err);
    res.status(500).json({ error: 'Could not approve.' });
  }
});

module.exports = router;
