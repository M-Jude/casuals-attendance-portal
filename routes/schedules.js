const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole } = require('../middleware/requireRole');
const { buildResolver, dateStrOf, scheduleKey, parseExceptionShifts } = require('../sync/scheduleResolver');
const { addDaysStr, eatDateStr } = require('../sync/shiftEngine');
const { recomputeWorkers, todayEat } = require('../services/recompute');
const { setWorkerSchedule } = require('../services/workerSchedule');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PATTERN_RE = /^[DNO]{2,31}$/;
const SCHEDULE_EDITORS = ['sysadmin', 'hr', 'admin_assistant'];

function dateOnly(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function scheduleLabel(schedule, crewsById) {
  if (!schedule || schedule.type === 'unassigned') return 'Unassigned';
  if (schedule.type === 'fixed-day') return 'Permanent Day';
  if (schedule.type === 'fixed-night') return 'Permanent Night';
  return crewsById.get(schedule.crewId)?.name || 'Crew';
}

function suggestionLabel(profile, crewsById) {
  if (!profile || !profile.suggestedType) return null;
  if (profile.suggestedType === 'crew') return crewsById.get(profile.suggestedCrewId)?.name || 'Crew';
  if (profile.suggestedType === 'rotation') return `Rotation ${profile.suggestedPattern} (no matching crew)`;
  return profile.suggestedType === 'fixed-day' ? 'Permanent Day' : 'Permanent Night';
}

async function loadTenant(subcontractorName) {
  const [crews, workers] = await Promise.all([
    prisma.crew.findMany({ where: { subcontractorName }, include: { rotations: true, supervisors: { where: { active: true }, select: { id: true, name: true } } }, orderBy: { name: 'asc' } }),
    prisma.casualWorker.findMany({ where: { subcontractorName }, include: { schedules: true, profile: true, account: { select: { id: true, role: true, active: true } } }, orderBy: { name: 'asc' } })
  ]);
  const resolver = buildResolver({
    schedules: workers.flatMap((w) => w.schedules),
    rotations: crews.flatMap((c) => c.rotations),
    workers
  });
  return { crews, workers, resolver, crewsById: new Map(crews.map((c) => [c.id, c])) };
}

// ---------------------------------------------------------------- crews

router.get('/crews', authenticate, async (req, res) => {
  try {
    const { crews, workers, resolver } = await loadTenant(req.user.subcontractorName);
    const today = todayEat();
    res.json({
      crews: crews.map((c) => {
        const current = resolver.rotationOn(c.id, today);
        return {
          id: c.id,
          name: c.name,
          supervisors: c.supervisors,
          members: workers.filter((w) => w.status === 'active' && scheduleKey(resolver.scheduleOn(w.id, today)) === `crew:${c.id}`).length,
          rotation: current ? { pattern: current.pattern, anchorDate: dateStrOf(current.anchorDate), effectiveFrom: dateStrOf(current.effectiveFrom) } : null,
          history: c.rotations
            .map((r) => ({ id: r.id, pattern: r.pattern, anchorDate: dateStrOf(r.anchorDate), effectiveFrom: dateStrOf(r.effectiveFrom), note: r.note }))
            .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
          upcoming: [0, 1, 2, 3, 4, 5].map((i) => {
            const date = addDaysStr(today, i);
            return { date, shifts: resolver.crewShiftsOn(c.id, date) };
          })
        };
      })
    });
  } catch (err) {
    console.error('Failed to load crews:', err);
    res.status(500).json({ error: 'Could not load crews.' });
  }
});

function validateRotation({ pattern, anchorDate, effectiveFrom }) {
  if (!PATTERN_RE.test(pattern || '')) return 'Pattern must use D (Day), N (Night) and O (off), e.g. DDNNOO.';
  if (!DATE_RE.test(anchorDate || '')) return 'Anchor date (a day the crew is on the first letter of the pattern) is required.';
  if (!DATE_RE.test(effectiveFrom || '')) return 'Effective-from date is required.';
  return null;
}

router.post('/crews', authenticate, requireRole('sysadmin'), async (req, res) => {
  const { name, pattern = 'DDNNOO', anchorDate, effectiveFrom } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Crew name is required.' });
  const invalid = validateRotation({ pattern, anchorDate, effectiveFrom });
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const crew = await prisma.crew.create({
      data: {
        name: name.trim(),
        subcontractorName: req.user.subcontractorName,
        rotations: { create: { pattern, anchorDate: dateOnly(anchorDate), effectiveFrom: dateOnly(effectiveFrom), createdById: req.user.id } }
      }
    });
    res.status(201).json({ crew });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A crew with that name already exists.' });
    console.error('Failed to create crew:', err);
    res.status(500).json({ error: 'Could not create the crew.' });
  }
});

