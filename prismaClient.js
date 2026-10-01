// Load the app's .env here too, so the CLI scripts (seeds, bootstrap) get
// DATABASE_URL without relying on Prisma's own .env lookup — that resolves
// relative to where the client was generated, which in a CI build isn't the
// app folder.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = prisma;
