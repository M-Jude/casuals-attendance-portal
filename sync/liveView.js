// The Live board: which of a crew's shifts is "on now", and where each person
// on it stands — pure, no database (routes/live.js loads the data).

const { shiftGeometry, addDaysStr, eatDateStr, MERGE_WINDOW_MS } = require('./shiftEngine');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// A shift shows as current from 3 hours before it starts (people arriving
// early) until 2 hours after it ends (people badging out late).
const LEAD_MS = 3 * HOUR;
const TAIL_MS = 2 * HOUR;

/**
 * The crew's shift to show now: the one in progress, else the one about to
 * start or just finished (within the lead/tail margins), else the next one.
 *   shiftsOn(dateStr) → ['Day'|'Night', ...] the crew works that date
 * Returns { shiftName, date, geometry, phase, current } or null.
 *   phase: 'upcoming' | 'in-progress' | 'finishing' (ended, still in the tail)
 *   current: false when it's only the next shift (crew is off now)
 */
function pickShift({ shiftsOn, shiftsByName, now }) {
  const today = eatDateStr(now);
  const instances = [];
  for (let i = -1; i <= 7; i++) {
    const date = addDaysStr(today, i);
    for (const name of shiftsOn(date)) {
      const shift = shiftsByName[name];
      if (shift) instances.push({ shiftName: name, date, geometry: shiftGeometry(shift, date) });
    }
  }
  instances.sort((a, b) => a.geometry.start - b.geometry.start);
  const phaseOf = (g) => (now < g.start ? 'upcoming' : now < g.end ? 'in-progress' : 'finishing');

  const running = instances.find((x) => x.geometry.start <= now && now < x.geometry.end);
  if (running) return { ...running, phase: 'in-progress', current: true };
  const near = instances.filter((x) => x.geometry.start - LEAD_MS <= now && now < x.geometry.end + TAIL_MS);
  if (near.length) {
    // Between a finishing shift and one about to start, show the one about to start.
    const pick = near.find((x) => now < x.geometry.start) || near[near.length - 1];
    return { ...pick, phase: phaseOf(pick.geometry), current: true };
  }
  const next = instances.find((x) => x.geometry.start > now);
  return next ? { ...next, phase: 'upcoming', current: false } : null;
}

// Badges closer than the merge window are one badge (as in the shift engine).
function countBadges(times) {
  let n = 0;
  let last = -Infinity;
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t - last > MERGE_WINDOW_MS) n++;
    last = t;
  }
  return n;
}

/**
 * Where each person on the shift stands.
 *   instance   — from pickShift()
 *   shift      — the Shift row (for grace minutes)
 *   people     — [{ worker, expected, cover }] everyone to show: expected
 *                crew members, plus anyone else working this shift for the
 *                crew (cover: true)
 *   rowFor(workerId)     — their DailyAttendanceSummary row for this shift, or null
 *   badgesFor(workerId)  — their raw badge times (ms) inside the shift's window
 * Returns { people: [...], counts }.
 *   state: 'on-site' | 'left' | 'out-only' | 'due' | 'late' | 'absent'
 */
function buildBoard({ instance, shift, people, rowFor, badgesFor, now }) {
  const g = instance.geometry;
  const graceMs = shift.graceMinutes * MIN;
  const board = people.map(({ worker, expected, cover }) => {
    const row = rowFor(worker.id);
    const badges = badgesFor(worker.id).filter((t) => t <= now).sort((a, b) => a - b);
    const checkIn = row?.checkIn ? new Date(row.checkIn).getTime() : null;
    const checkOut = row?.checkOut ? new Date(row.checkOut).getTime() : null;
    let state;
    if (checkIn !== null && checkOut === null) state = 'on-site';
    else if (checkIn !== null && checkOut !== null) state = 'left';
    else if (checkOut !== null) state = 'out-only';
    else if (badges.length) state = 'on-site'; // badged, not yet recomputed
    else if (now >= g.end) state = 'absent';
    else if (now > g.start + graceMs) state = 'late';
    else state = 'due';

    const inAt = checkIn ?? (state === 'on-site' && badges.length ? badges[0] : null);
    return {
      worker: { id: worker.id, name: worker.name, biostarUserId: worker.biostarUserId },
      expected,
      cover: Boolean(cover),
      state,
      checkIn: inAt,
      checkOut,
      lateIn: Boolean(row?.lateIn || row?.status === 'late' || (inAt !== null && inAt - g.start > graceMs)),
      earlyOut: Boolean(row?.earlyCheckOut),
      minutesLate: state === 'late' ? Math.floor((now - g.start) / MIN) : null,
      onSiteMinutes: state === 'on-site' && inAt !== null ? Math.max(0, Math.floor((now - inAt) / MIN)) : null,
      lastBadge: badges.length ? badges[badges.length - 1] : null,
      badges: countBadges(badges)
    };
  });

  const count = (s) => board.filter((p) => p.state === s).length;
  const counts = {
    expected: board.filter((p) => p.expected).length,
    onSite: count('on-site'),
    left: count('left') + count('out-only'),
    late: count('late'),
    due: count('due'),
    absent: count('absent'),
    lateIn: board.filter((p) => p.lateIn).length,
    covers: board.filter((p) => p.cover).length
  };
  return { people: board, counts };
}

module.exports = { pickShift, buildBoard, LEAD_MS, TAIL_MS };
