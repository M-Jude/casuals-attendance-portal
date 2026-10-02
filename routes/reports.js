const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { downloadStamp } = require('../services/audit');
const { summaryVisibility, ROLE_LABELS } = require('../middleware/requireRole');
const { REPORT_TYPES, REPORT_COLUMNS, catalogFor, resolvePeriod, buildReport, applyColumnChoice, addDays } = require('../reports/reportCatalog');
const { renderCsv } = require('../reports/renderCsv');
const { renderXlsx } = require('../reports/renderXlsx');
const { renderPdf } = require('../reports/renderPdf');
const { dateStrOf, buildResolver } = require('../sync/scheduleResolver');
const { accountNameResolver } = require('../services/accountNames');

const router = express.Router();

const ORG_NAME = 'UCAA-ARK Group Casuals Management System';
const MAX_ROWS = 100000;     // records loaded for one report
const MAX_PDF_ROWS = 6000;   // table lines in one PDF (~250 pages)
const PREVIEW_ROWS = 20000;  // per section, for the on-screen preview (paged in the browser)
const FORMATS = ['json', 'csv', 'xlsx', 'pdf'];

const SUMMARY_SELECT = {
  id: true, date: true, source: true, checkIn: true, checkOut: true, checkInImplied: true, checkOutImplied: true,
  hoursWorked: true, status: true, lateIn: true, earlyCheckOut: true, hasMultiplePunches: true,
  approvalCrewId: true, approvedAt: true, changedAfterApproval: true,
  worker: { select: { id: true, name: true, biostarUserId: true } },
  shift: { select: { id: true, name: true } }
};

// Report types this user may run, with the periods each accepts.
router.get('/reports', authenticate, (req, res) => {
  res.json({ reports: catalogFor(req.user.role) });
});

// Workers this user can pick for the individual report.
router.get('/reports/workers', authenticate, async (req, res) => {
  try {
    const where = { subcontractorName: req.user.subcontractorName };
    if (req.user.role === 'supervisor') {
      where.dailySummaries = { some: { approvalCrewId: req.user.crewId ?? -1 } };
    }
    const workers = await prisma.casualWorker.findMany({
      where,
      select: { id: true, name: true, biostarUserId: true, status: true },
      orderBy: { name: 'asc' }
    });
    res.json({ workers });
  } catch (err) {
    console.error('Failed to list report workers:', err);
    res.status(500).json({ error: 'Could not load workers.' });
  }
});

// Reports that list every badge behind each shift.
const BADGE_REPORTS = new Set(['timesheet', 'individual']);

// summaryId -> badge timestamps (in order) for the shifts' captured punches.
async function loadPunchTimes(rows) {
  const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.punchIds) ? r.punchIds : [])))];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 5000) {
    const logs = await prisma.attendanceLog.findMany({ where: { id: { in: ids.slice(i, i + 5000) } }, select: { id: true, timestamp: true } });
    for (const l of logs) byId.set(l.id, l.timestamp);
  }
  return new Map(rows.map((r) => [
    r.id,
    (Array.isArray(r.punchIds) ? r.punchIds : []).map((id) => byId.get(id)).filter(Boolean).sort((a, b) => a - b)
  ]));
}

