// Pure shift-classification engine — no database access, so it can be unit
// tested directly and reused by both the summary computation
// (sync/computeDailySummaries.js) and the pattern profiler
// (sync/patternProfiler.js).
//
// Why this exists: this deployment's devices never label a punch as
// check-in or check-out, and Day (08:00-17:00) and Night (17:00-08:00) share
// both boundaries, so a punch's clock time alone can't say which shift it
// belongs to. The previous approach guessed IN/OUT by alternating through a
// worker's punches, which meant one missed or doubled punch flipped every
// later shift (Day recorded as Night and vice versa).
//
// This engine never guesses from alternation. Instead the caller says which
// shift(s) each worker is EXPECTED on for each date (crew rotation,
// permanent Day/Night, or a supervisor's exception), and each expected shift
// captures the punches that fall inside its own time window — first punch
// in the window is the check-in, last punch is the check-out (same
// first-in/last-out rule BioStar's T&A module uses). A bad punch can only
// ever affect the one shift whose window it lands in.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;

// East Africa Time is a fixed UTC+3 offset with no DST, so conversions are
// plain arithmetic.
const EAT_OFFSET_MS = 3 * HOUR;

// Badges closer together than this are one physical event (a double tap or
// a re-badge after a failed read), not an in and an out.
const MERGE_WINDOW_MS = 5 * MIN;

// A shift needs at least this long between its check-in and check-out to
// count as "worked" when scoring candidate schedules (see patternProfiler).
const MIN_COMPLETE_SHIFT_MS = 4 * HOUR;

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / DAY_MS);
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// UTC epoch ms for a business-local (EAT) wall-clock time on dateStr,
// optionally shifted by whole days.
function eatToUtcMs(dateStr, hhmm, dayOffset = 0) {
  return Date.parse(`${addDaysStr(dateStr, dayOffset)}T00:00:00.000Z`) + hhmmToMinutes(hhmm) * MIN - EAT_OFFSET_MS;
}

// EAT calendar date (YYYY-MM-DD) of a UTC instant.
function eatDateStr(ms) {
  return new Date(ms + EAT_OFFSET_MS).toISOString().slice(0, 10);
}

