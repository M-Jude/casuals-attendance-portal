// The Director's weekly attendance digest: every Monday morning, the
// previous Monday-Sunday (EAT) compared with the week before, in the portal
// and by email. Sent to every active Director account.

const prisma = require('../prismaClient');
const { notifyUsers } = require('../services/notify');
const { loadPeriod, getPayRates } = require('../services/overviewData');
const { computeOverview, compare, digestText } = require('../reports/overview');
const { todayEat } = require('../services/recompute');
const { addDaysStr } = require('./shiftEngine');

const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// The last full Monday-Sunday week before `today` (YYYY-MM-DD, EAT).
function lastWeek(today) {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const thisMonday = addDaysStr(today, -((dow + 6) % 7));
  return { from: addDaysStr(thisMonday, -7), to: addDaysStr(thisMonday, -1) };
}

async function buildDigest(subcontractorName, today = todayEat()) {
  const week = lastWeek(today);
  const before = { from: addDaysStr(week.from, -7), to: addDaysStr(week.to, -7) };
  const [current, previous, rates] = await Promise.all([
    loadPeriod({ subcontractorName, ...week }),
    loadPeriod({ subcontractorName, ...before }),
    getPayRates(subcontractorName)
  ]);
  const overview = computeOverview({ ...current, rates });
  const change = compare(overview, computeOverview({ ...previous, rates }));
  const periodLabel = `week of ${fmt(week.from)} – ${fmt(week.to)}`;
  return {
    week,
    title: `Weekly attendance: ${periodLabel}`,
    // The link is added by notifyUsers (from APP_BASE_URL).
    body: digestText({ overview, change, periodLabel, portalUrl: null })
  };
}

// send: false only builds and returns the digests (for a preview).
async function runWeeklyDigest({ send = true, today } = {}) {
  const directors = await prisma.portalUser.findMany({ where: { role: 'director', active: true } });
  const tenants = [...new Set(directors.map((d) => d.subcontractorName))];
  const results = [];
  for (const tenant of tenants) {
    const digest = await buildDigest(tenant, today);
    const recipients = directors.filter((d) => d.subcontractorName === tenant);
    if (send) {
      await notifyUsers(recipients, { type: 'weekly-digest', title: digest.title, body: digest.body, link: '/?page=overview', email: true });
    }
    results.push({ tenant, recipients: recipients.map((d) => d.email), ...digest });
  }
  if (send) console.log(`Weekly digest sent to ${directors.length} director${directors.length === 1 ? '' : 's'}.`);
  return results;
}

module.exports = { runWeeklyDigest, buildDigest, lastWeek };
