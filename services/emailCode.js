// One-time sign-in codes sent by email (the email option of two-step
// sign-in). 6 digits, valid 10 minutes, one use, 5 wrong guesses and it's
// void, at most one email a minute. Only a hash of the code is stored.

const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Tied to the account, so a hash copied to another row is useless.
function hashCode(userId, code) {
  return crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

// Can a new code be sent now? Returns null, or seconds to wait.
function resendWait(user, now = Date.now()) {
  if (!user.mfaEmailCodeSentAt) return null;
  const wait = new Date(user.mfaEmailCodeSentAt).getTime() + RESEND_AFTER_MS - now;
  return wait > 0 ? Math.ceil(wait / 1000) : null;
}

// Checks a code against the account's current emailed code.
//   'ok' | 'none' (no code pending) | 'expired' | 'locked' (too many tries) | 'wrong'
function checkCode(user, code, now = Date.now()) {
  if (!user.mfaEmailCodeHash) return 'none';
  if (!user.mfaEmailCodeExpiresAt || new Date(user.mfaEmailCodeExpiresAt).getTime() < now) return 'expired';
  if ((user.mfaEmailCodeAttempts || 0) >= MAX_ATTEMPTS) return 'locked';
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return 'wrong';
  const a = Buffer.from(hashCode(user.id, clean));
  const b = Buffer.from(user.mfaEmailCodeHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

// "j••••@caa.co.ug" — enough to recognise the address, not to harvest it.
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

const CLEARED = { mfaEmailCodeHash: null, mfaEmailCodeExpiresAt: null, mfaEmailCodeAttempts: 0 };

module.exports = { generateCode, hashCode, checkCode, resendWait, maskEmail, CODE_TTL_MS, RESEND_AFTER_MS, MAX_ATTEMPTS, CLEARED };
