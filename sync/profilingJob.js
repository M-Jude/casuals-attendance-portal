// Daily punch-pattern profiling — run from server.js (and by
// scripts/bootstrapSchedules.js). For every worker it works out which
// schedule their recent punches fit best (a crew's rotation, permanent Day
// or permanent Night) and:
//   - stores it on WorkerProfile for HR's pattern review,
//   - tells HR (in-app + email) when a worker newly needs reviewing — e.g.
//     looks like a permanent Day worker, or has moved crews,
//   - tells the System Admin (in-app + email) when a whole crew's cycle
//     appears to have changed, with a proposed new rotation to apply.

const prisma = require('../prismaClient');
const { addDaysStr, eatDateStr, eatToUtcMs } = require('./shiftEngine');
const { profileWorker, detectCycleChange, candidateSchedules, sameRotation, normaliseAnchor, scheduleLabel, CANDIDATE_PATTERNS } = require('./patternProfiler');
const { buildResolver, dateStrOf, scheduleKey } = require('./scheduleResolver');
const { notifyUsers, usersWithRoles } = require('../services/notify');

const PROFILE_DAYS = 28;
const CYCLE_WINDOW_DAYS = 14;
const MIN_CREW_MEMBERS = 3;
const MAX_LISTED = 15;

function suggestionFor(suggestion, crewRotations, refDate) {
  if (!suggestion) return null;
  const s = suggestion.schedule;
  if (s.type !== 'rotation') return { type: s.type, key: s.type, crewId: null, pattern: null, anchor: null };
  const crew = crewRotations.find((c) => sameRotation(c.rotation, s, refDate));
  if (crew) return { type: 'crew', key: `crew:${crew.crewId}`, crewId: crew.crewId, pattern: s.pattern, anchor: s.anchorDate };
  const anchor = normaliseAnchor(s.pattern, s.anchorDate, refDate);
  return { type: 'rotation', key: `rotation:${s.pattern}:${anchor}`, crewId: null, pattern: s.pattern, anchor };
}

async function loadTenantData(subcontractorName, fromDate, toDate) {
  const workers = await prisma.casualWorker.findMany({ where: { subcontractorName, status: 'active' }, include: { profile: true } });
  const ids = workers.map((w) => w.id);
  const [crews, schedules, punches] = await Promise.all([
    prisma.crew.findMany({ where: { subcontractorName }, include: { rotations: true } }),
    prisma.workerSchedule.findMany({ where: { casualWorkerId: { in: ids } } }),
    prisma.attendanceLog.findMany({
      where: {
        casualWorkerId: { in: ids },
        timestamp: { gte: new Date(eatToUtcMs(addDaysStr(fromDate, -1), '00:00')), lte: new Date(eatToUtcMs(addDaysStr(toDate, 2), '12:00')) }
      },
      select: { id: true, casualWorkerId: true, timestamp: true },
      orderBy: { timestamp: 'asc' }
    })
  ]);
  const punchesByWorker = new Map(ids.map((id) => [id, []]));
  for (const p of punches) punchesByWorker.get(p.casualWorkerId).push(p);
  const resolver = buildResolver({ schedules, rotations: crews.flatMap((c) => c.rotations), workers });
  return { workers, crews, resolver, punchesByWorker };
}

