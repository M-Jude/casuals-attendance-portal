// The month at a glance (Overview page), for the Director, HR, the System
// Admin and the Auditor.

const express = require('express');
const authenticate = require('../middleware/authenticate');
const { requireRole, summaryVisibility } = require('../middleware/requireRole');
const { computeOverview, compare, attention } = require('../reports/overview');
const { loadPeriod } = require('../services/overviewData');
const { todayEat } = require('../services/recompute');

const router = express.Router();
const VIEWERS = ['director', 'hr', 'sysadmin', 'auditor'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const monthLabel = (month) => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

router.get('/overview', authenticate, requireRole(...VIEWERS), async (req, res) => {
  const thisMonth = todayEat().slice(0, 7);
  const month = MONTH_RE.test(req.query.month || '') && req.query.month <= thisMonth ? req.query.month : thisMonth;
  const prev = previousMonth(month);
  const tenant = req.user.subcontractorName;
  const visibility = summaryVisibility(req.user);

  try {
    const [current, before] = await Promise.all([
      loadPeriod({ subcontractorName: tenant, visibility, ...monthRange(month) }),
      loadPeriod({ subcontractorName: tenant, visibility, ...monthRange(prev) })
    ]);
    const overview = computeOverview(current);
    const change = compare(overview, computeOverview(before));
    res.json({
      month,
      label: monthLabel(month),
      previousLabel: monthLabel(prev),
      inProgress: month === thisMonth,
      overview,
      change,
      attention: attention(overview, change)
    });
  } catch (err) {
    console.error('Failed to build overview:', err);
    res.status(500).json({ error: 'Could not load the overview.' });
  }
});

module.exports = router;
