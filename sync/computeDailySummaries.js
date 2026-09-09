const prisma = require('../prismaClient');

// East Africa Time is a fixed UTC+3 offset with no DST, so all conversions
// here are plain arithmetic instead of needing a timezone library.
const EAT_OFFSET_HOURS = 3;

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Converts a business-local (EAT) wall-clock time on a given date into the
// actual UTC instant it represents.
function eatToUtc(dateStr, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCHours(h - EAT_OFFSET_HOURS, m, 0, 0);
  return d;
}

// Returns [dateStr, "HH:mm"] for a UTC instant, expressed in EAT.
function utcToEat(date) {
  const eat = new Date(date.getTime() + EAT_OFFSET_HOURS * 60 * 60 * 1000);
  const dateStr = eat.toISOString().slice(0, 10);
  const hh = String(eat.getUTCHours()).padStart(2, '0');
  const mm = String(eat.getUTCMinutes()).padStart(2, '0');
  return [dateStr, `${hh}:${mm}`];
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Shortest distance between two times-of-day on a 24h clock (minutes),
// e.g. 23:50 and 00:10 are 20 minutes apart, not 1420.
function circularMinuteDistance(a, b) {
  const diff = Math.abs(a - b) % 1440;
  return Math.min(diff, 1440 - diff);
}

// This deployment's devices report every punch as PUNCH_TYPE_NONE (mapped to
// eventType 'other' by attendanceSync.js) — none carry an explicit
// check-in/check-out label. Time-of-day alone can't infer the label either:
// Day (08:00-17:00) and Night (17:00-08:00) share both boundaries, so the
// set of shift START times ({08:00, 17:00}) is identical to the set of END
// times — a punch near 08:00 is equally "close" to Day-start and
// Night-end, and the same is true at 17:00. Disambiguating requires the
// punch's position in that worker's sequence, not just its clock time.
//
// This assigns each punch an inferred role by alternation (check-in,
// check-out, check-in, ...), respecting an explicit eventType where the
// device does provide one (mixed environments, or a future firmware/config
// change) and only inferring for 'other'. Must be called per-worker on
// chronologically sorted punches — the alternation state doesn't span
// workers, and a worker's true first punch of the window is assumed to be a
// check-in (a reasonable default, same edge-case tradeoff any FILO/pairing
// heuristic accepts at a window boundary).
//
// Caveat: this assumes every untyped punch is a shift boundary. If this
// deployment's devices are later configured to distinguish break/meal
// punches (BREAK_START/END, MEAL_START/END) from real check-in/check-out,
// mapPunchType in attendanceSync.js needs to stop collapsing them into
// 'other' first, or they'd get swept into this alternation and corrupt the
// pairing.
function assignEffectiveTypes(workerPunchesAsc) {
  let expectingCheckIn = true;
  return workerPunchesAsc.map((punch) => {
    let effectiveType;
    if (punch.eventType === 'check-in') {
      effectiveType = 'check-in';
      expectingCheckIn = false;
    } else if (punch.eventType === 'check-out') {
      effectiveType = 'check-out';
      expectingCheckIn = true;
    } else {
      effectiveType = expectingCheckIn ? 'check-in' : 'check-out';
      expectingCheckIn = !expectingCheckIn;
    }
    return { ...punch, effectiveType };
  });
}

// Classifies a single punch to the shift it most likely belongs to, using
// its effective role (see assignEffectiveTypes) and its own time-of-day —
// no pre-assigned roster required. Check-ins are matched against shift
// START times; check-outs are matched against shift END times. Since Day
// and Night tile the full 24h with a hard boundary and no gap, this is
// unambiguous for realistic arrival/departure variance (minutes to a
// couple of hours) once the role is known — it only breaks down if someone
// is literally half a shift early or late, which would be a data-quality
// problem regardless of matching strategy.
//
// Accepts a punch with either `effectiveType` (set by assignEffectiveTypes)
// or a plain `eventType` of 'check-in'/'check-out' (for direct unit testing
// and for the rare device that does label its punches). Returns
// { shift, anchorDateStr } or null if neither is present.
function classifyPunch(punch, shifts) {
  const role = punch.effectiveType || punch.eventType;
  if (role !== 'check-in' && role !== 'check-out') return null;

  const [eatDateStr, eatTime] = utcToEat(punch.timestamp);
  const punchMinutes = hhmmToMinutes(eatTime);
  const anchorField = role === 'check-in' ? 'startTime' : 'endTime';

  let best = null;
  let bestDistance = Infinity;
  for (const shift of shifts) {
    const distance = circularMinuteDistance(punchMinutes, hhmmToMinutes(shift[anchorField]));
    if (distance < bestDistance) {
      best = shift;
      bestDistance = distance;
    }
  }

  // For a check-out matched to an overnight shift's end (e.g. Night ending
  // 08:00), the shift instance it belongs to started the PREVIOUS day — the
  // anchor date is when the shift began, not when this punch happened.
  const isOvernightShift = best.endTime <= best.startTime;
  const anchorDateStr =
    role === 'check-out' && isOvernightShift
      ? addDaysStr(eatDateStr, -1)
      : eatDateStr;

  return { shift: best, anchorDateStr };
}

function computeStatus({ checkIn, checkOut, shiftStartUtc, graceMinutes }) {
  if (!checkIn) return null; // no check-in at all — absence tracking is out of scope for now, skip entirely
  if (!checkOut) return 'no-checkout';

  const graceMs = graceMinutes * 60 * 1000;
  if (checkIn.getTime() > shiftStartUtc.getTime() + graceMs) return 'late';
  return 'on-time';
}

// Computes and upserts DailyAttendanceSummary rows from raw punches in
// [fromDateStr, toDateStr] (inclusive, EAT calendar dates). No
// ShiftAssignment/roster is read — each punch is classified independently.
async function computeSummaries(fromDateStr, toDateStr) {
  const shifts = await prisma.shift.findMany();
  if (shifts.length === 0) {
    console.warn('No shifts configured — run scripts/seedShifts.js first. Skipping summary computation.');
    return;
  }

  // Widen the punch query by a day on each side so a Night shift starting
  // the evening before fromDateStr, or ending the morning after toDateStr,
  // is still fully captured.
  const queryStart = eatToUtc(addDaysStr(fromDateStr, -1), '00:00');
  const queryEnd = eatToUtc(addDaysStr(toDateStr, 1), '23:59');

  const rawPunches = await prisma.attendanceLog.findMany({
    where: { timestamp: { gte: queryStart, lte: queryEnd } },
    orderBy: { timestamp: 'asc' }
  });

  // Alternation state is per-worker, so split before assigning effective
  // types, then flatten back into one timestamp-ascending list.
  const punchesByWorker = new Map();
  for (const punch of rawPunches) {
    if (!punchesByWorker.has(punch.casualWorkerId)) punchesByWorker.set(punch.casualWorkerId, []);
    punchesByWorker.get(punch.casualWorkerId).push(punch);
  }
  const punches = Array.from(punchesByWorker.values())
    .flatMap((workerPunches) => assignEffectiveTypes(workerPunches))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Group classified punches by (worker, shift, anchor date).
  const groups = new Map();
  for (const punch of punches) {
    const classified = classifyPunch(punch, shifts);
    if (!classified) continue; // break/meal punches etc. — not part of shift summaries yet

    const { shift, anchorDateStr } = classified;
    if (anchorDateStr < fromDateStr || anchorDateStr > toDateStr) continue; // outside requested range

    const key = `${punch.casualWorkerId}|${shift.id}|${anchorDateStr}`;
    if (!groups.has(key)) {
      groups.set(key, {
        casualWorkerId: punch.casualWorkerId, shift, anchorDateStr,
        checkIn: null, checkOut: null, checkInCount: 0, checkOutCount: 0
      });
    }
    const g = groups.get(key);

    if (punch.effectiveType === 'check-in') {
      g.checkInCount++;
      if (!g.checkIn || punch.timestamp < g.checkIn) g.checkIn = punch.timestamp;
    } else {
      g.checkOutCount++;
      if (!g.checkOut || punch.timestamp > g.checkOut) g.checkOut = punch.timestamp;
    }
  }

  let computed = 0;
  let skippedNoCheckIn = 0;

  for (const g of groups.values()) {
    const shiftStartUtc = eatToUtc(g.anchorDateStr, g.shift.startTime);
    const status = computeStatus({
      checkIn: g.checkIn, checkOut: g.checkOut, shiftStartUtc, graceMinutes: g.shift.graceMinutes
    });

    if (!status) {
      skippedNoCheckIn++;
      continue;
    }

    const hoursWorked = g.checkIn && g.checkOut
      ? Math.max(0, Math.round(((g.checkOut - g.checkIn) / 3600000) * 100) / 100)
      : null;

    // More than one check-in or check-out in a shift is usually device noise
    // (a re-badge), but occasionally a real gap (left and came back) that
    // FILO can't distinguish from noise — either way it's worth surfacing
    // for a human to glance at, rather than silently trusting the hours.
    const hasMultiplePunches = g.checkInCount > 1 || g.checkOutCount > 1;

    const dateKey = new Date(`${g.anchorDateStr}T00:00:00.000Z`);

    await prisma.dailyAttendanceSummary.upsert({
      where: { casualWorkerId_date: { casualWorkerId: g.casualWorkerId, date: dateKey } },
      update: { shiftId: g.shift.id, checkIn: g.checkIn, checkOut: g.checkOut, hoursWorked, status, hasMultiplePunches, computedAt: new Date() },
      create: {
        casualWorkerId: g.casualWorkerId,
        date: dateKey,
        shiftId: g.shift.id,
        checkIn: g.checkIn, checkOut: g.checkOut, hoursWorked, status, hasMultiplePunches
      }
    });
    computed++;
  }

  console.log(`Daily summaries computed: ${computed}, skipped (no check-in in group): ${skippedNoCheckIn}.`);
}

// Reconstructs the exact set of raw punches that fed a given
// DailyAttendanceSummary (worker + shift + anchor date), and flags which
// ones FILO actually selected as the check-in/check-out — so a punch
// history view can show duplicates/noise alongside what was actually used.
async function getPunchDetailForSummary(casualWorkerId, shiftId, anchorDateStr) {
  const shifts = await prisma.shift.findMany();

  // Same generous window as computeSummaries uses, scoped to just this worker.
  const queryStart = eatToUtc(addDaysStr(anchorDateStr, -1), '00:00');
  const queryEnd = eatToUtc(addDaysStr(anchorDateStr, 2), '23:59');

  const rawPunches = await prisma.attendanceLog.findMany({
    where: { casualWorkerId, timestamp: { gte: queryStart, lte: queryEnd } },
    orderBy: { timestamp: 'asc' }
  });

  // Single worker, so one alternation sequence across the whole window. Note
  // this window differs from computeSummaries' (which spans the requested
  // range, not one fixed anchor date), so an inferred role right at the
  // window edge could in principle disagree between the two call sites for
  // the same punch — an accepted edge-case tradeoff of per-query alternation
  // rather than a globally precomputed role.
  const punches = assignEffectiveTypes(rawPunches);

  const matched = [];
  for (const punch of punches) {
    const classified = classifyPunch(punch, shifts);
    if (classified && classified.shift.id === shiftId && classified.anchorDateStr === anchorDateStr) {
      matched.push(punch);
    }
  }

  const checkIns = matched.filter((p) => p.effectiveType === 'check-in');
  const checkOuts = matched.filter((p) => p.effectiveType === 'check-out');
  const earliestCheckIn = checkIns[0]?.timestamp.getTime() ?? null; // list is already timestamp-ascending
  const latestCheckOut = checkOuts[checkOuts.length - 1]?.timestamp.getTime() ?? null;

  return matched.map((p) => ({
    id: p.id,
    eventType: p.eventType,
    timestamp: p.timestamp,
    usedAsCheckIn: p.effectiveType === 'check-in' && p.timestamp.getTime() === earliestCheckIn,
    usedAsCheckOut: p.effectiveType === 'check-out' && p.timestamp.getTime() === latestCheckOut
  }));
}

module.exports = { computeSummaries, classifyPunch, circularMinuteDistance, getPunchDetailForSummary, assignEffectiveTypes };