router.patch('/crews/:id', authenticate, requireRole('sysadmin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Crew name is required.' });
  try {
    const crew = await prisma.crew.findFirst({ where: { id, subcontractorName: req.user.subcontractorName } });
    if (!crew) return res.status(404).json({ error: 'Crew not found.' });
    res.json({ crew: await prisma.crew.update({ where: { id }, data: { name: name.trim() } }) });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A crew with that name already exists.' });
    console.error('Failed to rename crew:', err);
    res.status(500).json({ error: 'Could not rename the crew.' });
  }
});

async function crewMemberIds(crewId, fromDate, subcontractorName) {
  const { workers, resolver } = await loadTenant(subcontractorName);
  const today = todayEat();
  return workers
    .filter((w) => [fromDate, today].some((d) => scheduleKey(resolver.scheduleOn(w.id, d)) === `crew:${crewId}`))
    .map((w) => w.id);
}

// A new rotation for the crew from effectiveFrom onwards (a cycle change).
// Earlier dates keep the rotation that was in force then.
async function applyRotation({ crewId, pattern, anchorDate, effectiveFrom, note, userId, subcontractorName }) {
  await prisma.crewRotation.upsert({
    where: { crewId_effectiveFrom: { crewId, effectiveFrom: dateOnly(effectiveFrom) } },
    update: { pattern, anchorDate: dateOnly(anchorDate), note, createdById: userId },
    create: { crewId, pattern, anchorDate: dateOnly(anchorDate), effectiveFrom: dateOnly(effectiveFrom), note, createdById: userId }
  });
  await recomputeWorkers(await crewMemberIds(crewId, effectiveFrom, subcontractorName), effectiveFrom);
}

router.post('/crews/:id/rotations', authenticate, requireRole('sysadmin'), async (req, res) => {
  const crewId = parseInt(req.params.id, 10);
  const { pattern, anchorDate, effectiveFrom, note } = req.body || {};
  const invalid = validateRotation({ pattern, anchorDate, effectiveFrom });
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const crew = await prisma.crew.findFirst({ where: { id: crewId, subcontractorName: req.user.subcontractorName } });
    if (!crew) return res.status(404).json({ error: 'Crew not found.' });
    await applyRotation({ crewId, pattern, anchorDate, effectiveFrom, note: note || null, userId: req.user.id, subcontractorName: req.user.subcontractorName });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to change crew rotation:', err);
    res.status(500).json({ error: 'Could not change the rotation.' });
  }
});

// ------------------------------------------------- cycle-change proposals

