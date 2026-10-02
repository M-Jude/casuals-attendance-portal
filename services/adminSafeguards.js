// Protections around System Admin accounts (UCAA ICT): the last active
// System Admin can't be disabled or demoted, and every change to who holds
// System Admin — or to a System Admin's access — is told to all of them.

const prisma = require('../prismaClient');
const { notifyUsers } = require('./notify');

// Would this change leave the portal with no active System Admin?
//   target            the account being changed (role, active)
//   change            { role?, active? } as requested
//   otherActiveAdmins how many OTHER active System Admins there are
function removesLastAdmin(target, change, otherActiveAdmins) {
  if (target.role !== 'sysadmin' || !target.active) return false;
  const staysAdmin = (change.role === undefined || change.role === 'sysadmin') && change.active !== false;
  return !staysAdmin && otherActiveAdmins === 0;
}

async function otherActiveAdminCount(target) {
  return prisma.portalUser.count({
    where: { role: 'sysadmin', active: true, subcontractorName: target.subcontractorName, id: { not: target.id } }
  });
}

// In-app + email to every active System Admin (including the one who did
// it, so a change made from a compromised account is noticed).
async function tellAdmins(subcontractorName, { title, body }) {
  const admins = await prisma.portalUser.findMany({ where: { role: 'sysadmin', active: true, subcontractorName } });
  await notifyUsers(admins, { type: 'admin-security', title, body, link: '/?page=users', email: true });
}

module.exports = { removesLastAdmin, otherActiveAdminCount, tellAdmins };
