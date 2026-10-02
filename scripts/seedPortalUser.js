// CLI for bootstrapping portal accounts. Day-to-day account management
// happens in the portal (HR / System Admin → Users); this covers the first
// System Admin and HR accounts, and recovery.
//
// Usage:
//   node scripts/seedPortalUser.js create <email> <password> <role> "<name>" [subcontractorName]
//   node scripts/seedPortalUser.js set-role <email> <role>
//   node scripts/seedPortalUser.js reset-password <email> <newPassword>
//   node scripts/seedPortalUser.js reset-two-step <email>     (lost authenticator, no other System Admin)
//
// Roles: sysadmin | hr | admin_assistant | finance | supervisor | auditor
// (supervisors are created in the portal, where you pick their worker record —
// they lead the crew that worker rotates with.)

const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');
const { ROLES } = require('../middleware/requireRole');
const { passwordProblem } = require('../services/passwordPolicy');

const SALT_ROUNDS = 12;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function createUser(email, password, role, name, subcontractorName = 'Subcontractor A') {
  if (!ROLES.includes(role)) fail(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}`);
  if (role === 'supervisor') fail('Create supervisors in the portal (Users), where you pick their worker record.');
  const weak = passwordProblem(password);
  if (weak) fail(weak);
  const normalised = email.trim().toLowerCase();

  const existing = await prisma.portalUser.findUnique({ where: { email: normalised } });
  if (existing) fail(`A portal user with email "${normalised}" already exists. Use set-role or reset-password instead.`);

  const user = await prisma.portalUser.create({
    // Typed on a command line (and so in shell history): one-time, changed at first sign-in.
    data: { email: normalised, name: name || '', role, passwordHash: await bcrypt.hash(password, SALT_ROUNDS), mustChangePassword: true, subcontractorName }
  });

  console.log(`Created portal user:
  id: ${user.id}
  email: ${user.email}
  role: ${user.role}
  subcontractor: ${user.subcontractorName}
The password is one-time: they'll be asked to choose a new one when they first sign in.`);
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
  const weak = passwordProblem(newPassword);
  if (weak) fail(weak);
  const user = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) fail(`No portal user found with email "${email}".`);
  await prisma.portalUser.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, SALT_ROUNDS), mustChangePassword: true } });
  console.log(`Password reset for ${user.email}. They'll be asked to choose a new one when they sign in.`);
}

// Last resort when a System Admin has lost their authenticator and no other
// System Admin can reset it in the portal.
async function resetTwoStep(email) {
  const user = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) fail(`No portal user found with email "${email}".`);
  await prisma.portalUser.update({ where: { id: user.id }, data: { mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null } });
  console.log(`Two-step sign-in reset for ${user.email}. They'll set up a new authenticator at their next sign-in.`);
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
  } else if (command === 'reset-two-step') {
    const [email] = args;
    if (!email) fail('Usage: node scripts/seedPortalUser.js reset-two-step <email>');
    await resetTwoStep(email);
  } else {
    fail('Unknown command. Use "create", "set-role", "reset-password" or "reset-two-step".');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
