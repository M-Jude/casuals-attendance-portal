// CLI for bootstrapping portal accounts. Day-to-day account management
// happens in the portal (HR / System Admin → Users); this covers the first
// System Admin and HR accounts, and recovery.
//
// Usage:
//   node scripts/seedPortalUser.js create <email> <password> <role> "<name>" [subcontractorName]
//   node scripts/seedPortalUser.js set-role <email> <role>
//   node scripts/seedPortalUser.js reset-password <email> <newPassword>
//
// Roles: sysadmin | hr | admin_assistant | finance | supervisor
// (supervisors are created in the portal, where you pick their worker record —
// they lead the crew that worker rotates with.)

const bcrypt = require('bcrypt');
const prisma = require('../prismaClient');
const { ROLES } = require('../middleware/requireRole');

const SALT_ROUNDS = 12;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function createUser(email, password, role, name, subcontractorName = 'Subcontractor A') {
  if (!ROLES.includes(role)) fail(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}`);
  if (role === 'supervisor') fail('Create supervisors in the portal (Users), where you pick their worker record.');
  const normalised = email.trim().toLowerCase();

  const existing = await prisma.portalUser.findUnique({ where: { email: normalised } });
  if (existing) fail(`A portal user with email "${normalised}" already exists. Use set-role or reset-password instead.`);

  const user = await prisma.portalUser.create({
    data: { email: normalised, name: name || '', role, passwordHash: await bcrypt.hash(password, SALT_ROUNDS), subcontractorName }
  });

  console.log(`Created portal user:
  id: ${user.id}
  email: ${user.email}
  role: ${user.role}
  subcontractor: ${user.subcontractorName}`);
}

async function setRole(email, role) {
  if (!ROLES.includes(role)) fail(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}`);
  if (role === 'supervisor') fail('Make supervisors in the portal (Users), where you pick their worker record.');
  const user = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) fail(`No portal user found with email "${email}".`);
  await prisma.portalUser.update({ where: { id: user.id }, data: { role, crewId: role === 'supervisor' ? user.crewId : null } });
  console.log(`${user.email} is now ${role}.`);
}

async function resetPassword(email, newPassword) {
  const user = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) fail(`No portal user found with email "${email}".`);
  await prisma.portalUser.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, SALT_ROUNDS) } });
  console.log(`Password reset for ${user.email}.`);
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (command === 'create') {
    const [email, password, role, name, subcontractorName] = args;
    if (!email || !password || !role) fail('Usage: node scripts/seedPortalUser.js create <email> <password> <role> "<name>" [subcontractorName]');
    await createUser(email, password, role, name, subcontractorName);
  } else if (command === 'set-role') {
    const [email, role] = args;
    if (!email || !role) fail('Usage: node scripts/seedPortalUser.js set-role <email> <role>');
    await setRole(email, role);
  } else if (command === 'reset-password') {
    const [email, newPassword] = args;
    if (!email || !newPassword) fail('Usage: node scripts/seedPortalUser.js reset-password <email> <newPassword>');
    await resetPassword(email, newPassword);
  } else {
    fail('Unknown command. Use "create", "set-role" or "reset-password".');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
