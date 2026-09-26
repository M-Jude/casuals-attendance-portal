// Pure punch-pattern profiling — no database access (see
// sync/profilingJob.js for the part that reads/writes).
//
// Punch times alone can't tell Day from Night work: a Day worker badges at
// ~08:00 and ~17:00, and so does a Night worker. What does tell them apart
// is how cleanly the punches fit a schedule: run the shift engine once per
// candidate schedule (permanent Day, permanent Night, each phase of a crew
// rotation) and score how many complete, plausible shifts it produces versus
// how many punches it has to leave unexplained. The right schedule explains
// the punches; the wrong ones leave orphans and half-shifts behind.

const { classifyWorker, rotationShiftsFor, addDaysStr, daysBetween } = require('./shiftEngine');

// Crew patterns the profiler will consider when looking for a rotation or a
// changed cycle. D = Day, N = Night, O = off.
const CANDIDATE_PATTERNS = ['DDNNOO', 'DDDNNNOOO'];

const SCORE = {
  completeShift: 1, // expected shift with a real check-in and check-out, 4h+ apart
  noShow: -0.15, // expected shift with no punches (casuals do miss days — keep it mild)
  unexplainedPunch: -1 // a badge that no expected shift accounts for
};

// Minimum evidence before suggesting anything, and how clearly the best
// schedule has to beat the runner-up.
const MIN_COMPLETE_SHIFTS = 3;
const MIN_MARGIN = 1.5;

function expectedForSchedule(schedule) {
  if (schedule.type === 'fixed-day') return () => ({ shifts: ['Day'], source: 'schedule' });
  if (schedule.type === 'fixed-night') return () => ({ shifts: ['Night'], source: 'schedule' });
  if (schedule.type === 'rotation') {
    return (d) => ({ shifts: rotationShiftsFor(schedule.pattern, schedule.anchorDate, d), source: 'schedule' });
  }
  return () => ({ shifts: [], source: 'schedule' });
}

function scoreRows(rows) {
  const byDate = {};
  let total = 0;
  let complete = 0;
  for (const r of rows) {
    let s = 0;
    if (r.source === 'unscheduled') {
      s = SCORE.unexplainedPunch * ((r.checkIn ? 1 : 0) + (r.checkOut ? 1 : 0));
    } else if (r.completeShift) {
      s = SCORE.completeShift;
      complete++;
    } else if (r.status === 'no-show') {
      s = SCORE.noShow;
    }
    byDate[r.date] = (byDate[r.date] || 0) + s;
    total += s;
  }
  return { total, complete, byDate };
}

// Every phase of every candidate pattern, plus permanent Day and Night.
// Phases are expressed as anchor dates counted from fromDate, so they're
// comparable across workers profiled over the same window.
function candidateSchedules(fromDate, patterns = CANDIDATE_PATTERNS) {
  const list = [{ type: 'fixed-day' }, { type: 'fixed-night' }];
  for (const pattern of patterns) {
    for (let k = 0; k < pattern.length; k++) {
      list.push({ type: 'rotation', pattern, anchorDate: addDaysStr(fromDate, k) });
    }
  }
  return list;
}

// Same rotation, written with the anchor normalised to the latest date on
// or before refDate that starts a cycle — so two anchors a whole cycle apart
// compare equal.
function normaliseAnchor(pattern, anchorDate, refDate) {
  const len = pattern.length;
  const offset = ((daysBetween(anchorDate, refDate) % len) + len) % len;
  return addDaysStr(refDate, -offset);
}

function sameRotation(a, b, refDate) {
  return a.pattern === b.pattern && normaliseAnchor(a.pattern, a.anchorDate, refDate) === normaliseAnchor(b.pattern, b.anchorDate, refDate);
}

function scheduleLabel(s) {
  if (s.type === 'fixed-day') return 'Permanent Day';
  if (s.type === 'fixed-night') return 'Permanent Night';
  return `Rotation ${s.pattern} from ${s.anchorDate}`;
}

