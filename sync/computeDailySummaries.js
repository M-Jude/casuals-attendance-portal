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

// Classifies a single punch to the shift it most likely belongs to, using
// only the punch's own time-of-day — no pre-assigned roster required.
// Check-ins are matched against shift START times; check-outs are matched
// against shift END times. Since Day (08:00-17:00) and Night (17:00-08:00)
// tile the full 24h with a hard boundary and no gap, this is unambiguous
// for realistic arrival/departure variance (minutes to a couple of hours) —
// it only breaks down if someone is literally half a shift early or late,
// which would be a data-quality problem regardless of matching strategy.
//
// Returns { shift, anchorDateStr } or null if the punch isn't a
// check-in/check-out (e.g. a break punch) — those aren't classified here.
function classifyPunch(punch, shifts) {
  if (punch.eventType !== 'check-in' && punch.eventType !== 'check-out') return null;

  const [eatDateStr, eatTime] = utcToEat(punch.timestamp);
  const punchMinutes = hhmmToMinutes(eatTime);
  const anchorField = punch.eventType === 'check-in' ? 'startTime' : 'endTime';

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
    punch.eventType === 'check-out' && isOvernightShift
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

  const punches = await prisma.attendanceLog.findMany({
    where: { timestamp: { gte: queryStart, lte: queryEnd } },
    orderBy: { timestamp: 'asc' }
  });

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

    if (punch.eventType === 'check-in') {
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

  const matched = [];
  for (const punch of rawPunches) {
    const classified = classifyPunch(punch, shifts);
    if (classified && classified.shift.id === shiftId && classified.anchorDateStr === anchorDateStr) {
      matched.push(punch);
    }
  }

  const checkIns = matched.filter((p) => p.eventType === 'check-in');
  const checkOuts = matched.filter((p) => p.eventType === 'check-out');
  const earliestCheckIn = checkIns[0]?.timestamp.getTime() ?? null; // list is already timestamp-ascending
  const latestCheckOut = checkOuts[checkOuts.length - 1]?.timestamp.getTime() ?? null;

  return matched.map((p) => ({
    id: p.id,
    eventType: p.eventType,
    timestamp: p.timestamp,
    usedAsCheckIn: p.eventType === 'check-in' && p.timestamp.getTime() === earliestCheckIn,
    usedAsCheckOut: p.eventType === 'check-out' && p.timestamp.getTime() === latestCheckOut
  }));
}

module.exports = { computeSummaries, classifyPunch, circularMinuteDistance, getPunchDetailForSummary };
