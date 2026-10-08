const express = require('express');
const { Parser } = require('json2csv');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { summaryVisibility } = require('../middleware/requireRole');
const { statusTags, TAG_LABEL, addDays } = require('../reports/reportCatalog');
const { doubleShiftRuns, possibleDoubles, normalizeDoubles, mergeDoubles } = require('../reports/doubleShift');
const { downloadStamp } = require('../services/audit');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Business-local (EAT) wall-clock time — the export previously printed UTC.
function eatTime(date) {
  if (!date) return '';
  return new Date(date.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function approvalState(row) {
  // A merged Day + Night line: each shift is approved by its own supervisor.
  if (row.parts) {
    const states = row.parts.map(approvalState);
    return states[0] === states[1] ? states[0] : row.parts.map((p, i) => `${p.shift.name} ${states[i]}`).join(', ');
  }
  if (row.changedAfterApproval) return 'changed after approval';
  return row.approvedAt ? 'approved' : 'pending';
}

// One line per worker per shift — the same records the dashboard shows,
// limited to what the user may see (Finance: approved only).
router.get('/attendance/export', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required.' });
  }

  try {
    // A day either side too, only to recognise double shifts (two shifts
    // back to back) that cross the range's edge.
    const wide = await prisma.dailyAttendanceSummary.findMany({
      where: {
        date: { gte: new Date(`${addDays(from, -1)}T00:00:00.000Z`), lte: new Date(`${addDays(to, 1)}T00:00:00.000Z`) },
        ...summaryVisibility(req.user)
      },
      include: {
        worker: { select: { id: true, name: true, biostarUserId: true } },
        shift: { select: { id: true, name: true } }
      },
      orderBy: [{ date: 'asc' }, { shiftId: 'asc' }, { worker: { name: 'asc' } }]
    });
    // A same-date Day + Night double shift is one line, from the Day's
    // clock-in to the Night's clock-out.
    const normalized = normalizeDoubles(wide);
    const rows = mergeDoubles(normalized.filter((r) => { const d = r.date.toISOString().slice(0, 10); return d >= from && d <= to; }));

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No records found for this date range.' });
    }

    // Part of two shifts worked back to back: "Day + Night", "Night + next Day".
    const doubles = doubleShiftRuns(normalized);
    // Back to back but missing a clock-out: flagged, not counted.
    const possible = possibleDoubles(normalized);
    const doubleLabel = (r) => doubles.get(r.id)?.label || (possible.get(r.id) ? `Possible double - check (${possible.get(r.id).label})` : '');
    const parser = new Parser({
      fields: ['date', 'shift', 'shifts_worked', 'double_shift', 'employee_id', 'worker_name', 'check_in', 'check_out', 'hours_worked', 'regular_hours',
        'status', 'source', 'approval', 'approved_at', 'supervisor_comment']
    });
    const csv = parser.parse(rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      shift: r.shift.name,
      shifts_worked: r.parts ? 2 : r.status === 'no-show' ? 0 : 1,
      double_shift: doubleLabel(r.parts ? r.parts[0] : r),
      employee_id: r.worker.biostarUserId,
      worker_name: r.worker.name,
      check_in: eatTime(r.checkIn) + (r.checkInImplied ? ' (implied)' : ''),
      check_out: eatTime(r.checkOut) + (r.checkOutImplied ? ' (implied)' : ''),
      hours_worked: r.hoursWorked ?? '',
      regular_hours: r.regularHours ?? '',
      // Late in / Early out only; blank otherwise.
      status: statusTags(r).split(',').filter(Boolean).map((k) => TAG_LABEL[k]).join(' · '),
      source: r.source,
      approval: approvalState(r),
      approved_at: r.approvedAt ? eatTime(r.approvedAt) : '',
      supervisor_comment: r.supervisorComment || ''
    })));

    // Who downloaded it and when, after the data so the header row stays the
    // first line for anything importing the file.
    const stamp = downloadStamp(req, res);
    const trailer = [
      '',
      `"Downloaded by","${stamp.by.replace(/"/g, '""')}"`,
      `"Downloaded at","${stamp.atText}"`,
      `"Download reference","${stamp.ref}"`
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="casuals-attendance_${from}_to_${to}.csv"`);
    res.send(`${csv}\n${trailer}\n`);
  } catch (err) {
    console.error('Attendance export failed:', err);
    res.status(500).json({ error: 'Could not generate export.' });
  }
});

module.exports = router;
