// Double shifts: two shifts worked back to back by one worker. Each shift
// counts as a shift; the pair counts once as a double shift.
//
//   Day + that evening's Night (same date) — shown as ONE line, "Day + Night":
//     clock in from the Day, clock out from the Night, and hours between the
//     two, so a changeover badge (or a gap between leaving and re-entering)
//     can't split or lose hours. Night shifts are dated by the evening they
//     start, so the line stays on the Day's date — a Night of 30 Sep that
//     ends on 1 Oct belongs to 30 Sep. The two shifts stay separate stored
//     records, each approved by its own crew's supervisor.
//   Night + the next morning's Day — still a double shift, but two lines,
//     each on its own date.
//
// Only counted when BOTH shifts have a clock-out — the first one's shows it
// ended at (or after) the changeover rather than being a lone stray badge,
// the second one's that it was worked through. Back-to-back shifts without
// both are a "possible double" (possibleDoubles): flagged to check, never
// counted as a double, and never merged into one line or one set of hours.
// A real one is confirmed by recording the Day + Night exception, which
// gives both halves their clock-outs.
//
// Pure, no database. Mirrored by src/doubleShift.js for the portal — keep the
// two in sync.

const DAY_MS = 24 * 3600 * 1000;
const EAT_OFFSET_MS = 3 * 3600 * 1000;
// Day/Night handover, used only to share hours when a double shift has no
// time at all recorded at the changeover.
const HANDOVER_EAT = '17:00';

const dateStrOf = (d) => new Date(d).toISOString().slice(0, 10);
const ms = (t) => new Date(t).getTime();
const round2 = (n) => Math.round(n * 100) / 100;
const hoursBetween = (a, b) => round2((ms(b) - ms(a)) / 3600000);
const worked = (r) => r.status !== 'no-show';
const isNight = (r) => r.shift.name === 'Night';

// Shifts numbered in time order — Day d, Night d, Day d+1, … — so two shifts
// are back to back when their numbers are consecutive.
const shiftSlot = (r) => Math.round(Date.parse(`${dateStrOf(r.date)}T00:00:00Z`) / DAY_MS) * 2 + (isNight(r) ? 1 : 0);

// Two back-to-back worked shifts make a double only when both have a
// clock-out (an implied one at a badge-less changeover counts: the worker
// badged in before it and out after it).
const joined = (a, b) => !!a.checkOut && !!b.checkOut;

const runValue = (run) => ({
  id: `${run[0].worker.id}|${shiftSlot(run[0])}`,
  startDate: dateStrOf(run[0].date),
  records: run,
  label: run.map((r, i) => (i > 0 && !isNight(r) ? `next ${r.shift.name}` : r.shift.name)).join(' + ')
});

// Each worker's worked shifts in time order.
function workedByWorker(rows) {
  const byWorker = new Map();
  for (const r of rows) {
    if (!worked(r)) continue;
    if (!byWorker.has(r.worker.id)) byWorker.set(r.worker.id, []);
    byWorker.get(r.worker.id).push(r);
  }
  for (const list of byWorker.values()) list.sort((a, b) => shiftSlot(a) - shiftSlot(b));
  return byWorker.values();
}

/**
 * Every double shift in `rows` (stored shift records). Returns Map(record id
 * -> run), a run being { id, startDate, records (in time order), label },
 * label e.g. "Day + Night" or "Night + next Day". A no-show, or a shift
 * without a clock-out, breaks a run; a longer run (Day + Night + next Day)
 * is one double shift.
 */
function doubleShiftRuns(rows) {
  const out = new Map();
  for (const list of workedByWorker(rows)) {
    let run = [list[0]];
    const close = () => {
      if (run.length < 2) return;
      const value = runValue(run);
      for (const r of run) out.set(r.id, value);
    };
    for (let i = 1; i < list.length; i++) {
      const prev = run[run.length - 1];
      const gap = shiftSlot(list[i]) - shiftSlot(prev);
      if (gap === 0) continue; // the same shift twice — not expected
      if (gap === 1 && joined(prev, list[i])) run.push(list[i]);
      else { close(); run = [list[i]]; }
    }
    close();
  }
  return out;
}

/**
 * Back-to-back worked shifts that are NOT a double because one of them has
 * no clock-out — e.g. a stray morning badge before a Night. Flag to check;
 * never counted or merged. Map(record id -> { id, startDate, records: [a,
 * b], label }). A second shift still in progress isn't flagged yet.
 */
function possibleDoubles(rows) {
  const out = new Map();
  for (const list of workedByWorker(rows)) {
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (shiftSlot(b) - shiftSlot(a) !== 1 || joined(a, b) || b.status === 'in-progress') continue;
      const value = runValue([a, b]);
      out.set(a.id, value);
      out.set(b.id, value);
    }
  }
  return out;
}

// Same-date Day + Night pairs, both worked and both clocked out:
// Map(record id -> { day, night }).
function sameDatePairs(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!worked(r) || r.parts) continue;
    const k = `${r.worker.id}|${dateStrOf(r.date)}`;
    if (!byKey.has(k)) byKey.set(k, {});
    byKey.get(k)[isNight(r) ? 'night' : 'day'] = r;
  }
  const out = new Map();
  for (const p of byKey.values()) {
    if (p.day && p.night && joined(p.day, p.night)) { out.set(p.day.id, p); out.set(p.night.id, p); }
  }
  return out;
}

/**
 * Hours of a Day + Night pair, worked out from its first clock-in and last
 * clock-out. The changeover is the Day's clock-out (or, failing that, the
 * Night's clock-in); the Day's share runs to it and the Night's from it, so
 * the shares always add up to the total.
 */
