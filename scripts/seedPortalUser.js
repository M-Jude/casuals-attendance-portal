// One-off CLI script for provisioning or resetting the subcontractor's portal login.
// No self-service signup or email-based reset — this covers a single account created by hand.
//
// Usage:
//   node scripts/seedPortalUser.js create <email> <password> [subcontractorName]
//   node scripts/seedPortalUser.js reset-password <email> <newPassword>

const bcrypt = require('bcrypt');
const prisma = require('../prismaClient');

const SALT_ROUNDS = 12;

async function createUser(email, password, subcontractorName = 'Subcontractor A') {
  const existing = await prisma.portalUser.findUnique({ where: { email } });
  if (existing) {
    console.error(`A portal user with email "${email}" already exists. Use reset-password instead.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.portalUser.create({
    data: { email, passwordHash, subcontractorName }
  });

  console.log(`Created portal user:
  id: ${user.id}
  email: ${user.email}
  subcontractor: ${user.subcontractorName}`);
}

async function resetPassword(email, newPassword) {
  const user = await prisma.portalUser.findUnique({ where: { email } });
  if (!user) {
    console.error(`No portal user found with email "${email}".`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.portalUser.update({ where: { email }, data: { passwordHash } });

  console.log(`Password reset for ${email}.`);
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (command === 'create') {
    const [email, password, subcontractorName] = args;
    if (!email || !password) {
      console.error('Usage: node scripts/seedPortalUser.js create <email> <password> [subcontractorName]');
      process.exit(1);
    }
    await createUser(email, password, subcontractorName);
  } else if (command === 'reset-password') {
    const [email, newPassword] = args;
    if (!email || !newPassword) {
      console.error('Usage: node scripts/seedPortalUser.js reset-password <email> <newPassword>');
      process.exit(1);
    }
    await resetPassword(email, newPassword);
  } else {
    console.error('Unknown command. Use "create" or "reset-password".');
    process.exit(1);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
