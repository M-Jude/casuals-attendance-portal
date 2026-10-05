// Approves every batch still waiting for approval (pending or reopened) for
// one month's dates — crew shifts and permanent staff alike — to clear a
// backlog. Bypasses the usual who-may-approve rules, so each batch is
// stamped with the account that ran it, a comment saying so, and an
// audit-log entry.
//
//   node scripts/approveBacklog.js --month 2026-09 --as someone@caa.co.ug          # dry run: lists what would be approved
//   node scripts/approveBacklog.js --month 2026-09 --as someone@caa.co.ug --yes    # approves them

require('dotenv').config();
const prisma = require('../prismaClient');
const { approveUnit } = require('../services/approveUnit');
const { unitLabel } = require('../sync/approvalLogic');
const { record } = require('../services/audit');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

async function main() {
  const month = arg('month');
  const email = arg('as');
  const apply = process.argv.includes('--yes');
  if (!/^\d{4}-\d{2}$/.test(month || '') || !email) {
    console.error('Usage: node scripts/approveBacklog.js --month YYYY-MM --as <account email> [--yes]');
    process.exitCode = 1;
    return;
  }
  const user = await prisma.portalUser.findFirst({ where: { email, active: true } });
  if (!user) {
    console.error(`No active account with email ${email}.`);
    process.exitCode = 1;
    return;
  }

  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const units = await prisma.approvalUnit.findMany({
    where: {
      subcontractorName: user.subcontractorName,
      status: { in: ['pending', 'reopened'] },
      OR: [{ date: { gte: first, lte: last } }, { kind: 'hr-month', month }]
    },
    orderBy: { dueAt: 'asc' }
  });
  const [crews, shifts] = await Promise.all([prisma.crew.findMany(), prisma.shift.findMany()]);
  const crewName = new Map(crews.map((c) => [c.id, c.name]));
  const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
  const label = (u) => unitLabel(u, crewName.get(u.crewId), shiftName.get(u.shiftId));

  console.log(`${units.length} batch(es) waiting for approval in ${month}${apply ? '' : ' (dry run — add --yes to approve)'}:`);
  for (const u of units) console.log(`  ${label(u)} [${u.status}]`);
  if (!apply || units.length === 0) return;

  const comment = `Backlog approval of ${month}, run by ${user.name || user.email} (scripts/approveBacklog.js).`;
  const req = { headers: { 'user-agent': 'scripts/approveBacklog.js' }, method: 'SCRIPT', originalUrl: '/scripts/approveBacklog.js' };
  let done = 0;
  for (const u of units) {
    try {
      await approveUnit(u, { approverId: user.id, comment });
      await record(req, {
        user, category: 'approval', action: 'approval.approve', entityType: 'approval', entityId: u.id,
        summary: `Approved ${label(u)} (backlog approval of ${month} by script)`
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