router.get('/crews/proposals', authenticate, requireRole('sysadmin', 'hr', 'admin_assistant'), async (req, res) => {
  try {
    const proposals = await prisma.crewCycleProposal.findMany({
      where: { status: 'open', crew: { subcontractorName: req.user.subcontractorName } },
      include: { crew: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({
      proposals: proposals.map((p) => ({
        ...p, anchorDate: dateStrOf(p.anchorDate), effectiveFrom: dateStrOf(p.effectiveFrom)
      }))
    });
  } catch (err) {
    console.error('Failed to load proposals:', err);
    res.status(500).json({ error: 'Could not load cycle-change proposals.' });
  }
});

router.post('/crews/proposals/:id/:action', authenticate, requireRole('sysadmin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action } = req.params;
  if (!['apply', 'dismiss'].includes(action)) return res.status(404).json({ error: 'Unknown action.' });

  try {
    const proposal = await prisma.crewCycleProposal.findFirst({
      where: { id, crew: { subcontractorName: req.user.subcontractorName } }
    });
    if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });

    // Resolve it in one conditional step so a double click (or two admins)
    // can't apply it twice; the loser is told it's already been dealt with.
    const claimed = await prisma.crewCycleProposal.updateMany({
      where: { id, status: 'open' },
      data: { status: action === 'apply' ? 'applied' : 'dismissed', resolvedById: req.user.id, resolvedAt: new Date() }
    });
    if (claimed.count === 0) {
      return res.status(409).json({ error: `This cycle change has already been ${proposal.status === 'open' ? 'resolved' : proposal.status}.`, code: 'ALREADY_DONE' });
    }

    if (action === 'apply') {
      try {
        await applyRotation({
          crewId: proposal.crewId,
          pattern: proposal.pattern,
          anchorDate: dateStrOf(proposal.anchorDate),
          effectiveFrom: dateStrOf(proposal.effectiveFrom),
          note: `Applied detected cycle change #${proposal.id}`,
          userId: req.user.id,
          subcontractorName: req.user.subcontractorName
        });
      } catch (err) {
        // Put it back so it can be tried again.
        await prisma.crewCycleProposal.update({ where: { id }, data: { status: 'open', resolvedById: null, resolvedAt: null } }).catch(() => {});
        throw err;
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to resolve proposal:', err);
    res.status(500).json({ error: 'Could not update the proposal.' });
  }
});

// -------------------------------------------------------------- workers

router.get('/workers', authenticate, requireRole('sysadmin', 'hr', 'admin_assistant', 'supervisor'), async (req, res) => {
  try {
    const { workers, resolver, crewsById } = await loadTenant(req.user.subcontractorName);
    const today = todayEat();
    // Each worker's first punch (EAT date) — a first schedule defaults to it.
    const firsts = await prisma.attendanceLog.groupBy({ by: ['casualWorkerId'], where: { casualWorkerId: { in: workers.map((w) => w.id) } }, _min: { timestamp: true } });
    const firstPunch = new Map(firsts.map((f) => [f.casualWorkerId, eatDateStr(f._min.timestamp.getTime())]));
    let list = workers.map((w) => {
      const current = resolver.scheduleOn(w.id, today);
      return {
        id: w.id,
        name: w.name,
        biostarUserId: w.biostarUserId,
        status: w.status,
        schedule: {
          type: current?.type || 'unassigned',
          crewId: current?.crewId || null,
          label: scheduleLabel(current, crewsById),
          effectiveFrom: current ? dateStrOf(current.effectiveFrom) : null
        },
        today: resolver.scheduledShiftsOn(w.id, today),
        account: w.account ? { role: w.account.role, active: w.account.active } : null,
        firstPunchDate: firstPunch.get(w.id) || null,
        hasSchedule: w.schedules.length > 0,
        suggestion: w.profile?.suggestedType
          ? {
              label: suggestionLabel(w.profile, crewsById),
              confidence: w.profile.confidence,
              completeShifts: w.profile.completeShifts,
              differs: w.profile.suggestionKey !== scheduleKey(current)
            }
          : null
      };
    });
    // Supervisors manage their own crew's people.
    if (req.user.role === 'supervisor') list = list.filter((w) => w.schedule.crewId === req.user.crewId);
    res.json({ workers: list });
  } catch (err) {
    console.error('Failed to load workers:', err);
    res.status(500).json({ error: 'Could not load workers.' });
  }
});

router.post('/workers/:id/schedule', authenticate, requireRole(...SCHEDULE_EDITORS), async (req, res) => {
  const { type, crewId, effectiveFrom, note, supervisorAction } = req.body || {};
  try {
    await setWorkerSchedule({
      workerId: parseInt(req.params.id, 10), type, crewId, effectiveFrom, note: note || null,
      userId: req.user.id, subcontractorName: req.user.subcontractorName, supervisorAction
    });
    res.json({ success: true });
  } catch (err) {
    // 409 + decision: the worker is a supervisor — the UI asks what happens to their account.
    if (err.status) return res.status(err.status).json({ error: err.message, decision: err.decision });
    console.error('Failed to set schedule:', err);
    res.status(500).json({ error: 'Could not update the schedule.' });
  }
});

// ------------------------------------------------------- pattern review

router.get('/pattern-review', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  try {
    const { workers, resolver, crewsById } = await loadTenant(req.user.subcontractorName);
    const today = todayEat();
    const items = workers
      .filter((w) => w.status === 'active' && w.profile?.suggestedType)
      .map((w) => ({ w, current: resolver.scheduleOn(w.id, today) }))
      .filter(({ w, current }) => w.profile.suggestionKey !== scheduleKey(current) && w.profile.suggestionKey !== w.profile.dismissedKey)
      .map(({ w, current }) => ({
        workerId: w.id,
        name: w.name,
        biostarUserId: w.biostarUserId,
        current: scheduleLabel(current, crewsById),
        suggested: suggestionLabel(w.profile, crewsById),
        suggestedType: w.profile.suggestedType,
        canAccept: w.profile.suggestedType !== 'rotation',
        confidence: w.profile.confidence,
        completeShifts: w.profile.completeShifts,
        computedAt: w.profile.computedAt,
        details: w.profile.details
      }))
      .sort((a, b) => b.confidence - a.confidence);
    res.json({ items });
  } catch (err) {
    console.error('Failed to load pattern review:', err);
    res.status(500).json({ error: 'Could not load the pattern review.' });
  }
});

router.post('/pattern-review/:workerId/:action', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const workerId = parseInt(req.params.workerId, 10);
  const { action } = req.params;
  if (!['accept', 'dismiss'].includes(action)) return res.status(404).json({ error: 'Unknown action.' });

  try {
    const profile = await prisma.workerProfile.findFirst({ where: { casualWorkerId: workerId, worker: { subcontractorName: req.user.subcontractorName } } });
    if (!profile || !profile.suggestedType) return res.status(404).json({ error: 'No suggestion for this worker.' });

    if (action === 'dismiss') {
      await prisma.workerProfile.update({ where: { casualWorkerId: workerId }, data: { dismissedKey: profile.suggestionKey } });
      return res.json({ success: true });
    }

    if (profile.suggestedType === 'rotation') {
      return res.status(400).json({ error: 'This worker fits a rotation no crew is on yet — ask the System Admin to set up that crew first.' });
    }
    const effectiveFrom = DATE_RE.test(req.body?.effectiveFrom || '') ? req.body.effectiveFrom : todayEat();
    await setWorkerSchedule({
      workerId,
      type: profile.suggestedType,
      crewId: profile.suggestedCrewId,
      effectiveFrom,
      note: 'Accepted from pattern review',
      userId: req.user.id,
      subcontractorName: req.user.subcontractorName,
      supervisorAction: req.body?.supervisorAction
    });
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, decision: err.decision });
    console.error('Failed to resolve pattern review:', err);
    res.status(500).json({ error: 'Could not update the worker.' });
  }
});

