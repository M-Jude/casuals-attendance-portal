// Shared status labels/ordering/styling for DailyAttendanceSummary rows —
// used by both the dashboard table and the punch history modal so the two
// never drift apart.

export const STATUS_LABEL = {
  early: 'Early',
  'on-time': 'On time',
  late: 'Late',
  'no-checkout': 'No checkout',
  'no-checkin': 'No check-in',
  'no-show': 'No-show',
  'in-progress': 'In progress'
};

// Sort order for "Status (issues first)" — total absence first, then a late
// arrival, then a missing checkout/check-in, then early-arrival (informational,
// not really a problem), then on-time, then shifts still running.
export const STATUS_RANK = { 'no-show': 0, late: 1, 'no-checkout': 2, 'no-checkin': 2, early: 3, 'on-time': 4, 'in-progress': 5 };

export function statusClassName(status) {
  switch (status) {
    case 'no-show': return 'critical';
    case 'no-checkout':
    case 'no-checkin': return 'pending';
    case 'in-progress': return 'early';
    case 'late': return 'late';
    case 'early': return 'early';
    default: return 'ok';
  }
}

// The Status column shows only these two: a late check-in and/or an early
// check-out. Everything else (on time, early arrival, no-show, missing
// punch, in progress) leaves it blank. Mirrors statusTags() in
// reports/reportCatalog.js.
export const TAG_LABEL = { 'late-in': 'Late in', 'early-out': 'Early out' };

export function statusTags(row) {
  if (!row) return [];
  const tags = [];
  if (row.status === 'late' || row.lateIn) tags.push('late-in');
  if (row.earlyCheckOut) tags.push('early-out');
  return tags;
}

// A shift with no schedule and only one badge: which shift it belongs to was
// guessed (from the worker's own pattern, or failing that the clock time).
// Mirrors isGuessed() in reports/reportCatalog.js.
export function isGuessed(row) {
  return row?.source === 'unscheduled' && (!row.checkIn || !row.checkOut);
}
export const GUESSED_TITLE = 'Only one badge and no schedule for this date — the shift was guessed from the worker’s usual pattern (or the time of day). Check it, and record an exception if it’s wrong.';

