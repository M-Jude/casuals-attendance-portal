const express = require('express');
const { Parser } = require('json2csv');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { summaryVisibility } = require('../middleware/requireRole');
const { statusTags, TAG_LABEL } = require('../reports/reportCatalog');
const { downloadStamp } = require('../services/audit');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Business-local (EAT) wall-clock time — the export previously printed UTC.
function eatTime(date) {
  if (!date) return '';
  return new Date(date.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function approvalState(row) {
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
    const rows = await prisma.dailyAttendanceSummary.findMany({
      where: {
        date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
        ...summaryVisibility(req.user)
      },
      include: {
        worker: { select: { name: true, biostarUserId: true } },
        shift: { select: { name: true } }
      },
      orderBy: [{ date: 'asc' }, { shiftId: 'asc' }, { worker: { name: 'asc' } }]
    });

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No records found for this date range.' });
    }

    const parser = new Parser({
      fields: ['date', 'shift', 'employee_id', 'worker_name', 'check_in', 'check_out', 'hours_worked', 'regular_hours',
        'status', 'source', 'approval', 'approved_at', 'supervisor_comment']
    });
    const csv = parser.parse(rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      shift: r.shift.name,
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