// Minutes since EAT midnight of a UTC instant.
function eatMinuteOfDay(ms) {
  const d = new Date(ms + EAT_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// Absolute instants for one shift instance anchored on dateStr (the date the
// shift STARTS — for Night that's the evening date).
//   start/end               — the scheduled shift
//   captureStart/captureEnd — the window whose punches belong to it
// Night's end is the next morning; a latestCheckOut at or before the start
// time is likewise on the following day (Day: 05:00 next day, Night: 12:00).
function shiftGeometry(shift, dateStr) {
  const overnight = shift.endTime <= shift.startTime;
  const latestNextDay = shift.latestCheckOut <= shift.startTime;
  return {
    start: eatToUtcMs(dateStr, shift.startTime),
    end: eatToUtcMs(dateStr, shift.endTime, overnight ? 1 : 0),
    captureStart: eatToUtcMs(dateStr, shift.earliestCheckIn),
    captureEnd: eatToUtcMs(dateStr, shift.latestCheckOut, latestNextDay ? 1 : 0)
  };
}

// Groups timestamp-sorted punches into physical badge events.
function clusterPunches(punches) {
  const clusters = [];
  for (const p of punches) {
    const t = p.timestamp instanceof Date ? p.timestamp.getTime() : p.timestamp;
    const last = clusters[clusters.length - 1];
    if (last && t - last.last <= MERGE_WINDOW_MS) {
      last.last = t;
      last.punchIds.push(p.id);
    } else {
      clusters.push({ first: t, last: t, punchIds: [p.id] });
    }
  }
  return clusters;
}

// The shift an unscheduled punch most plausibly STARTS, by its clock time —
// only used for punches no expected shift claimed (worker with no schedule,
// or working outside their schedule). Morning/midday → Day that date;
// afternoon/evening → Night that date; small hours → the previous evening's
// Night.
// A lone badge from someone with no schedule could belong to either shift
// (e.g. 14:03, or 17:10 — a Day check-out or a Night check-in). When the
// worker's own history leans clearly one way, use that shift instead of the
// clock-time guess — provided the badge falls inside that shift's window.
// Returns { shift, date } or null.
function placeInShift(ms, shift) {
  const date = eatDateStr(ms);
  for (const d of [date, addDaysStr(date, -1)]) {
    const g = shiftGeometry(shift, d);
    if (ms >= g.captureStart && ms < g.captureEnd) return { shift, date: d };
  }
  return null;
}

function inferShiftForUnscheduled(ms, shiftsByName) {
  const m = eatMinuteOfDay(ms);
  const date = eatDateStr(ms);
  const day = shiftsByName.Day;
  const night = shiftsByName.Night;
  if (m >= hhmmToMinutes(day.earliestCheckIn) && m < hhmmToMinutes(night.earliestCheckIn)) {
    return { shift: day, date };
  }
  if (m >= hhmmToMinutes(night.earliestCheckIn)) return { shift: night, date };
  return { shift: night, date: addDaysStr(date, -1) };
}

function roundHours(ms) {
  return Math.round((ms / HOUR) * 100) / 100;
}

function resolveInstance(inst, now) {
  const { geometry: g, shift } = inst;
  const clusters = inst.clusters.sort((a, b) => a.first - b.first);

  let checkIn = inst.inOverride ?? null;
  let checkOut = inst.outOverride ?? null;
  let usedClusters = 0;

  if (checkIn === null && checkOut === null) {
    if (clusters.length >= 2) {
      checkIn = clusters[0].first;
      checkOut = clusters[clusters.length - 1].last;
      usedClusters = 2;
    } else if (clusters.length === 1) {
      // A lone badge: before the middle of the shift it's an arrival,
      // after it a departure.
      const c = clusters[0];
      if (c.first < g.start + (g.end - g.start) / 2) checkIn = c.first;
      else checkOut = c.last;
      usedClusters = 1;
    }
  } else if (checkIn !== null && checkOut === null) {
    if (clusters.length) {
      checkOut = clusters[clusters.length - 1].last;
      usedClusters = 1;
    }
  } else if (checkIn === null && checkOut !== null) {
    if (clusters.length) {
      checkIn = clusters[0].first;
      usedClusters = 1;
    }
  }

  const graceMs = shift.graceMinutes * MIN;
  const lateIn = checkIn !== null && checkIn - g.start > graceMs;

  let status;
  if (checkIn === null && checkOut === null) status = 'no-show';
  else if (checkIn === null) status = 'no-checkin';
  else if (checkOut === null) status = now < g.captureEnd ? 'in-progress' : 'no-checkout';
  else if (lateIn) status = 'late';
  else if (g.start - checkIn > graceMs) status = 'early';
  else status = 'on-time';

  const earlyCheckOut = checkOut !== null && checkOut < g.end - shift.earlyOutGraceMinutes * MIN;
  const complete = checkIn !== null && checkOut !== null;

  return {
    date: inst.date,
    shiftName: shift.name,
    source: inst.source,
    checkIn: checkIn === null ? null : new Date(checkIn),
    checkOut: checkOut === null ? null : new Date(checkOut),
    checkInImplied: !!inst.inImplied,
    checkOutImplied: !!inst.outImplied,
    status,
    lateIn,
    earlyCheckOut,
    hasMultiplePunches: clusters.length > usedClusters,
    hoursWorked: complete ? roundHours(Math.max(0, checkOut - checkIn)) : null,
    regularHours: complete
      ? roundHours(Math.max(0, Math.min(checkOut, g.end) - Math.max(checkIn, g.start)))
      : null,
    punchIds: [...inst.clusters.flatMap((c) => c.punchIds), ...(inst.sharedPunchIds || [])],
    // Only used by the profiler's scoring, never persisted.
    completeShift: complete && checkOut - checkIn >= MIN_COMPLETE_SHIFT_MS && !inst.inImplied && !inst.outImplied,
    ended: now >= g.end
  };
}

// Classifies one worker's punches into shift instances.
//
//   punches       — this worker's punches ({ id, timestamp }), any order
//   shiftsByName  — { Day: shift, Night: shift } (Shift rows)
//   fromDate/toDate — EAT dates (inclusive) of the rows wanted; punches
//                  should cover at least fromDate-1 00:00 to toDate+2 12:00
//   expectedFor(dateStr) → { shifts: ['Day'|'Night', ...], source }
//                  what this worker is expected to work that date
//   now           — ms; decides "in-progress" and whether an absent
//                  expected shift is already a no-show
//
// Returns instances for dates in [fromDate, toDate] only.
//   leanFor(dateStr) → 'Day' | 'Night' | null  (optional) — the shift this
//                  worker's own recent history points to, used to place a
//                  lone unscheduled badge that could belong to either shift
function classifyWorker({ punches, shiftsByName, fromDate, toDate, expectedFor, now = Date.now(), leanFor = null }) {
  const sorted = [...punches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const clusters = clusterPunches(sorted);

  // Expected instances over a one-day margin each side, so a Night that
  // starts the evening before fromDate (or a Day the morning after toDate)
  // still claims its punches instead of leaving them "unscheduled".
  const expected = [];
  for (let d = addDaysStr(fromDate, -1); d <= addDaysStr(toDate, 1); d = addDaysStr(d, 1)) {
    const { shifts = [], source = 'schedule' } = expectedFor(d) || {};
    for (const name of shifts) {
      const shift = shiftsByName[name];
      if (!shift) continue;
      expected.push({ date: d, shift, source, geometry: shiftGeometry(shift, d), clusters: [] });
    }
  }
  expected.sort((a, b) => a.geometry.start - b.geometry.start);

  // Where one expected shift runs straight into the next (Night then next
  // morning's Day, or a same-day Day+Night double shift), their capture
  // windows overlap. Pull the earlier one's window back so the overlap is
  // symmetric around the handover time, then resolve the overlap below.
  const handovers = [];
  for (let i = 0; i + 1 < expected.length; i++) {
    const a = expected[i];
    const b = expected[i + 1];
    if (a.geometry.captureEnd <= b.geometry.captureStart) continue;
    const lead = b.geometry.start - b.geometry.captureStart;
    a.captureEnd = Math.min(a.geometry.captureEnd, b.geometry.start + lead);
    handovers.push({ a, b, lo: b.geometry.captureStart, hi: a.captureEnd, at: b.geometry.start, clusters: [] });
  }
  for (const inst of expected) inst.captureEnd = inst.captureEnd ?? inst.geometry.captureEnd;

  const unscheduled = [];
  for (const c of clusters) {
    const h = handovers.find((x) => c.first >= x.lo && c.first < x.hi);
    if (h) {
      h.clusters.push(c);
      continue;
    }
    const inst = expected.find((x) => c.first >= x.geometry.captureStart && c.first < x.captureEnd);
    if (inst) inst.clusters.push(c);
    else unscheduled.push(c);
  }

  // Resolved in time order: in a Day→Night→Day chain the Night's presence
  // may show up only at the neighbouring changeover (its check-in shared
  // with the Day before, its check-out at the next morning's changeover).
  handovers.forEach((h, i) => {
    const { a, b, clusters: cs, at } = h;
    const next = handovers[i + 1];
    const aHasBefore = a.clusters.some((c) => c.first < h.lo) || !!a.presentFromPrevious;
    const bHasAfter = b.clusters.some((c) => c.first >= h.hi) || (next && next.a === b && next.clusters.length > 0);
    b.presentFromPrevious = false;
    if (cs.length >= 2) {
      // Separate leave and re-entry badges: first one ends A, last one
      // starts B; anything in between stays with A (FILO ignores it).
      a.clusters.push(...cs.slice(0, -1));
      b.clusters.push(cs[cs.length - 1]);
      b.presentFromPrevious = true;
    } else if (cs.length === 1) {
      const c = cs[0];
      if (aHasBefore && bHasAfter) {
        // One badge at the changeover of a continuous double shift ends
        // the first shift and starts the second.
        a.outOverride = c.first;
        b.inOverride = c.last;
        a.sharedPunchIds = c.punchIds;
        b.sharedPunchIds = c.punchIds;
        b.presentFromPrevious = true;
      } else if (aHasBefore || (!bHasAfter && c.first < at)) {
        a.clusters.push(c);
      } else {
        b.clusters.push(c);
        b.presentFromPrevious = true;
      }
    } else if (aHasBefore && bHasAfter) {
      // Present across the changeover without badging at it — split at the
      // scheduled handover time and mark both ends as implied.
      a.outOverride = at;
      a.outImplied = true;
      b.inOverride = at;
      b.inImplied = true;
      b.presentFromPrevious = true;
    }
  });

  // Unclaimed punches: build instances from their own clock times so they
  // stay visible (flagged "unscheduled") rather than silently dropped. A
  // group of badges settles the shift by itself; a single badge is a guess,
  // made from the worker's own pattern (leanFor) when they have one.
  const inferred = [];
  for (let i = 0; i < unscheduled.length; ) {
    const c = unscheduled[i];
    let { shift, date } = inferShiftForUnscheduled(c.first, shiftsByName);
    let geometry = shiftGeometry(shift, date);
    const group = [c];
    i++;
    while (i < unscheduled.length && unscheduled[i].first < geometry.captureEnd) {
      group.push(unscheduled[i]);
      i++;
    }
    if (group.length === 1 && leanFor) {
      const lean = leanFor(date);
      if (lean && lean !== shift.name && shiftsByName[lean]) {
        const placed = placeInShift(c.first, shiftsByName[lean]);
        if (placed) ({ shift, date } = placed);
        geometry = shiftGeometry(shift, date);
      }
    }
    let inst = [...expected, ...inferred].find((x) => x.date === date && x.shift.name === shift.name);
    if (!inst) {
      inst = { date, shift, source: 'unscheduled', geometry, captureEnd: geometry.captureEnd, clusters: [] };
      inferred.push(inst);
    }
    inst.clusters.push(...group);
  }

  return [...expected, ...inferred]
    .filter((inst) => inst.date >= fromDate && inst.date <= toDate)
    .map((inst) => resolveInstance(inst, now))
    // An expected shift that hasn't finished yet and has no punches isn't
    // a no-show — it just hasn't happened.
    .filter((row) => row.status !== 'no-show' || row.ended)
    .sort((a, b) => (a.date === b.date ? a.shiftName.localeCompare(b.shiftName) : a.date.localeCompare(b.date)));
}

// Which shift(s) a repeating crew pattern puts the crew on for dateStr.
// pattern is a string of D (Day), N (Night) and O (off), e.g. "DDNNOO";
// anchorDate is a date on which the crew is on the pattern's first letter.
function rotationShiftsFor(pattern, anchorDate, dateStr) {
  const len = pattern.length;
  const idx = ((daysBetween(anchorDate, dateStr) % len) + len) % len;
  const code = pattern[idx];
  if (code === 'D') return ['Day'];
  if (code === 'N') return ['Night'];
  return [];
}

module.exports = {
  classifyWorker,
  clusterPunches,
  shiftGeometry,
  rotationShiftsFor,
  addDaysStr,
  daysBetween,
  eatToUtcMs,
  eatDateStr,
  MERGE_WINDOW_MS,
  EAT_OFFSET_MS
};
