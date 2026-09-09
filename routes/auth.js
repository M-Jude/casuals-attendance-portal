const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');

const router = express.Router();

// Minimal in-memory rate limiting to blunt brute-force attempts against a
// login endpoint with only 1-2 real accounts. For production-grade
// protection (multiple server instances, IP spoofing resistance), swap this
// for express-rate-limit backed by Redis instead.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const attemptsByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const record = attemptsByIp.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    attemptsByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  record.count++;
  return record.count > MAX_ATTEMPTS;
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  try {
    const user = await prisma.portalUser.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

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

module.exports = router;
