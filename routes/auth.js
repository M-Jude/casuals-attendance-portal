const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const QRCode = require('qrcode');
const { passwordProblem } = require('../services/passwordPolicy');
const { generateSecret, verifyCode, otpauthUri, formatSecret } = require('../services/totp');
const { generateCode, hashCode, checkCode: checkEmailCodeValue, resendWait, maskEmail, CODE_TTL_MS, CLEARED: CLEARED_EMAIL_CODE } = require('../services/emailCode');
const { sendSignInCode } = require('../services/notify');

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

    // System Admins also need a code — from their authenticator app or by
    // email: the password only earns a short-lived pass to the code step
    // (or, the first time, to setting two-step sign-in up). Email-code users
    // are sent their code straight away.
    if (needsTwoStep(user)) {
      const mfaToken = issueMfaToken(user);
      if (!user.mfaEnabledAt) {
        res.locals.audit = { summary: 'Password accepted — setting up two-step sign-in' };
        return res.json({ mfaSetupRequired: true, mfaToken, emailHint: maskEmail(user.email) });
      }
      const method = methodOf(user);
      const email = method === 'email' ? await issueEmailCode(user) : null;
      res.locals.audit = { summary: `Password accepted — waiting for the ${method === 'email' ? 'emailed' : 'authenticator'} code` };
      return res.json({
        mfaRequired: true,
        mfaToken,
        method,
        emailHint: maskEmail(user.email),
        ...(email ? { emailSent: email.sent, emailError: email.error || null } : {})
      });
    }

    res.json({ token: issueSession(user) });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login is temporarily unavailable. Try again shortly.' });
  }
});

// ------------------------------------------------------- two-step sign-in
//
// Required for System Admins. The session token they get carries mfa: true,
// and authenticate refuses a System Admin session without it — so a new
// System Admin, or one whose two-step sign-in was reset, is sent through
// setup at their next sign-in.
//
// Two methods, chosen at setup: an authenticator app (TOTP) or a code
// emailed at each sign-in. App users can also ask for an emailed code
// instead (e.g. phone left at home).

const MFA_TOKEN_TTL = '10m';

function needsTwoStep(user) {
  return user.role === 'sysadmin';
}

function methodOf(user) {
  return user.mfaMethod || (user.mfaSecret ? 'app' : 'email');
}

// Makes a fresh emailed code and sends it. { sent, error?, wait? }.
async function issueEmailCode(user) {
  const wait = resendWait(user);
  if (wait) return { sent: false, wait, error: `A code was sent less than a minute ago — wait ${wait} seconds before asking for another.` };
  const code = generateCode();
  const now = new Date();
  await prisma.portalUser.update({
    where: { id: user.id },
    data: { mfaEmailCodeHash: hashCode(user.id, code), mfaEmailCodeExpiresAt: new Date(now.getTime() + CODE_TTL_MS), mfaEmailCodeSentAt: now, mfaEmailCodeAttempts: 0 }
  });
  try {
    await sendSignInCode({ email: user.email, name: user.name, code });
    return { sent: true };
  } catch (err) {
    await prisma.portalUser.update({ where: { id: user.id }, data: { ...CLEARED_EMAIL_CODE, mfaEmailCodeSentAt: null } });
    console.error(`Sign-in code email to ${user.email} failed:`, err.message);
    return { sent: false, error: `The code couldn’t be emailed (${err.message}).` };
  }
}

// Checks an emailed code; on failure sends the response and returns false.
async function checkEmailCode(req, res, user) {
  const limitKey = `mfa|${user.id}`;
  if (isRateLimited(limitKey)) {
    res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
    return false;
  }
  const result = checkEmailCodeValue(user, req.body?.code);
  if (result === 'ok') {
    failedAttempts.delete(limitKey);
    // Use it up in one step, so the same code can't be used twice at once.
    const claimed = await prisma.portalUser.updateMany({ where: { id: user.id, mfaEmailCodeHash: user.mfaEmailCodeHash }, data: CLEARED_EMAIL_CODE });
    if (claimed.count === 1) return true;
    res.status(400).json({ error: 'That code has already been used. Send a new one.' });
    return false;
  }
  if (result === 'wrong') {
    recordFailure(limitKey);
    await prisma.portalUser.update({ where: { id: user.id }, data: { mfaEmailCodeAttempts: { increment: 1 } } });
  }
  const message = {
    none: 'No code has been emailed yet — use “Email me a code”.',
    expired: 'That code has expired. Send a new one.',
    locked: 'Too many wrong tries for that code. Send a new one.',
    wrong: 'That code isn’t right. Enter the 6-digit code from the latest email.'
  }[result];
  res.status(400).json({ error: message });
  return false;
}

