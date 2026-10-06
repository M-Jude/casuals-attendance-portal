// Changing a worker's schedule (crew, permanent Day/Night, unassigned) — used
// by Schedules → Workers, Pattern review and Users (moving a supervisor).
// If the worker is a supervisor being moved off their crew, the caller must
// pass supervisorAction (see planSupervisorMove); the account change is made
// after the schedule is saved.

const prisma = require('../prismaClient');
const { recomputeWorkers } = require('./recompute');
const { planSupervisorMove } = require('./accountLink');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHEDULE_TYPES = ['crew', 'fixed-day', 'fixed-night', 'unassigned'];
const dateOnly = (dateStr) => new Date(`${dateStr}T00:00:00.000Z`);
const httpError = (status, message) => Object.assign(new Error(message), { status });

// autoReapprove: approved records the change alters are re-approved straight
// away, as userId, instead of being held for re-approval.
async function setWorkerSchedule({ workerId, type, crewId, effectiveFrom, note, userId, subcontractorName, supervisorAction, autoReapprove = false }) {
  if (!SCHEDULE_TYPES.includes(type)) throw httpError(400, 'Unknown schedule type.');
  if (!DATE_RE.test(effectiveFrom || '')) throw httpError(400, 'Effective-from date is required.');
  const worker = await prisma.casualWorker.findFirst({ where: { id: workerId, subcontractorName } });
  if (!worker) throw httpError(404, 'Worker not found.');
  if (type === 'crew') {
    const crew = await prisma.crew.findFirst({ where: { id: Number(crewId), subcontractorName } });
    if (!crew) throw httpError(400, 'Choose a crew.');
  }

  // Throws a 409 asking for a decision if this moves a supervisor off their crew.
  const afterSave = await planSupervisorMove({ workerId, type, crewId, supervisorAction });

  await prisma.workerSchedule.upsert({
    where: { casualWorkerId_effectiveFrom: { casualWorkerId: workerId, effectiveFrom: dateOnly(effectiveFrom) } },
    update: { type, crewId: type === 'crew' ? Number(crewId) : null, note, createdById: userId },
    create: { casualWorkerId: workerId, effectiveFrom: dateOnly(effectiveFrom), type, crewId: type === 'crew' ? Number(crewId) : null, note, createdById: userId }
  });
  if (afterSave) await afterSave();
  // Their records from the change onwards are worked out again against the
  // new schedule; returns what changed.
  return recomputeWorkers([workerId], effectiveFrom, undefined, { autoApproveBy: autoReapprove ? userId : null });
}

module.exports = { setWorkerSchedule, SCHEDULE_TYPES };
