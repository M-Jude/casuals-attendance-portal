const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { generateTemplateBuffer, importRoster } = require('../sync/shiftRoster');
const { computeSummaries } = require('../sync/computeDailySummaries');

const router = express.Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // generous for a spreadsheet roster

router.get('/shifts', authenticate, async (req, res) => {
  try {
    const shifts = await prisma.shift.findMany({ orderBy: { name: 'asc' } });
    res.json({ shifts });
  } catch (err) {
    console.error('Failed to fetch shifts:', err);
    res.status(500).json({ error: 'Could not load shifts.' });
  }
});

router.get('/shifts/roster/template', authenticate, async (req, res) => {
  try {
    const buffer = await generateTemplateBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="shift-roster-template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Failed to generate roster template:', err);
    res.status(500).json({ error: 'Could not generate the template.' });
  }
});

// Roster assignments currently on file for this subcontractor, for a quick
// audit of what a past upload actually wrote.
router.get('/shifts/roster', authenticate, async (req, res) => {
  const { from, to } = req.query; // YYYY-MM-DD

  try {
    const assignments = await prisma.shiftAssignment.findMany({
      where: {
        date: {
          gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
          lte: to ? new Date(`${to}T00:00:00.000Z`) : undefined
        },
        worker: { subcontractorName: req.user.subcontractorName }
      },
      include: {
        worker: { select: { id: true, name: true, biostarUserId: true } },
        shift: { select: { id: true, name: true } }
      },
      orderBy: { date: 'desc' }
    });
    res.json({ assignments });
  } catch (err) {
    console.error('Failed to fetch roster:', err);
    res.status(500).json({ error: 'Could not load the roster.' });
  }
});

// Body is the raw .xlsx file bytes (the frontend posts the File object
// directly, not a multipart form) — accept whatever content-type the
// browser attaches rather than requiring a specific one.
router.post(
  '/shifts/roster/upload',
  authenticate,
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No file received. Upload the .xlsx roster template.' });
    }

    try {
      const result = await importRoster({ buffer: req.body, subcontractorName: req.user.subcontractorName });

      if (result.dateRange) {
        // Recompute summaries over the affected window immediately, so the
        // roster's effect (no-show detection, rostered-shift cross-checks)
        // shows up right away rather than waiting for the next hourly sync.
        await computeSummaries(result.dateRange.from, result.dateRange.to);
      }

      res.json(result);
    } catch (err) {
      console.error('Roster upload failed:', err);
      res.status(400).json({ error: err.message || 'Could not parse the uploaded file. Make sure it is a valid .xlsx roster using the system template.' });
    }
  }
);

module.exports = router;
