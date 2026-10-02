const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole } = require('../middleware/requireRole');
const { buildResolver } = require('../sync/scheduleResolver');
const { eatDateStr, addDaysStr } = require('../sync/shiftEngine');
const { pickShift, buildBoard } = require('../sync/liveView');
const { lastSyncAt } = require('../services/liveSync');

const router = express.Router();
const dateOnly = (d) => new Date(`${d}T00:00:00.000Z`);

// Live view of a crew's current shift: who's in, who's late, who's left.
// A supervisor sees their own crew; HR, the Admin Assistant and the System
// Admin pick any crew. The page polls this every 30 seconds; the server
// pulls fresh badges from BioStar every couple of minutes (services/liveSync).
router.get('/live', authenticate, requireRole('supervisor', 'sysadmin', 'hr', 'admin_assistant', 'auditor'), async (req, res) => {
  try {
    const sub = req.user.subcontractorName;
    const crews = await prisma.crew.findMany({ where: { subcontractorName: sub }, include: { rotations: true }, orderBy: { name: 'asc' } });
    const crewId = req.user.role === 'supervisor' ? req.user.crewId : (parseInt(req.query.crewId, 10) || crews[0]?.id);
    const crew = crews.find((c) => c.id === crewId);
    if (!crew) {
      return res.status(req.user.role === 'supervisor' ? 400 : 404).json({
        error: req.user.role === 'supervisor' ? 'Your account isn’t linked to a crew.' : 'Crew not found.'
      });
    }

    const now = Date.now();
    const today = eatDateStr(now);
    const [shifts, workers, exceptions, profiles] = await Promise.all([
      prisma.shift.findMany(),
      prisma.casualWorker.findMany({ where: { subcontractorName: sub }, include: { schedules: true } }),
      prisma.shiftException.findMany({ where: { date: { gte: dateOnly(addDaysStr(today, -1)), lte: dateOnly(addDaysStr(today, 8)) }, worker: { subcontractorName: sub } } }),
      prisma.workerProfile.findMany({ where: { worker: { subcontractorName: sub } } })
    ]);
    const shiftsByName = Object.fromEntries(shifts.map((s) => [s.name, s]));
    const resolver = buildResolver({
      schedules: workers.flatMap((w) => w.schedules),
      rotations: crews.flatMap((c) => c.rotations),
      exceptions,
      workers,
      profiles
    });

    const base = {
      now,
      lastSyncAt: lastSyncAt(),
      crew: { id: crew.id, name: crew.name },
      crews: req.user.role === 'supervisor' ? [] : crews.map((c) => ({ id: c.id, name: c.name }))
    };
    const instance = pickShift({ shiftsOn: (d) => resolver.crewShiftsOn(crew.id, d), shiftsByName, now });
    if (!instance) return res.json({ ...base, shift: null, people: [], counts: null, feed: [] });

    const shift = shiftsByName[instance.shiftName];
    const g = instance.geometry;

    // The crew on that date (confirmed schedule, or the profiled one), and
    // who of them is expected on this shift (exceptions can take someone off).
    const onCrew = workers.filter((w) => {
      const s = resolver.effectiveScheduleOn(w.id, instance.date);
      return w.status === 'active' && s && s.type === 'crew' && s.crewId === crew.id;
    });
    const expectedIds = new Set(onCrew.filter((w) => resolver.expectedFor(w.id)(instance.date).shifts.includes(shift.name)).map((w) => w.id));

    // Their shift records, plus anyone else working this shift for the crew
    // (covers, unscheduled people routed to this crew's supervisor).
    const rows = await prisma.dailyAttendanceSummary.findMany({
      where: {
        date: dateOnly(instance.date),
        shiftId: shift.id,
        OR: [{ casualWorkerId: { in: [...expectedIds] } }, { approvalCrewId: crew.id }]
      }
    });
    const rowByWorker = new Map(rows.map((r) => [r.casualWorkerId, r]));
    const workerById = new Map(workers.map((w) => [w.id, w]));
    const people = [
      ...[...expectedIds].map((id) => ({ worker: workerById.get(id), expected: true })),
      ...rows.filter((r) => !expectedIds.has(r.casualWorkerId) && r.status !== 'no-show' && workerById.get(r.casualWorkerId))
        .map((r) => ({ worker: workerById.get(r.casualWorkerId), expected: false, cover: true }))
    ];

    // Raw badges in the shift's window — shown even before they're worked
    // into a shift record.
    const logs = await prisma.attendanceLog.findMany({
      where: {
        casualWorkerId: { in: people.map((p) => p.worker.id) },
        timestamp: { gte: new Date(g.captureStart), lt: new Date(Math.min(now, g.captureEnd)) }
      },
      select: { casualWorkerId: true, timestamp: true },
      orderBy: { timestamp: 'desc' }
    });
    const badgesByWorker = new Map();
    for (const l of logs) {
      if (!badgesByWorker.has(l.casualWorkerId)) badgesByWorker.set(l.casualWorkerId, []);
      badgesByWorker.get(l.casualWorkerId).push(l.timestamp.getTime());
    }

    const board = buildBoard({
      instance,
      shift,
      people,
      rowFor: (id) => rowByWorker.get(id) || null,
      badgesFor: (id) => badgesByWorker.get(id) || [],
      now
    });

    res.json({
      ...base,
      shift: {
        name: shift.name,
        date: instance.date,
        start: g.start,
        end: g.end,
        startTime: shift.startTime,
        endTime: shift.endTime,
        phase: instance.phase,
        current: instance.current
      },
      counts: board.counts,
      people: board.people,
      feed: logs.slice(0, 15).map((l) => ({ at: l.timestamp.getTime(), worker: { id: l.casualWorkerId, name: workerById.get(l.casualWorkerId)?.name } }))
    });
  } catch (err) {
    console.error('Live view failed:', err);
    res.status(500).json({ error: 'Could not load the live view.' });
  }
});

module.exports = router;
