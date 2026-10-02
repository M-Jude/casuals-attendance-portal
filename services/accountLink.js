// Portal accounts linked to worker records.
//
//   - Every shift supervisor is a worker; their crew is always the crew their
//     worker record rotates with.
//   - Moving a supervisor's worker record to another crew (or off crews) needs
//     an explicit decision: stay supervisor of the new crew, or become just a
//     worker again — which disables the portal account (there is no
//     worker-only login).
//   - When a linked worker is deactivated (they left the BioStar casuals
//     group), their account is disabled and HR and the System Admin are told.
//   - Any role may link a worker record, except the roles in NO_WORKER_LINK.

const prisma = require('../prismaClient');
const { buildResolver } = require('../sync/scheduleResolver');
const { eatDateStr } = require('../sync/shiftEngine');
const { notifyUsers, usersWithRoles } = require('./notify');

// Roles that never have a worker record: UCAA auditors (and the Director
// role, when added) aren't casual workers.
const NO_WORKER_LINK = ['director', 'auditor'];

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const todayEat = () => eatDateStr(Date.now());

// The crew a worker's confirmed schedule puts them on, on dateStr (null if
// they're permanent staff, unassigned, or have no schedule).
async function workerCrewOn(workerId, dateStr = todayEat()) {
  const schedules = await prisma.workerSchedule.findMany({ where: { casualWorkerId: workerId } });
  const current = buildResolver({ schedules }).scheduleOn(workerId, dateStr);
  return current && current.type === 'crew' ? current.crewId : null;
}

/**
 * Checks a worker record may be linked to an account with `role` and returns
 * { worker, crewId } — crewId is the supervisor's crew (from the worker's
 * schedule), or null for other roles.
 */
async function resolveWorkerLink({ casualWorkerId, role, subcontractorName, accountId = null }) {
  if (NO_WORKER_LINK.includes(role)) {
    if (casualWorkerId) throw httpError(400, 'This role is not linked to a worker record.');
    return { worker: null, crewId: null };
  }
  if (!casualWorkerId) {
    if (role === 'supervisor') throw httpError(400, 'Choose the supervisor’s worker record — every supervisor is a worker.');
    return { worker: null, crewId: null };
  }
  const worker = await prisma.casualWorker.findFirst({
    where: { id: Number(casualWorkerId), subcontractorName },
    include: { account: { select: { id: true, email: true } } }
  });
  if (!worker) throw httpError(400, 'Unknown worker.');
  if (worker.account && worker.account.id !== accountId) {
    throw httpError(409, `${worker.name} is already linked to the account ${worker.account.email}.`);
  }
  if (role !== 'supervisor') return { worker, crewId: null };

  if (worker.status !== 'active') throw httpError(400, `${worker.name} is no longer an active worker, so cannot be a supervisor.`);
  const crewId = await workerCrewOn(worker.id);
  if (!crewId) {
    throw httpError(400, `${worker.name} isn’t on a crew. A supervisor leads the crew they rotate with — put them on a crew in Schedules → Workers first.`);
  }
  return { worker, crewId };
}

/**
 * Before a worker's schedule changes: if they are an active supervisor and the
 * change takes them off their crew, the caller must say what happens to the
 * account. Returns a function to run after the schedule is saved (or null).
 *
 *   supervisorAction: 'keep'   — stay supervisor, now of the new crew
 *                     'demote' — just a worker now; the account is disabled
 *
 * Without a decision it throws a 409 carrying `decision` for the UI to ask.
 */
async function planSupervisorMove({ workerId, type, crewId, supervisorAction }) {
  const account = await prisma.portalUser.findFirst({
    where: { casualWorkerId: workerId, role: 'supervisor', active: true },
    include: { crew: true, worker: true }
  });
  if (!account) return null;
  const newCrewId = type === 'crew' ? Number(crewId) : null;
  if (newCrewId && newCrewId === account.crewId) return null;

  const newCrew = newCrewId ? await prisma.crew.findUnique({ where: { id: newCrewId } }) : null;
  if (!supervisorAction) {
    throw httpError(409, `${account.worker.name} is the supervisor of ${account.crew?.name || 'their crew'}. Decide what happens to their supervisor account.`, {
      decision: {
        accountId: account.id,
        name: account.name || account.worker.name,
        email: account.email,
        fromCrew: account.crew?.name || null,
        toCrew: newCrew?.name || null,
        canKeep: Boolean(newCrew)
      }
    });
  }
  if (supervisorAction === 'keep' && !newCrew) {
    throw httpError(400, 'A supervisor must lead a crew — this change takes them off crews, so they can only become a worker.');
  }
  if (!['keep', 'demote'].includes(supervisorAction)) throw httpError(400, 'Unknown supervisor decision.');

  return async () => {
    if (supervisorAction === 'keep') {
      await prisma.portalUser.update({ where: { id: account.id }, data: { crewId: newCrew.id } });
    } else {
      await prisma.portalUser.update({ where: { id: account.id }, data: { active: false } });
    }
  };
}

/**
 * Marks workers who are no longer in the BioStar casuals group inactive, then
 * disables the accounts of those workers and tells HR and the System Admin.
 * `groupIds` are the BioStar user ids now in the group. It never reactivates
 * anyone — a worker switched off by hand stays off. Skips deactivation when
 * the group looks implausibly small, so a partial BioStar response can't
 * switch everyone off.
 */
async function syncWorkerStatuses(groupIds) {
  const inGroup = new Set(groupIds.map(String));
  const active = await prisma.casualWorker.findMany({ where: { status: 'active' }, select: { id: true, biostarUserId: true } });
  const leaving = active.filter((w) => !inGroup.has(w.biostarUserId));

  if (leaving.length === 0) return { deactivated: 0, accountsDisabled: 0 };
  // More than half the workforce "leaving" at once is far likelier to be a
  // bad BioStar response than a real change.
  if (leaving.length > active.length / 2) {
    console.warn(`BioStar group is missing ${leaving.length} of ${active.length} active workers — not deactivating anyone this run.`);
    return { deactivated: 0, accountsDisabled: 0, skipped: true };
  }

  await prisma.casualWorker.updateMany({ where: { id: { in: leaving.map((w) => w.id) } }, data: { status: 'inactive' } });

  const accounts = await prisma.portalUser.findMany({
    where: { casualWorkerId: { in: leaving.map((w) => w.id) }, active: true },
    include: { worker: true, crew: true }
  });
  for (const account of accounts) {
    await prisma.portalUser.update({ where: { id: account.id }, data: { active: false } });
    const recipients = await usersWithRoles(['hr', 'sysadmin'], account.subcontractorName);
    await notifyUsers(recipients, {
      type: 'account-disabled',
      title: `Account disabled: ${account.name || account.email}`,
      body: `${account.worker.name} (${account.worker.biostarUserId}) is no longer in the BioStar casuals group, so their worker record was deactivated and their portal account (${account.email}${account.role === 'supervisor' && account.crew ? `, supervisor of ${account.crew.name}` : ''}) has been disabled.\n\nIf this is a mistake, put them back in the BioStar group and re-enable the account in Users.`,
      link: '/?page=users',
      email: true
    });
  }
  return { deactivated: leaving.length, accountsDisabled: accounts.length };
}

module.exports = { NO_WORKER_LINK, resolveWorkerLink, planSupervisorMove, syncWorkerStatuses, workerCrewOn };