// ----------------------------------------------------------- exceptions

// Supervisors may record exceptions for their own crew's workers; HR, the
// Admin Assistant and the System Admin for anyone.
async function assertCanEditWorker(user, workerId) {
  const worker = await prisma.casualWorker.findFirst({ where: { id: workerId, subcontractorName: user.subcontractorName } });
  if (!worker) throw Object.assign(new Error('Worker not found.'), { status: 404 });
  if (user.role === 'supervisor') {
    const { resolver } = await loadTenant(user.subcontractorName);
    if (scheduleKey(resolver.scheduleOn(workerId, todayEat())) !== `crew:${user.crewId}`) {
      throw Object.assign(new Error('You can only record exceptions for your own crew.'), { status: 403 });
    }
  }
  return worker;
}

router.get('/exceptions', authenticate, requireRole(...SCHEDULE_EDITORS, 'supervisor'), async (req, res) => {
  const from = DATE_RE.test(req.query.from || '') ? req.query.from : addDaysStr(todayEat(), -14);
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : addDaysStr(todayEat(), 30);
  try {
    let exceptions = await prisma.shiftException.findMany({
      where: { date: { gte: dateOnly(from), lte: dateOnly(to) }, worker: { subcontractorName: req.user.subcontractorName } },
      include: { worker: { select: { id: true, name: true, biostarUserId: true } } },
      orderBy: [{ date: 'desc' }]
    });
    if (req.user.role === 'supervisor') {
      const { resolver } = await loadTenant(req.user.subcontractorName);
      exceptions = exceptions.filter((e) => scheduleKey(resolver.scheduleOn(e.casualWorkerId, todayEat())) === `crew:${req.user.crewId}`);
    }
    res.json({
      exceptions: exceptions.map((e) => ({ ...e, date: dateStrOf(e.date), shifts: parseExceptionShifts(e.shifts) }))
    });
  } catch (err) {
    console.error('Failed to load exceptions:', err);
    res.status(500).json({ error: 'Could not load exceptions.' });
  }
});

