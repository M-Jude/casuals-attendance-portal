const express = require('express');
const { Parser } = require('json2csv');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

router.get('/attendance/export', authenticate, async (req, res) => {
  const { from, to } = req.query;

  try {
    const logs = await prisma.attendanceLog.findMany({
      where: {
        timestamp: {
          gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
          lte: to ? new Date(`${to}T23:59:59.999Z`) : undefined
        },
        // Same subcontractor scoping as GET /api/attendance — an export
        // without this would let one subcontractor download another's data.
        worker: { subcontractorName: req.user.subcontractorName }
      },
      include: { worker: { select: { name: true, biostarUserId: true } } },
      orderBy: [{ worker: { name: 'asc' } }, { timestamp: 'asc' }]
    });

    if (logs.length === 0) {
      return res.status(404).json({ error: 'No records found for this date range.' });
    }

    const rows = logs.map((log) => ({
      worker_name: log.worker.name,
      worker_id: log.worker.biostarUserId,
      date: log.timestamp.toISOString().slice(0, 10),
      time: log.timestamp.toISOString().slice(11, 16),
      event_type: log.eventType
    }));

    const parser = new Parser({
      fields: ['worker_name', 'worker_id', 'date', 'time', 'event_type']
    });
    const csv = parser.parse(rows);

    const filename = `casuals-attendance_${from || 'all'}_to_${to || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('Attendance export failed:', err);
    res.status(500).json({ error: 'Could not generate export.' });
  }
});

module.exports = router;