function issueSession(user, { mfa = false } = {}) {
  return jwt.sign(
    { userId: user.id, subcontractorName: user.subcontractorName, ...(mfa ? { mfa: true } : {}) },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function issueMfaToken(user) {
  return jwt.sign({ userId: user.id, purpose: 'mfa' }, process.env.JWT_SECRET, { expiresIn: MFA_TOKEN_TTL });
}

// The account behind a pass from /login, or null (expired, tampered, not a
// two-step pass, or the account has since changed).
async function accountForMfaToken(mfaToken, res) {
  let payload;
  try {
    payload = jwt.verify(String(mfaToken || ''), process.env.JWT_SECRET);
  } catch {
    return null;
  }
  if (payload.purpose !== 'mfa') return null;
  const user = await prisma.portalUser.findUnique({ where: { id: payload.userId } });
  if (!user || !user.active || !needsTwoStep(user)) return null;
  res.locals.auditUser = user;
  return user;
}

const EXPIRED = 'Your sign-in has timed out. Sign in again with your email and password.';

// First sign-in (or after a reset): a new secret, shown as a QR code to
// scan into the authenticator app. Not active until a code from it is
// confirmed (/mfa/enable).
router.post('/mfa/setup', async (req, res) => {
  try {
    const user = await accountForMfaToken(req.body?.mfaToken, res);
    if (!user) return res.status(401).json({ error: EXPIRED, code: 'MFA_EXPIRED' });
    if (user.mfaEnabledAt) return res.status(409).json({ error: 'Two-step sign-in is already set up for this account.' });

    const secret = generateSecret();
    await prisma.portalUser.update({ where: { id: user.id }, data: { mfaPendingSecret: secret } });
    const uri = otpauthUri(secret, user.email);
    res.json({ secret: formatSecret(secret), otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  } catch (err) {
    console.error('Two-step setup failed:', err);
    res.status(500).json({ error: 'Could not start two-step setup. Try again shortly.' });
  }
});

async function checkCode(req, res, user, secret) {
  const limitKey = `mfa|${user.id}`;
  if (isRateLimited(limitKey)) {
    res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
    return null;
  }
  const step = verifyCode(secret, req.body?.code, { lastStep: user.mfaLastStep ?? null });
  if (step === null) {
    recordFailure(limitKey);
    res.status(400).json({ error: 'That code isn’t right. Enter the 6-digit code your authenticator app shows now.' });
    return null;
  }
  failedAttempts.delete(limitKey);
  return step;
}

// Sends (or re-sends) an emailed code: for email-code users, for app users
// who'd rather get a code by email, and during setup of the email method.
router.post('/mfa/email/send', async (req, res) => {
  try {
    const user = await accountForMfaToken(req.body?.mfaToken, res);
    if (!user) return res.status(401).json({ error: EXPIRED, code: 'MFA_EXPIRED' });
    const result = await issueEmailCode(user);
    if (result.wait) return res.status(429).json({ error: result.error, wait: result.wait });
    if (!result.sent) return res.status(503).json({ error: result.error });
    res.json({ sent: true, to: maskEmail(user.email) });
  } catch (err) {
    console.error('Sending a sign-in code failed:', err);
    res.status(500).json({ error: 'Could not send a code. Try again shortly.' });
  }
});

// Confirms setup and signs them in. method "app": a code from the newly
// scanned secret. method "email": the code just emailed by /mfa/email/send.
router.post('/mfa/enable', async (req, res) => {
  try {
    const user = await accountForMfaToken(req.body?.mfaToken, res);
    if (!user) return res.status(401).json({ error: EXPIRED, code: 'MFA_EXPIRED' });
    if (user.mfaEnabledAt) return res.status(409).json({ error: 'Two-step sign-in is already set up for this account.' });

    if (req.body?.method === 'email') {
      if (!(await checkEmailCode(req, res, user))) return undefined;
      await prisma.portalUser.update({
        where: { id: user.id },
        data: { mfaMethod: 'email', mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: new Date(), mfaLastStep: null }
      });
      res.locals.audit = { summary: 'Set up two-step sign-in (email codes) and signed in' };
      return res.json({ token: issueSession(user, { mfa: true }) });
    }

    if (!user.mfaPendingSecret) return res.status(400).json({ error: 'Start the setup again — scan a new QR code.' });
    const step = await checkCode(req, res, user, user.mfaPendingSecret);
    if (step === null) return undefined;
    await prisma.portalUser.update({
      where: { id: user.id },
      data: { mfaMethod: 'app', mfaSecret: user.mfaPendingSecret, mfaPendingSecret: null, mfaEnabledAt: new Date(), mfaLastStep: step }
    });
    res.locals.audit = { summary: 'Set up two-step sign-in (authenticator app) and signed in' };
    res.json({ token: issueSession(user, { mfa: true }) });
  } catch (err) {
    console.error('Two-step enable failed:', err);
    res.status(500).json({ error: 'Could not finish two-step setup. Try again shortly.' });
  }
});

// The everyday second step: the code from their authenticator app, or the
// one emailed to them (channel: "email" — email-code users always, app
// users when they asked for one).
router.post('/mfa/verify', async (req, res) => {
  try {
    const user = await accountForMfaToken(req.body?.mfaToken, res);
    if (!user) return res.status(401).json({ error: EXPIRED, code: 'MFA_EXPIRED' });
    if (!user.mfaEnabledAt) return res.status(409).json({ error: 'Two-step sign-in isn’t set up yet — sign in again to set it up.' });

    const channel = req.body?.channel === 'email' || methodOf(user) === 'email' ? 'email' : 'app';
    if (channel === 'email') {
      if (!(await checkEmailCode(req, res, user))) return undefined;
      res.locals.audit = { summary: 'Signed in (password + emailed code)' };
      return res.json({ token: issueSession(user, { mfa: true }) });
    }

    if (!user.mfaSecret) return res.status(400).json({ error: 'This account uses emailed codes.' });
    const step = await checkCode(req, res, user, user.mfaSecret);
    if (step === null) return undefined;
    // Remember the step so the same code can't be used again.
    const claimed = await prisma.portalUser.updateMany({
      where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step }
    });
    if (claimed.count === 0) return res.status(400).json({ error: 'That code has already been used. Wait for the next one.' });
    res.locals.audit = { summary: 'Signed in (password + authenticator code)' };
    res.json({ token: issueSession(user, { mfa: true }) });
  } catch (err) {
    console.error('Two-step verify failed:', err);
    res.status(500).json({ error: 'Could not check the code. Try again shortly.' });
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
