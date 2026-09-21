const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { buildAttendanceReport, SORT_LABELS, GROUP_LABELS } = require('../reports/attendancePdf');

const router = express.Router();

// Unlike the dashboard (which pages at 500), a report should cover the whole
// range — but not unboundedly. ~5000 rows is roughly 200 pages of PDF.
const MAX_REPORT_ROWS = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/attendance/report.pdf', authenticate, async (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required.' });
  }
  if (from > to) {
    return res.status(400).json({ error: '"From" date must not be after "To" date.' });
  }

  // View options mirror the dashboard's filters/sort/group so the PDF matches
  // what's on screen; unknown values fall back to the dashboard defaults.
  const sortBy = SORT_LABELS[req.query.sortBy] ? req.query.sortBy : 'date-desc';
  const groupBy = GROUP_LABELS[req.query.groupBy] ? req.query.groupBy : 'date';
  const idQuery = String(req.query.id || '').trim().slice(0, 60);
  const nameQuery = String(req.query.name || '').trim().slice(0, 60);

  try {
    const [found, shifts] = await Promise.all([
      prisma.dailyAttendanceSummary.findMany({
        where: {
          date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
          // Same tenant scoping as the other attendance routes.
          worker: { subcontractorName: req.user.subcontractorName }
        },
        include: {
          worker: { select: { id: true, name: true, biostarUserId: true } },
          shift: { select: { id: true, name: true } },
          rosteredShift: { select: { id: true, name: true } }
        },
        orderBy: { date: 'desc' },
        take: MAX_REPORT_ROWS + 1
      }),
      prisma.shift.findMany({ orderBy: { id: 'asc' } })
    ]);

    if (found.length > MAX_REPORT_ROWS) {
      return res.status(413).json({ error: `Too many records for one report (over ${MAX_REPORT_ROWS}). Narrow the date range.` });
    }

    const idLower = idQuery.toLowerCase();
    const nameLower = nameQuery.toLowerCase();
    const rows = found.filter(
      (r) =>
        (!idLower || r.worker.biostarUserId.toLowerCase().includes(idLower)) &&
        (!nameLower || r.worker.name.toLowerCase().includes(nameLower))
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No records found for this date range and filters.' });
    }

    // Render fully before touching the response, so a rendering failure can
    // still return a clean JSON error instead of a half-written PDF.
    const doc = buildAttendanceReport({
      rows,
      shifts,
      meta: {
        subcontractorName: req.user.subcontractorName,
        from,
        to,
        generatedAt: new Date(),
        filters: { id: idQuery, name: nameQuery },
        sortBy,
        groupBy
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="casuals-attendance-report_${from}_to_${to}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    doc.pipe(res);
  } catch (err) {
    console.error('Attendance PDF report failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not generate the PDF report.' });
  }
});

module.exports = router;