router.put('/exceptions', authenticate, requireRole(...SCHEDULE_EDITORS, 'supervisor'), async (req, res) => {
  const { workerId, date, shifts, note } = req.body || {};
  if (!DATE_RE.test(date || '')) return res.status(400).json({ error: 'Date is required.' });
  if (!Array.isArray(shifts) || shifts.some((s) => !['Day', 'Night'].includes(s))) {
    return res.status(400).json({ error: 'Shifts must be Day, Night, both, or none (off).' });
  }
  try {
    const id = parseInt(workerId, 10);
    await assertCanEditWorker(req.user, id);
    const value = ['Day', 'Night'].filter((s) => shifts.includes(s)).join(',');
    await prisma.shiftException.upsert({
      where: { casualWorkerId_date: { casualWorkerId: id, date: dateOnly(date) } },
      update: { shifts: value, note: note || null, createdById: req.user.id },
      create: { casualWorkerId: id, date: dateOnly(date), shifts: value, note: note || null, createdById: req.user.id }
    });
    await recomputeWorkers([id], addDaysStr(date, -1), addDaysStr(date, 1));
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to save exception:', err);
    res.status(500).json({ error: 'Could not save the exception.' });
  }
});

router.delete('/exceptions/:id', authenticate, requireRole(...SCHEDULE_EDITORS, 'supervisor'), async (req, res) => {
  try {
    const exception = await prisma.shiftException.findUnique({ where: { id: parseInt(req.params.id, 10) } });
    if (!exception) return res.status(404).json({ error: 'This exception has already been removed.', code: 'ALREADY_DONE' });
    const worker = await assertCanEditWorker(req.user, exception.casualWorkerId);
    // deleteMany: a second, simultaneous delete finds nothing rather than erroring.
    const removed = await prisma.shiftException.deleteMany({ where: { id: exception.id } });
    if (removed.count === 0) return res.status(404).json({ error: 'This exception has already been removed.', code: 'ALREADY_DONE' });
    const date = dateStrOf(exception.date);
    res.locals.audit = {
      summary: `Removed the schedule exception for ${worker.name} (${worker.biostarUserId}) on ${date}`,
      details: { removed: { date, shifts: exception.shifts || 'off', note: exception.note } }
    };
    await recomputeWorkers([exception.casualWorkerId], addDaysStr(date, -1), addDaysStr(date, 1));
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to delete exception:', err);
    res.status(500).json({ error: 'Could not delete the exception.' });
  }
});

module.exports = router;
