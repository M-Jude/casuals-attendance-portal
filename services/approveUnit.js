// Approves one batch: applies any changes that arrived after an earlier
// approval, stamps every row as approved, and records the comments. Used by
// POST /api/approvals/:id/approve and scripts/approveBacklog.js — who may
// approve is the caller's check (sync/approvalLogic.js canApprove).

const { Prisma } = require('@prisma/client');
const prisma = require('../prismaClient');

const MAX_COMMENT = 2000;

// Throws { status: 409 } if the batch is already approved.
async function approveUnit(unit, { approverId, comment = null, rowComments = {}, now = new Date() }) {
  await prisma.$transaction(async (tx) => {
    // Claim the batch first: only one request can move it to approved, and
    // the row stays locked until this transaction ends, so a double click or
    // two approvers at once can't apply the pending changes twice or
    // overwrite who approved it.
    const claimed = await tx.approvalUnit.updateMany({
      where: { id: unit.id, status: { not: 'approved' } },
      data: { status: 'approved', approvedAt: now, approvedById: approverId, comment, reopenedAt: null }
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
        approvedById: approverId,
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
}

module.exports = { approveUnit, MAX_COMMENT };
