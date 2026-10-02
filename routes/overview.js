// The month at a glance (Overview page) and the pay rates behind its cost
// estimate. Seen by the Director, Finance (approved records only, as
// everywhere), HR, the System Admin and the Auditor; rates are set by HR or
// the System Admin.

const express = require('express');
const authenticate = require('../middleware/authenticate');
const { requireRole, summaryVisibility } = require('../middleware/requireRole');
const { computeOverview, compare, attention } = require('../reports/overview');
const { loadPeriod, getPayRates, setPayRates } = require('../services/overviewData');
const { todayEat } = require('../services/recompute');

const router = express.Router();
const VIEWERS = ['director', 'finance', 'hr', 'sysadmin', 'auditor'];
const RATE_EDITORS = ['sysadmin', 'hr'];
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
    const [current, before, rates] = await Promise.all([
      loadPeriod({ subcontractorName: tenant, visibility, ...monthRange(month) }),
      loadPeriod({ subcontractorName: tenant, visibility, ...monthRange(prev) }),
      getPayRates(tenant)
    ]);
    const overview = computeOverview({ ...current, rates });
    const previous = computeOverview({ ...before, rates });
    const change = compare(overview, previous);
    res.json({
      month,
      label: monthLabel(month),
      previousLabel: monthLabel(prev),
      inProgress: month === thisMonth,
      overview,
      previous: { totals: previous.totals, cost: previous.cost },
      change,
      attention: attention(overview, change),
      rates,
      canEditRates: RATE_EDITORS.includes(req.user.role),
      scopeNote: req.user.role === 'finance' ? 'Approved records only' : null
    });
  } catch (err) {
    console.error('Failed to build overview:', err);
    res.status(500).json({ error: 'Could not load the overview.' });
  }
});

router.get('/settings/pay-rates', authenticate, requireRole(...VIEWERS), async (req, res) => {
  try {
    res.json({ rates: await getPayRates(req.user.subcontractorName), canEdit: RATE_EDITORS.includes(req.user.role) });
  } catch (err) {
    console.error('Failed to load pay rates:', err);
    res.status(500).json({ error: 'Could not load the pay rates.' });
  }
});

// Rates per shift worked (a double shift is two shifts). Leave one blank
// (null) to leave it open.
router.put('/settings/pay-rates', authenticate, requireRole(...RATE_EDITORS), async (req, res) => {
  const body = req.body || {};
  const amount = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
  const rates = { currency: String(body.currency || 'UGX').trim().toUpperCase(), dayShift: amount(body.dayShift), nightShift: amount(body.nightShift) };
  if (!/^[A-Z]{3}$/.test(rates.currency)) return res.status(400).json({ error: 'Currency must be a 3-letter code, e.g. UGX.' });
  for (const [k, label] of [['dayShift', 'Day shift'], ['nightShift', 'Night shift']]) {
    if (rates[k] !== null && (!Number.isFinite(rates[k]) || rates[k] < 0 || rates[k] > 1e9)) {
      return res.status(400).json({ error: `${label} rate must be a positive amount (or blank).` });
    }
  }
  try {
    const before = await getPayRates(req.user.subcontractorName);
    const saved = await setPayRates(req.user.subcontractorName, rates, req.user.id);
    res.locals.audit = { details: { before, after: saved } };
    res.json({ rates: saved });
  } catch (err) {
    console.error('Failed to save pay rates:', err);
    res.status(500).json({ error: 'Could not save the pay rates.' });
  }
});

module.exports = router;