async function loadApprovalUnits(user, period) {
  const months = new Set();
  for (let m = period.from.slice(0, 7); m <= period.to.slice(0, 7);) {
    months.add(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  const inRange = { gte: new Date(`${period.from}T00:00:00Z`), lte: new Date(`${period.to}T00:00:00Z`) };
  const where = { subcontractorName: user.subcontractorName };
  if (user.role === 'supervisor') Object.assign(where, { kind: 'crew-shift', crewId: user.crewId ?? -1, date: inRange });
  else where.OR = [{ kind: 'crew-shift', date: inRange }, { kind: 'hr-month', month: { in: [...months] } }];

  const units = await prisma.approvalUnit.findMany({ where });
  if (units.length === 0) return [];
  const [crews, shifts, counts, approverName] = await Promise.all([
    prisma.crew.findMany({ where: { subcontractorName: user.subcontractorName } }),
    prisma.shift.findMany(),
    prisma.dailyAttendanceSummary.groupBy({ by: ['approvalKey'], where: { approvalKey: { in: units.map((u) => u.key) } }, _count: { _all: true } }),
    // Still named if the approver's account has since been deleted.
    accountNameResolver(units.map((u) => u.approvedById))
  ]);
  const crewName = new Map(crews.map((c) => [c.id, c.name]));
  const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
  const count = new Map(counts.map((c) => [c.approvalKey, c._count._all]));
  return units.map((u) => ({
    ...u,
    label: u.kind === 'crew-shift'
      ? `${crewName.get(u.crewId) || 'Crew'} · ${shiftName.get(u.shiftId) || ''} · ${dateStrOf(u.date)}`
      : `Permanent staff · ${u.month}`,
    rows: count.get(u.key) || 0,
    approvedByName: approverName(u.approvedById, u.approvedAt)
  }));
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

router.get('/reports/:type', authenticate, async (req, res) => {
  const type = REPORT_TYPES.find((t) => t.id === req.params.type && t.roles.includes(req.user.role));
  if (!type) return res.status(404).json({ error: 'Unknown report.' });
  const format = FORMATS.includes(req.query.format) ? req.query.format : 'json';
  if (!type.periods.includes(req.query.period)) {
    return res.status(400).json({ error: `${type.name} can't be run for that period.` });
  }
  const shiftFilter = ['Day', 'Night'].includes(req.query.shift) ? req.query.shift : null;

  try {
    const visibility = summaryVisibility(req.user);

    let bounds = null;
    if (req.query.period === 'all') {
      const agg = await prisma.dailyAttendanceSummary.aggregate({ where: visibility, _min: { date: true }, _max: { date: true } });
      bounds = agg._min.date ? { min: dateStrOf(agg._min.date), max: dateStrOf(agg._max.date) } : null;
    }
    const period = resolvePeriod(req.query, bounds);
    if (period.error) return res.status(400).json({ error: period.error });

    // A worker is required for the individual report and optional for the
    // timesheet (blank = everyone).
    let worker = null;
    const workerId = parseInt(req.query.workerId, 10);
    if ((type.needsWorker || type.allowsWorker) && workerId) {
      worker = await prisma.casualWorker.findFirst({ where: { id: workerId, subcontractorName: req.user.subcontractorName }, select: { id: true, name: true, biostarUserId: true } });
    }
    if (type.needsWorker && !worker) return res.status(400).json({ error: 'Choose a worker.' });

    const [shifts, crews] = await Promise.all([
      prisma.shift.findMany({ orderBy: { id: 'asc' } }),
      prisma.crew.findMany({ where: { subcontractorName: req.user.subcontractorName } })
    ]);

    let data;
    // Loaded a day either side of the period and for every shift, so double
    // shifts (two shifts back to back) crossing the period's edge or half
    // outside a shift filter are still recognised; the report itself gets
    // only the period's rows.
    let doubleRows = null;
    if (type.id === 'approvals') {
      data = await loadApprovalUnits(req.user, period);
    } else {
      doubleRows = await prisma.dailyAttendanceSummary.findMany({
        where: {
          date: { gte: new Date(`${addDays(period.from, -1)}T00:00:00Z`), lte: new Date(`${addDays(period.to, 1)}T00:00:00Z`) },
          ...visibility,
          ...(worker ? { casualWorkerId: worker.id } : {})
        },
        select: { ...SUMMARY_SELECT, ...(BADGE_REPORTS.has(type.id) ? { punchIds: true } : {}) },
        take: MAX_ROWS + 1
      });
      if (doubleRows.length > MAX_ROWS) return res.status(413).json({ error: 'Too many records for one report. Choose a shorter period.' });
      data = doubleRows.filter((r) => {
        const d = dateStrOf(r.date);
        return d >= period.from && d <= period.to && (!shiftFilter || r.shift.name === shiftFilter);
      });
    }

    const ctx = { shifts, crewsById: new Map(crews.map((c) => [c.id, c])), worker, doubleRows };
    // Each worker's own crew on a date, from their confirmed schedule.
    if (type.id !== 'approvals') {
      const workerIds = [...new Set(data.map((r) => r.worker.id))];
      const resolver = buildResolver({ schedules: await prisma.workerSchedule.findMany({ where: { casualWorkerId: { in: workerIds } } }) });
      ctx.crewOf = (workerId, dateStr) => {
        const s = resolver.scheduleOn(workerId, dateStr);
        return s && s.type === 'crew' ? s.crewId : null;
      };
    }
    if (BADGE_REPORTS.has(type.id)) ctx.punchTimes = await loadPunchTimes(data);
    const built = buildReport(type.id, ctx, data, period);
    if (built.error) return res.status(400).json({ error: built.error });
    // Columns the user chose to leave out (?hide=key,key) — only this report's own.
    const hidden = new Set(String(req.query.hide || '').split(',').filter((k) => (REPORT_COLUMNS[type.id] || []).includes(k)));
    const model = applyColumnChoice(built, hidden);

    const crewName = req.user.role === 'supervisor' ? crews.find((c) => c.id === req.user.crewId)?.name : null;
    const meta = {
      orgName: ORG_NAME,
      subcontractorName: req.user.subcontractorName,
      generatedAt: new Date(),
      generatedBy: `${req.user.name || req.user.email} (${ROLE_LABELS[req.user.role]})`,
      scopeNote: req.user.role === 'finance' ? 'Approved records only' : crewName ? `${crewName} only` : null,
      filters: [
        ...(shiftFilter && type.id !== 'approvals' ? [`${shiftFilter} shift only`] : []),
        ...(worker ? [`Worker: ${worker.name} (${worker.biostarUserId})`] : [])
      ]
    };

    if (format === 'json') {
      return res.json({
        report: {
          ...model,
          meta,
          sections: model.sections.map((s) => ({ ...s, totalRows: s.rows.length, rows: s.rows.slice(0, PREVIEW_ROWS) }))
        }
      });
    }

    // Downloads carry who downloaded them, when, and the audit reference.
    meta.download = downloadStamp(req, res);
    const base = `ucaa-casuals_${slug(type.id)}${worker ? `_${slug(worker.biostarUserId)}` : ''}_${period.from}_to_${period.to}`;
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      return res.send(renderCsv(model, meta));
    }
    if (format === 'xlsx') {
      const buf = await renderXlsx(model, meta);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(Buffer.from(buf));
    }

    const lines = model.sections.reduce((a, s) => a + s.rows.length, 0);
    if (lines > MAX_PDF_ROWS) {
      return res.status(413).json({ error: `This report has ${lines} lines — too many for a PDF. Choose a shorter period, or download it as Excel or CSV.` });
    }
    // Render fully before touching the response so a failure can still
    // return a clean JSON error.
    const doc = renderPdf(model, meta);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
      res.send(Buffer.concat(chunks));
    });
    doc.on('error', (err) => {
      console.error('Report PDF failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Could not generate the PDF.' });
    });
  } catch (err) {
    console.error(`Report ${type.id} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not generate the report.' });
  }
});

module.exports = router;
