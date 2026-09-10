// Shared status labels/ordering/styling for DailyAttendanceSummary rows —
// used by both the dashboard table and the punch history modal so the two
// never drift apart.

export const STATUS_LABEL = {
  early: 'Early',
  'on-time': 'On time',
  late: 'Late',
  'no-checkout': 'No checkout',
  'no-show': 'No-show'
};

// Sort order for "Status (issues first)" — total absence first, then a late
// arrival, then a missing checkout, then early-arrival (informational, not
// really a problem), then on-time last.
export const STATUS_RANK = { 'no-show': 0, late: 1, 'no-checkout': 2, early: 3, 'on-time': 4 };

export function statusClassName(status) {
  switch (status) {
    case 'no-show': return 'critical';
    case 'no-checkout': return 'pending';
    case 'late': return 'late';
    case 'early': return 'early';
    default: return 'ok';
  }
}
