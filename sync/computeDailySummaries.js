const { Prisma } = require('@prisma/client');
const prisma = require('../prismaClient');
const { classifyWorker, addDaysStr, eatToUtcMs } = require('./shiftEngine');
const { buildResolver, startAtFirstPunch } = require('./scheduleResolver');
const { planReconcile, sameAttendance, crewUnitKey, hrUnitKey, hrUnitKind, unitDueAt } = require('./approvalLogic');

function dateOnly(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

// How far back a worker's own pattern is read, and how clear it must be:
// at least PATTERN_MIN complete shifts, at least PATTERN_SHARE of one type.
const PATTERN_DAYS = 28;
const PATTERN_MIN = 2;
const PATTERN_SHARE = 2 / 3;

// 'Day' | 'Night' | null — the shift most of the worker's complete shifts in
// the PATTERN_DAYS before dateStr were.
function leanFromHistory(completeRows, dateStr) {
  const from = addDaysStr(dateStr, -PATTERN_DAYS);
  let day = 0;
  let night = 0;
  for (const r of completeRows) {
    if (r.date < from || r.date >= dateStr) continue;
    if (r.shiftName === 'Night') night++;
    else day++;
  }
  const total = day + night;
  if (total < PATTERN_MIN) return null;
  if (day / total >= PATTERN_SHARE) return 'Day';
  if (night / total >= PATTERN_SHARE) return 'Night';
  return null;
}

// Which approval batch a row belongs to:
// (A worker with no confirmed schedule is routed by their profiled
// pattern, the same one their shifts were classified against.)
//   - permanent Day/Night workers → HR's batch for that shift
//   - a crew worker on their own crew's shift → their crew's supervisor
//   - a crew worker on the OTHER shift of a day their crew is working, with
//     no exception for it — usually a stray badge (e.g. a morning tap before
//     their Night) → still their own crew's supervisor, who knows them
//   - anyone else on a shift (a swap, cover or unscheduled worker) → the
//     supervisor of the crew rostered on that shift that date
//   - nobody rostered → the worker's own crew if they have one, else HR
function approvalCrewFor({ resolver, workerId, dateStr, shiftName, tenantCrewIds }) {
  const sched = resolver.effectiveScheduleOn(workerId, dateStr);
  if (sched && (sched.type === 'fixed-day' || sched.type === 'fixed-night')) return null;
  if (sched && sched.type === 'crew' && sched.crewId) {
    const crewShifts = resolver.crewShiftsOn(sched.crewId, dateStr);
    if (crewShifts.includes(shiftName)) return sched.crewId;
    const expected = resolver.expectedFor(workerId)(dateStr)?.shifts || [];
    if (crewShifts.length && !expected.includes(shiftName)) return sched.crewId;
  }
  const onShift = resolver.crewsOnShift(dateStr, shiftName, tenantCrewIds);
  if (onShift.length === 1) return onShift[0];
  if (sched && sched.type === 'crew' && sched.crewId) return sched.crewId;
  return null;
}

function toDbData(row) {
  return {
    source: row.source,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    checkInImplied: row.checkInImplied,
    checkOutImplied: row.checkOutImplied,
    hoursWorked: row.hoursWorked,
    regularHours: row.regularHours,
    status: row.status,
    lateIn: row.lateIn,
    earlyCheckOut: row.earlyCheckOut,
    hasMultiplePunches: row.hasMultiplePunches,
    punchIds: row.punchIds,
    approvalKey: row.approvalKey,
    approvalCrewId: row.approvalCrewId
  };
}

// Recomputes DailyAttendanceSummary rows for shifts starting in
// [fromDateStr, toDateStr] (inclusive, EAT dates), optionally for just some
// workers. Every row is rebuilt from scratch from punches + schedules, so
// the result doesn't depend on what was stored before or where the range
// starts — except approved rows, which are locked: a difference is parked
// for re-approval instead of overwriting them (see planReconcile).
async function computeSummaries(fromDateStr, toDateStr, { workerIds, now = Date.now() } = {}) {
  const shifts = await prisma.shift.findMany();
  const shiftsByName = Object.fromEntries(shifts.map((s) => [s.name, s]));
  if (!shiftsByName.Day || !shiftsByName.Night) {
    console.warn('Day/Night shifts not configured — run scripts/seedShifts.js first. Skipping summary computation.');
    return null;
  }

  const workers = await prisma.casualWorker.findMany({ where: workerIds ? { id: { in: workerIds } } : {} });
  const ids = workers.map((w) => w.id);
  if (ids.length === 0) return { computed: 0 };

  // Punches from PATTERN_DAYS before the range (to read each worker's recent
  // pattern — see leanFor below) to midday after it (the last Night's
  // check-out).
  const patternFrom = addDaysStr(fromDateStr, -PATTERN_DAYS);
  const [punches, schedules, rotations, exceptions, crews, existing, profiles, firstPunches] = await Promise.all([
    prisma.attendanceLog.findMany({
      where: {
        casualWorkerId: { in: ids },
        setAsideAt: null,
        timestamp: {
          gte: new Date(eatToUtcMs(addDaysStr(patternFrom, -1), '00:00')),
          lte: new Date(eatToUtcMs(addDaysStr(toDateStr, 2), '12:00'))
        }
      },
      select: { id: true, casualWorkerId: true, timestamp: true },
      orderBy: { timestamp: 'asc' }
    }),
    prisma.workerSchedule.findMany({ where: { casualWorkerId: { in: ids } } }),
    prisma.crewRotation.findMany(),
    prisma.shiftException.findMany({
      where: { casualWorkerId: { in: ids }, date: { gte: dateOnly(addDaysStr(patternFrom, -1)), lte: dateOnly(addDaysStr(toDateStr, 1)) } }
    }),
    prisma.crew.findMany(),
    prisma.dailyAttendanceSummary.findMany({
      where: { casualWorkerId: { in: ids }, date: { gte: dateOnly(fromDateStr), lte: dateOnly(toDateStr) } }
    }),
    prisma.workerProfile.findMany({ where: { casualWorkerId: { in: ids } } }),
    // Each worker's first ever punch — no shift before it can be a no-show.
    prisma.attendanceLog.groupBy({ by: ['casualWorkerId'], where: { casualWorkerId: { in: ids }, setAsideAt: null }, _min: { timestamp: true } })
  ]);
  const firstPunchMs = new Map(firstPunches.map((f) => [f.casualWorkerId, f._min.timestamp.getTime()]));

  const resolver = buildResolver({ schedules, rotations, exceptions, workers, profiles });
  const punchesByWorker = new Map(ids.map((id) => [id, []]));
  for (const p of punches) punchesByWorker.get(p.casualWorkerId).push(p);

  const fresh = [];
  const units = new Map();

  for (const worker of workers) {
    const tenantCrewIds = crews.filter((c) => c.subcontractorName === worker.subcontractorName).map((c) => c.id);
    const expectedFor = startAtFirstPunch(resolver.expectedFor(worker.id), firstPunchMs.get(worker.id) ?? null, shiftsByName);
    const workerPunches = punchesByWorker.get(worker.id);

    // First pass over the pattern window: the worker's complete shifts (both
    // badges) say which shift they usually work. A lone unscheduled badge on
    // a date is then placed by the pattern of the PATTERN_DAYS before it —
    // complete shifts don't depend on this, so the result doesn't depend on
    // where the recompute starts.
    const history = classifyWorker({ punches: workerPunches, shiftsByName, fromDate: patternFrom, toDate: toDateStr, expectedFor, now })
      .filter((r) => r.checkIn !== null && r.checkOut !== null);
    const leanFor = (dateStr) => leanFromHistory(history, dateStr);

    const rows = classifyWorker({
      punches: workerPunches,
      shiftsByName,
      fromDate: fromDateStr,
      toDate: toDateStr,
      expectedFor,
      now,
      leanFor
    });

    for (const r of rows) {
      const shift = shiftsByName[r.shiftName];
      const approvalCrewId = approvalCrewFor({ resolver, workerId: worker.id, dateStr: r.date, shiftName: r.shiftName, tenantCrewIds });
      const kind = approvalCrewId ? 'crew-shift' : hrUnitKind(r.date);
      const approvalKey = approvalCrewId ? crewUnitKey(approvalCrewId, r.date, shift.id) : hrUnitKey(worker.subcontractorName, r.date, shift.id);

      if (!units.has(approvalKey)) {
        units.set(approvalKey, kind === 'hr-month'
          ? {
              key: approvalKey, kind, subcontractorName: worker.subcontractorName,
              month: r.date.slice(0, 7), dueAt: unitDueAt({ kind, month: r.date.slice(0, 7) })
            }
          : {
              key: approvalKey, kind, subcontractorName: worker.subcontractorName,
              date: dateOnly(r.date), shiftId: shift.id, crewId: approvalCrewId,
              dueAt: unitDueAt({ kind, dateStr: r.date, shift })
            });
      }

      fresh.push({
        casualWorkerId: worker.id,
        date: r.date,
        shiftId: shift.id,
        ...toDbData({ ...r, approvalKey, approvalCrewId })
      });
    }
  }

  const plan = planReconcile(existing, fresh);

  // Skip rewriting unapproved rows whose values didn't change — the hourly
  // run would otherwise touch every row in the lookback window.
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const updates = plan.updates.filter(({ id, data }) => {
    const e = existingById.get(id);
    return !sameAttendance(e, data) || JSON.stringify(e.punchIds) !== JSON.stringify(data.punchIds) || e.approvalCrewId !== data.approvalCrewId;
  });

  const computedAt = new Date(now);
  await prisma.$transaction(async (tx) => {
    for (const unit of units.values()) {
      await tx.approvalUnit.upsert({ where: { key: unit.key }, update: {}, create: unit });
    }
    if (plan.creates.length) {
      await tx.dailyAttendanceSummary.createMany({
        data: plan.creates.map((f) => ({ casualWorkerId: f.casualWorkerId, date: dateOnly(f.date), shiftId: f.shiftId, computedAt, ...toDbData(f) }))
      });
    }
    for (const { id, data } of updates) {
      await tx.dailyAttendanceSummary.update({ where: { id }, data: { ...toDbData(data), computedAt } });
    }
    if (plan.deletes.length) {
      await tx.dailyAttendanceSummary.deleteMany({ where: { id: { in: plan.deletes } } });
    }
    for (const { id, pendingValues } of plan.flags) {
      await tx.dailyAttendanceSummary.update({ where: { id }, data: { changedAfterApproval: true, pendingValues, computedAt } });
    }
    if (plan.clears.length) {
      await tx.dailyAttendanceSummary.updateMany({
        where: { id: { in: plan.clears } },
        data: { changedAfterApproval: false, pendingValues: Prisma.JsonNull }
      });
    }
    // Suggested -> confirmed schedule on an approved row: just the label.
    for (const source of new Set(plan.relabels.map((r) => r.source))) {
      await tx.dailyAttendanceSummary.updateMany({
        where: { id: { in: plan.relabels.filter((r) => r.source === source).map((r) => r.id) } },
        data: { source }
      });
    }

    // An approved batch that gained a new row or had a row change goes back
    // to its approver; a reopened batch whose changes have all reverted is
    // approved again.
    for (const key of plan.reopenKeys) {
      const unit = await tx.approvalUnit.findUnique({ where: { key } });
      if (!unit || unit.status === 'pending') continue;
      const outstanding = await tx.dailyAttendanceSummary.count({
        where: { approvalKey: key, OR: [{ approvedAt: null }, { changedAfterApproval: true }] }
      });
      if (unit.status === 'approved' && outstanding > 0) {
        await tx.approvalUnit.update({
          where: { key },
          data: { status: 'reopened', reopenedAt: computedAt, escalatedAt: null, dueNotifiedAt: null, overdueRemindedAt: null }
        });
      } else if (unit.status === 'reopened' && outstanding === 0) {
        await tx.approvalUnit.update({ where: { key }, data: { status: 'approved', reopenedAt: null } });
      }
    }

    // A batch that was never approved and whose rows have all moved to
    // another batch (or gone) is dropped rather than left empty.
    const leftKeys = [...new Set(existing.map((e) => e.approvalKey))].filter((k) => !units.has(k));
    for (const key of leftKeys) {
      if (await tx.dailyAttendanceSummary.count({ where: { approvalKey: key } }) === 0) {
        await tx.approvalUnit.deleteMany({ where: { key, status: 'pending' } });
      }
    }
  }, { timeout: 120000, maxWait: 20000 });

  const result = {
    computed: fresh.length,
    created: plan.creates.length,
    updated: updates.length,
    deleted: plan.deletes.length,
    flaggedAfterApproval: plan.flags.length,
    flaggedIds: plan.flags.map((f) => f.id),
    createdRows: plan.creates.map((f) => ({ casualWorkerId: f.casualWorkerId, date: f.date, shiftId: f.shiftId }))
  };
  console.log(`Daily summaries ${fromDateStr}..${toDateStr}: ${result.computed} rows (${result.created} new, ${result.updated} changed, ${result.deleted} removed, ${result.flaggedAfterApproval} held for re-approval).`);
  return result;
}

// The raw punches behind one summary row, marking which ones were used as
// its check-in and check-out — powers the punch history modal.
// Badges set aside within the shift's own window (its date 05:00 EAT to
// noon the next day) are listed too, so they can be seen and restored.
async function getPunchDetailForSummary(summary) {
  const ids = Array.isArray(summary.punchIds) ? summary.punchIds : [];
  const dateStr = new Date(summary.date).toISOString().slice(0, 10);
  const punches = await prisma.attendanceLog.findMany({
    where: {
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        {
          casualWorkerId: summary.casualWorkerId,
          setAsideAt: { not: null },
          timestamp: { gte: new Date(eatToUtcMs(dateStr, '05:00')), lt: new Date(eatToUtcMs(addDaysStr(dateStr, 1), '12:00')) }
        }
      ]
    },
    select: { id: true, eventType: true, timestamp: true, setAsideAt: true, setAsideById: true, setAsideReason: true },
    orderBy: { timestamp: 'asc' }
  });
  const inMs = summary.checkIn && !summary.checkInImplied ? new Date(summary.checkIn).getTime() : null;
  const outMs = summary.checkOut && !summary.checkOutImplied ? new Date(summary.checkOut).getTime() : null;
  const setters = await prisma.portalUser.findMany({
    where: { id: { in: [...new Set(punches.map((p) => p.setAsideById).filter(Boolean))] } },
    select: { id: true, name: true, email: true }
  });
  const setterName = new Map(setters.map((u) => [u.id, u.name || u.email]));
  return punches.map((p) => ({
    id: p.id,
    eventType: p.eventType,
    timestamp: p.timestamp,
    usedAsCheckIn: !p.setAsideAt && p.timestamp.getTime() === inMs,
    usedAsCheckOut: !p.setAsideAt && p.timestamp.getTime() === outMs,
    setAside: p.setAsideAt ? { at: p.setAsideAt, by: setterName.get(p.setAsideById) || null, reason: p.setAsideReason } : null
  }));
}

module.exports = { computeSummaries, getPunchDetailForSummary, approvalCrewFor, leanFromHistory };
