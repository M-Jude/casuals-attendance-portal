// Approving attendance:
//   approveUnit    — a whole batch: POST /api/approvals/:id/approve and
//                    scripts/approveBacklog.js
//   reapproveRows  — just the approved records a schedule change held for
//                    re-approval, when the person making the change ticked
//                    "re-approve automatically" (services/recompute.js)
// Who may approve is the caller's check (sync/approvalLogic.js canApprove).

const { Prisma } = require('@prisma/client');
const prisma = require('../prismaClient');

const MAX_COMMENT = 2000;
const PENDING_FIELDS = ['source', 'status', 'lateIn', 'earlyCheckOut', 'hasMultiplePunches', 'hoursWorked', 'regularHours', 'checkInImplied', 'checkOutImplied', 'punchIds', 'approvalKey', 'approvalCrewId'];

// Approves one stored row: applies any changes parked since an earlier
// approval (deleting it if it's no longer supported by the punches) and
// stamps it approved.
async function approveRow(tx, row, { approverId, now, comment }) {
  const pending = row.changedAfterApproval ? row.pendingValues : null;
  if (pending && pending.deleted) {
    await tx.dailyAttendanceSummary.delete({ where: { id: row.id } });
    return;
  }
  const data = { approvedAt: now, approvedById: approverId, changedAfterApproval: false, pendingValues: Prisma.JsonNull };
  if (pending) {
    for (const field of PENDING_FIELDS) {
      if (field in pending) data[field] = pending[field];
    }
    data.checkIn = pending.checkIn ? new Date(pending.checkIn) : null;
    data.checkOut = pending.checkOut ? new Date(pending.checkOut) : null;
  }
  if (typeof comment === 'string') data.supervisorComment = comment.slice(0, MAX_COMMENT) || null;
  await tx.dailyAttendanceSummary.update({ where: { id: row.id }, data });
}

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
    for (const row of rows) await approveRow(tx, row, { approverId, now, comment: rowComments[row.id] });
  });
}

// Re-approves the given rows that are held for re-approval (others are left
// alone), then closes any batch they were in, or moved to, that has nothing
// left to approve. Returns how many rows were re-approved.
async function reapproveRows(rowIds, { approverId, now = new Date() }) {
  if (!rowIds.length) return 0;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.dailyAttendanceSummary.findMany({ where: { id: { in: rowIds }, changedAfterApproval: true, approvedAt: { not: null } } });
    const keys = new Set();
    for (const row of rows) {
      keys.add(row.approvalKey);
      if (row.pendingValues?.approvalKey) keys.add(row.pendingValues.approvalKey);
      await approveRow(tx, row, { approverId, now });
    }
    for (const key of keys) {
      const unit = await tx.approvalUnit.findUnique({ where: { key } });
      if (!unit || unit.status === 'approved') continue;
      const outstanding = await tx.dailyAttendanceSummary.count({ where: { approvalKey: key, OR: [{ approvedAt: null }, { changedAfterApproval: true }] } });
      if (outstanding > 0) continue;
      await tx.approvalUnit.update({
        where: { key },
        // A batch approved before keeps who approved it; one approved for
        // the first time here (rows moved into it) is stamped with this.
        data: unit.approvedAt
          ? { status: 'approved', reopenedAt: null }
          : { status: 'approved', reopenedAt: null, approvedAt: now, approvedById: approverId, comment: 'Approved automatically with a schedule change.' }
      });
    }
    return rows.length;
  }, { timeout: 60000 });
}

module.exports = { approveUnit, reapproveRows, MAX_COMMENT };