function pairHours(day, night) {
  const changeover = day.checkOut || night.checkIn
    || (day.checkIn && night.checkOut
      ? new Date(Date.parse(`${dateStrOf(day.date)}T${HANDOVER_EAT}:00Z`) - EAT_OFFSET_MS)
      : null);
  const total = day.checkIn && night.checkOut ? hoursBetween(day.checkIn, night.checkOut) : null;
  const dayHours = day.checkIn && changeover ? hoursBetween(day.checkIn, changeover) : (day.hoursWorked ?? null);
  const nightHours = total != null && dayHours != null ? round2(total - dayHours)
    : night.checkOut && changeover ? hoursBetween(changeover, night.checkOut) : (night.hoursWorked ?? null);
  return {
    changeover,
    dayHours,
    nightHours,
    totalHours: total ?? (dayHours == null && nightHours == null ? null : round2((dayHours || 0) + (nightHours || 0)))
  };
}

/**
 * The stored records with each same-date Day + Night pair adjusted to read
 * as one stretch of work: the Day ends and the Night starts at the
 * changeover, each carries its share of the hours, and neither shows a
 * missing punch, early check-out (Day) or late check-in (Night) that the
 * other shift covers. Each adjusted record gets `double` = { part, partnerId,
 * totalHours, changeover }. Other records are returned unchanged.
 */
function normalizeDoubles(rows) {
  const pairs = sameDatePairs(rows);
  const adjusted = new Map();
  for (const { day, night } of new Set(pairs.values())) {
    const h = pairHours(day, night);
    const common = { totalHours: h.totalHours, changeover: h.changeover };
    adjusted.set(day.id, {
      ...day,
      checkOut: h.changeover || day.checkOut,
      hoursWorked: h.dayHours,
      earlyCheckOut: false,
      status: day.checkIn && ['no-checkout', 'in-progress'].includes(day.status) ? (day.lateIn ? 'late' : 'on-time') : day.status,
      double: { part: 'Day', partnerId: night.id, ...common }
    });
    adjusted.set(night.id, {
      ...night,
      checkIn: h.changeover || night.checkIn,
      hoursWorked: h.nightHours,
      lateIn: false,
      status: ['no-checkin', 'late', 'early'].includes(night.status) && (night.checkOut || night.status !== 'no-checkin') ? 'on-time' : night.status,
      double: { part: 'Night', partnerId: day.id, ...common }
    });
  }
  return rows.map((r) => adjusted.get(r.id) || r);
}

// The one line shown for a Day + Night pair (from normalizeDoubles() rows).
function mergedLine(day, night) {
  const checkIn = day.checkIn;
  const checkOut = night.checkOut;
  const status = !checkIn ? 'no-checkin'
    : !checkOut ? (night.status === 'in-progress' ? 'in-progress' : 'no-checkout')
      : day.status;
  const sources = [day.source, night.source];
  const ids = [...new Set([...(Array.isArray(day.punchIds) ? day.punchIds : []), ...(Array.isArray(night.punchIds) ? night.punchIds : [])])];
  const comments = [day.supervisorComment, night.supervisorComment].filter(Boolean);
  return {
    ...day,
    id: `${day.id}+${night.id}`,
    parts: [day, night],
    shiftsWorked: 2,
    shift: { ...day.shift, name: 'Day + Night' },
    checkIn,
    checkOut,
    checkInImplied: !!day.checkInImplied,
    checkOutImplied: !!night.checkOutImplied,
    hoursWorked: day.double.totalHours,
    regularHours: day.regularHours == null && night.regularHours == null ? (day.regularHours ?? null) : round2((day.regularHours || 0) + (night.regularHours || 0)),
    status,
    lateIn: !!day.lateIn || day.status === 'late',
    earlyCheckOut: !!night.earlyCheckOut,
    hasMultiplePunches: !!(day.hasMultiplePunches || night.hasMultiplePunches),
    source: sources[0] === sources[1] ? sources[0] : sources.includes('exception') ? 'exception' : sources.includes('unscheduled') ? 'unscheduled' : sources[0],
    approvedAt: day.approvedAt && night.approvedAt ? (ms(day.approvedAt) > ms(night.approvedAt) ? day.approvedAt : night.approvedAt) : null,
    changedAfterApproval: !!(day.changedAfterApproval || night.changedAfterApproval),
    supervisorComment: comments.length ? comments.join(' / ') : (day.supervisorComment ?? null),
    ...(day.punchIds !== undefined || night.punchIds !== undefined ? { punchIds: ids } : {})
  };
}

/**
 * Display lines: `rows` (from normalizeDoubles()) in the same order, with
 * each same-date Day + Night pair replaced by one merged line where its
 * first shift was. A merged line has `parts` = [day, night].
 */
function mergeDoubles(rows) {
  const out = [];
  const seen = new Set();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (!r.double || !byId.has(r.double.partnerId)) { out.push(r); continue; }
    if (seen.has(r.id)) continue;
    const partner = byId.get(r.double.partnerId);
    seen.add(r.id); seen.add(partner.id);
    out.push(r.double.part === 'Day' ? mergedLine(r, partner) : mergedLine(partner, r));
  }
  return out;
}

// A merged line, or a plain record, as its stored shift records.
const recordsOf = (lines) => lines.flatMap((l) => l.parts || [l]);

module.exports = { doubleShiftRuns, possibleDoubles, sameDatePairs, pairHours, normalizeDoubles, mergeDoubles, recordsOf, shiftSlot };