// Scores every candidate schedule for one worker's punches over
// [fromDate, toDate]. Returns results best-first plus a suggestion (or null
// when the evidence is too thin or two schedules fit about equally well).
function profileWorker({ punches, shiftsByName, fromDate, toDate, now, candidates }) {
  const results = (candidates || candidateSchedules(fromDate)).map((schedule) => {
    const rows = classifyWorker({ punches, shiftsByName, fromDate, toDate, expectedFor: expectedForSchedule(schedule), now });
    return { schedule, ...scoreRows(rows) };
  });
  results.sort((a, b) => b.total - a.total || b.complete - a.complete);

  const [best, second] = results;
  let suggestion = null;
  if (best && best.complete >= MIN_COMPLETE_SHIFTS && (!second || best.total - second.total >= MIN_MARGIN)) {
    suggestion = {
      schedule: best.schedule,
      confidence: Math.min(1, (best.total - (second ? second.total : 0)) / Math.max(best.total, 1)),
      completeShifts: best.complete
    };
  }
  return { results, suggestion };
}

// Looks for a crew whose members have collectively moved to a different
// rotation (a phase shift, or a different pattern) part-way through the
// window. Returns a proposal { pattern, anchorDate, effectiveFrom, evidence }
// or null.
//
//   current  — the crew's rotation in force: { pattern, anchorDate }
//   members  — [{ punches }] for the crew's workers
function detectCycleChange({ current, members, shiftsByName, fromDate, toDate, now, patterns = CANDIDATE_PATTERNS }) {
  const allPatterns = [...new Set([current.pattern, ...patterns])];
  const candidates = candidateSchedules(fromDate, allPatterns).filter((c) => c.type === 'rotation');

  const currentIdx = candidates.findIndex((c) => sameRotation(c, current, fromDate));
  if (currentIdx === -1) return null;

  // Per-member, per-candidate daily scores.
  const scored = members.map((m) =>
    candidates.map((schedule) =>
      scoreRows(classifyWorker({ punches: m.punches, shiftsByName, fromDate, toDate, expectedFor: expectedForSchedule(schedule), now }))
    )
  );
  const eligible = scored.filter((perCand) => perCand[currentIdx].complete + Math.max(...perCand.map((s) => s.complete)) > 0);
  if (eligible.length < 3) return null;

  const dates = [];
  for (let d = fromDate; d <= toDate; d = addDaysStr(d, 1)) dates.push(d);
  const aggByDate = candidates.map((_, ci) => dates.map((d) => eligible.reduce((sum, m) => sum + (m[ci].byDate[d] || 0), 0)));
  const noChangeTotal = aggByDate[currentIdx].reduce((a, b) => a + b, 0);

  // Best (candidate, change date) split: current rotation before the change
  // date, the candidate from it onwards. Needs at least 3 days of evidence
  // after the change.
  let best = null;
  for (let ci = 0; ci < candidates.length; ci++) {
    if (ci === currentIdx) continue;
    for (let cut = 1; cut <= dates.length - 3; cut++) {
      const total = aggByDate[currentIdx].slice(0, cut).reduce((a, b) => a + b, 0) + aggByDate[ci].slice(cut).reduce((a, b) => a + b, 0);
      if (!best || total > best.total) best = { ci, cut, total };
    }
  }
  if (!best) return null;

  const gain = best.total - noChangeTotal;
  if (gain < Math.max(3, 0.25 * Math.abs(noChangeTotal))) return null;

  // Most members must individually fit the new rotation better after the
  // change date — one or two workers swapping shouldn't move a whole crew.
  const effectiveFrom = dates[best.cut];
  const after = (m, ci) => dates.slice(best.cut).reduce((s, d) => s + (m[ci].byDate[d] || 0), 0);
  const preferring = eligible.filter((m) => after(m, best.ci) > after(m, currentIdx)).length;
  if (preferring < 0.6 * eligible.length) return null;

  const chosen = candidates[best.ci];
  return {
    pattern: chosen.pattern,
    anchorDate: normaliseAnchor(chosen.pattern, chosen.anchorDate, effectiveFrom),
    effectiveFrom,
    evidence: {
      membersConsidered: eligible.length,
      membersPreferringNew: preferring,
      scoreGain: Math.round(gain * 100) / 100,
      window: { from: fromDate, to: toDate }
    }
  };
}

module.exports = {
  profileWorker,
  detectCycleChange,
  candidateSchedules,
  expectedForSchedule,
  scoreRows,
  sameRotation,
  normaliseAnchor,
  scheduleLabel,
  CANDIDATE_PATTERNS
};
