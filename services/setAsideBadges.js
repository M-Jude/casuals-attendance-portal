// Badges set aside (routes/punches.js): who may change one, and the list of
// them for a period — the dashboard's "Badges set aside" section and the
// Exceptions report. The list is the way back to a badge whose shift record
// went away with it (a lone badge on an unscheduled day leaves no record to
// open the punch history of).

const prisma = require('../prismaClient');
const { buildResolver, scheduleKey } = require('../sync/scheduleResolver');
const { addDaysStr, eatDateStr, eatToUtcMs } = require('../sync/shiftEngine');
const { accountNameResolver } = require('./accountNames');

// Set aside and restore for anyone's badge.
const EDITORS = ['sysadmin', 'hr', 'admin_assistant'];
// See every set-aside badge but change none.
const VIEWERS = ['auditor', 'director'];

const DAY_MS = 24 * 3600 * 1000;

// Of these badges (each with casualWorkerId, timestamp, setAsideById), the
// ids a supervisor may change: their own crew's workers (on the badge's date
// or today), a badge in one of their crew's approval batches, or one they
// set aside themselves.
async function supervisorChangeable(user, punches) {
  if (!punches.length || !user.crewId) return new Set();
  const workerIds = [...new Set(punches.map((p) => p.casualWorkerId))];
  const times = punches.map((p) => p.timestamp.getTime());
  const [schedules, rows] = await Promise.all([
    prisma.workerSchedule.findMany({ where: { casualWorkerId: { in: workerIds } } }),
    prisma.dailyAttendanceSummary.findMany({
      where: {
        casualWorkerId: { in: workerIds },
        approvalCrewId: user.crewId,
        date: { gte: new Date(Math.min(...times) - 2 * DAY_MS), lte: new Date(Math.max(...times) + DAY_MS) }
      },
      select: { punchIds: true }
    })
  ]);
  const resolver = buildResolver({ schedules, rotations: [], exceptions: [], workers: [], profiles: [] });
  const inBatch = new Set(rows.flatMap((r) => (Array.isArray(r.punchIds) ? r.punchIds : [])));
  const today = eatDateStr(Date.now());
  const ok = new Set();
  for (const p of punches) {
    const onCrew = [eatDateStr(p.timestamp.getTime()), today].some((d) => scheduleKey(resolver.scheduleOn(p.casualWorkerId, d)) === `crew:${user.crewId}`);
    if (onCrew || inBatch.has(p.id) || (p.setAsideById && p.setAsideById === user.id)) ok.add(p.id);
  }
  return ok;
}

// Whether this user may set this badge aside or restore it.
async function canChangeBadge(user, punch) {
  if (EDITORS.includes(user.role)) return true;
  if (user.role !== 'supervisor') return false;
  return (await supervisorChangeable(user, [punch])).has(punch.id);
}

/**
 * Badges set aside whose time falls between `from` and `to` (YYYY-MM-DD,
 * Kampala dates, inclusive) that this user may see, oldest first:
 * [{ id, timestamp, eventType, worker, setAside: { at, by, reason }, canRestore }].
 * Supervisors see the ones they may change; Finance (approved records only)
 * none.
 */
async function listSetAside(user, from, to, { workerId = null } = {}) {
  if (![...EDITORS, ...VIEWERS, 'supervisor'].includes(user.role)) return [];
  const punches = await prisma.attendanceLog.findMany({
    where: {
      setAsideAt: { not: null },
      timestamp: { gte: new Date(eatToUtcMs(from, '00:00')), lt: new Date(eatToUtcMs(addDaysStr(to, 1), '00:00')) },
      worker: { subcontractorName: user.subcontractorName },
      ...(workerId ? { casualWorkerId: workerId } : {})
    },
    select: {
      id: true, casualWorkerId: true, eventType: true, timestamp: true, setAsideAt: true, setAsideById: true, setAsideReason: true,
      worker: { select: { id: true, name: true, biostarUserId: true } }
    },
    orderBy: { timestamp: 'asc' }
  });
  const visible = user.role === 'supervisor' ? await supervisorChangeable(user, punches) : null;
  const shown = visible ? punches.filter((p) => visible.has(p.id)) : punches;
  const nameOf = await accountNameResolver(shown.map((p) => p.setAsideById));
  return shown.map((p) => ({
    id: p.id,
    timestamp: p.timestamp,
    eventType: p.eventType,
    worker: p.worker,
    setAside: { at: p.setAsideAt, by: nameOf(p.setAsideById, p.setAsideAt) || null, reason: p.setAsideReason },
    canRestore: !VIEWERS.includes(user.role)
  }));
}

module.exports = { canChangeBadge, listSetAside, EDITORS };
