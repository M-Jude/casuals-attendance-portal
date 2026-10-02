const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { passwordProblem } = require('../services/passwordPolicy');

const router = express.Router();

// Minimal in-memory rate limiting to blunt brute-force attempts. Only
// FAILED attempts count, per email + IP — staff in one office share an IP,
// so counting every login per IP would lock the sixth colleague out. A
// successful login clears the account's count. For production-grade
// protection (multiple server instances, IP spoofing resistance), swap this
// for express-rate-limit backed by Redis instead.
const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const failedAttempts = new Map();

function isRateLimited(key) {
  const record = failedAttempts.get(key);
  if (!record) return false;
  if (Date.now() - record.windowStart > WINDOW_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return record.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(key) {
  const record = failedAttempts.get(key);
  if (!record || Date.now() - record.windowStart > WINDOW_MS) failedAttempts.set(key, { count: 1, windowStart: Date.now() });
  else record.count++;
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const normalisedEmail = email.trim().toLowerCase();
  const limitKey = `${req.ip}|${normalisedEmail}`;
  if (isRateLimited(limitKey)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Try again in 15 minutes.' });
  }

  try {
    const user = await prisma.portalUser.findUnique({ where: { email: normalisedEmail } });
    // Sign-in attempts are audited against the account they named, if it exists.
    if (user) res.locals.auditUser = user;
    const valid = user && user.active && (await bcrypt.compare(password, user.passwordHash));
    if (!valid) {
      recordFailure(limitKey);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    failedAttempts.delete(limitKey);

    const token = jwt.sign(
      { userId: user.id, subcontractorName: user.subcontractorName },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login is temporarily unavailable. Try again shortly.' });
  }
});

// The account holder sets their own password — required before anything
// else when someone else chose it (mustChangePassword). A wrong current
// password is a 400, not a 401: the session itself is fine, and the
// frontend signs out on any 401.
const SALT_ROUNDS = 12;

router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Your current password and a new password are required.' });
  }
  const weak = passwordProblem(newPassword);
  if (weak) return res.status(400).json({ error: weak });
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'The new password must be different from the current one.' });
  }

  const limitKey = `${req.ip}|change-password|${req.user.id}`;
  if (isRateLimited(limitKey)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  try {
    const user = await prisma.portalUser.findUnique({ where: { id: req.user.id } });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      recordFailure(limitKey);
      return res.status(400).json({ error: 'Your current password is incorrect.' });
    }
    failedAttempts.delete(limitKey);

    await prisma.portalUser.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, SALT_ROUNDS), mustChangePassword: false }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Password change failed:', err);
    res.status(500).json({ error: 'Could not change your password. Try again shortly.' });
  }
});

// Signing out is client-side (the token is dropped); this only records it
// in the audit log.
router.post('/logout', authenticate, (req, res) => res.status(204).end());

// The signed-in account — the frontend uses this to decide which pages and
// actions to show (the API enforces the same rules server-side).
router.get('/me', authenticate, async (req, res) => {
  const [crew, worker] = await Promise.all([
    req.user.crewId ? prisma.crew.findUnique({ where: { id: req.user.crewId } }) : null,
    req.user.casualWorkerId ? prisma.casualWorker.findUnique({ where: { id: req.user.casualWorkerId }, select: { id: true, name: true, biostarUserId: true } }) : null
  ]);
  res.json({ user: { ...req.user, crewName: crew ? crew.name : null, worker } });
});

module.exports = router;