async function profileTenant(subcontractorName, shiftsByName, { fromDate, toDate, now, notify }) {
  const { workers, crews, resolver, punchesByWorker } = await loadTenantData(subcontractorName, fromDate, toDate);
  const crewRotations = crews
    .map((c) => {
      const rot = resolver.rotationOn(c.id, toDate);
      return rot ? { crewId: c.id, name: c.name, rotation: { pattern: rot.pattern, anchorDate: dateStrOf(rot.anchorDate) } } : null;
    })
    .filter(Boolean);
  const patterns = [...new Set([...CANDIDATE_PATTERNS, ...crewRotations.map((c) => c.rotation.pattern)])];
  const candidates = candidateSchedules(fromDate, patterns);
  const crewName = new Map(crews.map((c) => [c.id, c.name]));

  const newlyNeedingReview = [];
  let profiled = 0;

  // The realistic choices for a worker are the existing crews plus
  // permanent Day/Night — comparing only those (crew cycles are two days
  // apart) is far more decisive than against every possible phase. The
  // all-phases comparison is only used when that's inconclusive, to spot a
  // rotation no crew is on yet.
  const crewCandidates = crewRotations.length
    ? [{ type: 'fixed-day' }, { type: 'fixed-night' }, ...crewRotations.map((c) => ({ type: 'rotation', ...c.rotation }))]
    : null;

  for (const w of workers) {
    const punches = punchesByWorker.get(w.id);
    let profile = crewCandidates ? profileWorker({ punches, shiftsByName, fromDate, toDate, now, candidates: crewCandidates }) : null;
    if (!profile || !profile.suggestion) {
      const wide = profileWorker({ punches, shiftsByName, fromDate, toDate, now, candidates });
      if (!profile || wide.suggestion) profile = wide;
    }
    const { results, suggestion } = profile;
    const s = suggestionFor(suggestion, crewRotations, toDate);
    const data = {
      suggestedType: s ? s.type : null,
      suggestedCrewId: s ? s.crewId : null,
      suggestedPattern: s ? s.pattern : null,
      suggestedAnchor: s && s.anchor ? new Date(`${s.anchor}T00:00:00.000Z`) : null,
      confidence: suggestion ? suggestion.confidence : 0,
      completeShifts: suggestion ? suggestion.completeShifts : (results[0]?.complete || 0),
      suggestionKey: s ? s.key : null,
      details: {
        window: { from: fromDate, to: toDate },
        topCandidates: results.slice(0, 3).map((r) => ({ label: scheduleLabel(r.schedule), score: Math.round(r.total * 100) / 100, completeShifts: r.complete }))
      },
      computedAt: new Date(now)
    };

    const currentKey = scheduleKey(resolver.scheduleOn(w.id, toDate));
    const needsReview = s && s.key !== currentKey && s.key !== w.profile?.dismissedKey;
    if (needsReview && s.key !== w.profile?.notifiedKey) {
      newlyNeedingReview.push(`${w.name} (${w.biostarUserId}) — looks like ${s.type === 'crew' ? crewName.get(s.crewId) : s.type === 'rotation' ? `a ${s.pattern} rotation with no crew` : s.type === 'fixed-day' ? 'Permanent Day' : 'Permanent Night'}`);
      if (notify) data.notifiedKey = s.key;
    }

    await prisma.workerProfile.upsert({ where: { casualWorkerId: w.id }, update: data, create: { casualWorkerId: w.id, ...data } });
    profiled++;
  }

  if (notify && newlyNeedingReview.length) {
    const lines = newlyNeedingReview.slice(0, MAX_LISTED).map((l) => `• ${l}`);
    if (newlyNeedingReview.length > MAX_LISTED) lines.push(`…and ${newlyNeedingReview.length - MAX_LISTED} more`);
    await notifyUsers(await usersWithRoles(['hr'], subcontractorName), {
      type: 'pattern-review',
      title: `${newlyNeedingReview.length} worker${newlyNeedingReview.length === 1 ? '' : 's'} with a punch pattern to review`,
      body: `Recent punches suggest a different schedule for:\n${lines.join('\n')}\n\nReview and approve or dismiss each one in Schedules → Pattern review.`,
      link: '/?page=schedules&tab=review',
      email: true
    });
  }

  // Crew-level cycle change detection.
  let proposals = 0;
  const cycleFrom = addDaysStr(toDate, -(CYCLE_WINDOW_DAYS - 1));
  for (const crew of crewRotations) {
    const members = workers.filter((w) => scheduleKey(resolver.scheduleOn(w.id, toDate)) === `crew:${crew.crewId}`);
    if (members.length < MIN_CREW_MEMBERS) continue;
    const proposal = detectCycleChange({
      current: crew.rotation,
      members: members.map((m) => ({ punches: punchesByWorker.get(m.id) })),
      shiftsByName,
      fromDate: cycleFrom,
      toDate,
      now,
      patterns
    });
    if (!proposal) continue;

    const previous = await prisma.crewCycleProposal.findMany({ where: { crewId: crew.crewId, status: { in: ['open', 'dismissed'] } } });
    const seen = previous.some((p) => sameRotation({ pattern: p.pattern, anchorDate: dateStrOf(p.anchorDate) }, proposal, toDate));
    if (seen) continue;

    await prisma.crewCycleProposal.create({
      data: {
        crewId: crew.crewId,
        pattern: proposal.pattern,
        anchorDate: new Date(`${proposal.anchorDate}T00:00:00.000Z`),
        effectiveFrom: new Date(`${proposal.effectiveFrom}T00:00:00.000Z`),
        evidence: proposal.evidence
      }
    });
    proposals++;
    if (notify) {
      await notifyUsers(await usersWithRoles(['sysadmin'], subcontractorName), {
        type: 'cycle-change',
        title: `${crew.name}: shift cycle appears to have changed`,
        body: `${proposal.evidence.membersPreferringNew} of ${proposal.evidence.membersConsidered} ${crew.name} workers have been punching on a different cycle since ${proposal.effectiveFrom}.\n\nCurrent: ${crew.rotation.pattern} from ${crew.rotation.anchorDate}\nDetected: ${proposal.pattern} from ${proposal.anchorDate}\n\nApply or dismiss it in Schedules → Crews. Until applied, their shifts are judged against the old cycle.`,
        link: '/?page=schedules&tab=crews',
        email: true
      });
    }
  }

  return { profiled, newlyNeedingReview: newlyNeedingReview.length, proposals };
}

// Profiles the PROFILE_DAYS days up to yesterday (EAT).
async function runProfiling({ now = Date.now(), days = PROFILE_DAYS, notify = true } = {}) {
  const shifts = await prisma.shift.findMany();
  const shiftsByName = Object.fromEntries(shifts.map((s) => [s.name, s]));
  if (!shiftsByName.Day || !shiftsByName.Night) return null;

  const toDate = addDaysStr(eatDateStr(now), -1);
  const fromDate = addDaysStr(toDate, -(days - 1));
  const tenants = await prisma.casualWorker.findMany({ distinct: ['subcontractorName'], select: { subcontractorName: true } });

  const totals = { profiled: 0, newlyNeedingReview: 0, proposals: 0 };
  for (const { subcontractorName } of tenants) {
    const r = await profileTenant(subcontractorName, shiftsByName, { fromDate, toDate, now, notify });
    totals.profiled += r.profiled;
    totals.newlyNeedingReview += r.newlyNeedingReview;
    totals.proposals += r.proposals;
  }
  console.log(`Profiling ${fromDate}..${toDate}: ${totals.profiled} worker(s), ${totals.newlyNeedingReview} new for review, ${totals.proposals} crew cycle proposal(s).`);
  return { fromDate, toDate, ...totals };
}

module.exports = { runProfiling, suggestionFor };
