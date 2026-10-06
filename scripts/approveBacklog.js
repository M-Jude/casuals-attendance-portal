// Approves every batch still waiting for approval (pending or reopened) for
// a month's dates, or a custom date range — crew shifts and permanent staff
// alike — to clear a backlog. Bypasses the usual who-may-approve rules, so
// each batch is stamped with the account that ran it, a comment saying so,
// and an audit-log entry. Batches whose shift hasn't ended yet are skipped;
// an older monthly permanent-staff batch (hr-month) is included only when
// the range covers its whole month.
//
//   node scripts/approveBacklog.js --month 2026-09 --as someone@caa.co.ug                       # dry run: lists what would be approved
//   node scripts/approveBacklog.js --from 2026-10-01 --to 2026-10-04 --as someone@caa.co.ug     # a custom range (dates inclusive)
//   ... --yes                                                                                    # approves them

require('dotenv').config();
const prisma = require('../prismaClient');
const { approveUnit } = require('../services/approveUnit');
const { unitLabel } = require('../sync/approvalLogic');
const { record } = require('../services/audit');
const { wholeMonths } = require('../services/overviewData');

const USAGE = 'Usage: node scripts/approveBacklog.js (--month YYYY-MM | --from YYYY-MM-DD [--to YYYY-MM-DD]) --as <account email> [--yes]';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

// { from, to, text } (inclusive YYYY-MM-DD dates) from --month or
// --from/--to (--to defaults to --from); null if the arguments don't make one.
function period() {
  const month = arg('month');
  if (month && (arg('from') || arg('to'))) return null;
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    const [y, m] = month.split('-').map(Number);
    return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), text: month };
  }
  const from = arg('from');
  const to = arg('to') || from;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to) || from > to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
  return { from, to, text: from === to ? from : `${from} to ${to}` };
}

async function main() {
  const p = period();
  const email = arg('as');
  const apply = process.argv.includes('--yes');
  if (!p || !email) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const user = await prisma.portalUser.findFirst({ where: { email, active: true } });
  if (!user) {
    console.error(`No active account with email ${email}.`);
    process.exitCode = 1;
    return;
  }

  const months = wholeMonths(p.from, p.to);
  const waiting = await prisma.approvalUnit.findMany({
    where: {
      subcontractorName: user.subcontractorName,
      status: { in: ['pending', 'reopened'] },
      OR: [
        { kind: { in: ['crew-shift', 'hr-shift'] }, date: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) } },
        ...(months.length ? [{ kind: 'hr-month', month: { in: months } }] : [])
      ]
    },
    orderBy: { dueAt: 'asc' }
  });
  const now = Date.now();
  const units = waiting.filter((u) => new Date(u.dueAt).getTime() <= now);
  const notYet = waiting.filter((u) => !units.includes(u));
  const [crews, shifts] = await Promise.all([prisma.crew.findMany(), prisma.shift.findMany()]);
  const crewName = new Map(crews.map((c) => [c.id, c.name]));
  const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
  const label = (u) => unitLabel(u, crewName.get(u.crewId), shiftName.get(u.shiftId));

  console.log(`${units.length} batch(es) waiting for approval in ${p.text}${apply ? '' : ' (dry run — add --yes to approve)'}:`);
  for (const u of units) console.log(`  ${label(u)} [${u.status}]`);
  if (notYet.length) {
    console.log(`Skipped — shift not ended yet, so not approvable:`);
    for (const u of notYet) console.log(`  ${label(u)}`);
  }
  if (!apply || units.length === 0) return;

  const comment = `Backlog approval of ${p.text}, run by ${user.name || user.email} (scripts/approveBacklog.js).`;
  const req = { headers: { 'user-agent': 'scripts/approveBacklog.js' }, method: 'SCRIPT', originalUrl: '/scripts/approveBacklog.js' };
  let done = 0;
  for (const u of units) {
    try {
      await approveUnit(u, { approverId: user.id, comment });
      await record(req, {
        user, category: 'approval', action: 'approval.approve', entityType: 'approval', entityId: u.id,
        summary: `Approved ${label(u)} (backlog approval of ${p.text} by script)`
      });
      done++;
    } catch (err) {
      if (err.status === 409) console.log(`  already approved meanwhile: ${label(u)}`);
      else throw err;
    }
  }
  console.log(`Approved ${done} batch(es) as ${user.name || user.email}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
