// Authenticator-app codes (TOTP, RFC 6238: HMAC-SHA1, 6 digits, 30-second
// steps) for two-step sign-in — works with Google Authenticator, Microsoft
// Authenticator, Authy and the like. Built on Node's crypto; no library.

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'UCAA Casuals Portal';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 secret.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160-bit secret, as base32 (what authenticator apps expect).
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Checks a code against the current step and one either side (for clock
// drift). Returns the matching step, or null. A step at or before lastStep
// is refused, so a code can't be replayed.
function verifyCode(secret, code, { lastStep = null, now = Date.now() } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean) || !secret) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
}

// What the QR code holds: adds the account to an authenticator app.
function otpauthUri(secret, accountName) {
  const label = encodeURIComponent(`${ISSUER}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// The secret in groups of four, for typing in by hand.
function formatSecret(secret) {
  return secret.match(/.{1,4}/g).join(' ');
}

module.exports = { generateSecret, verifyCode, otpauthUri, formatSecret, codeAt, currentStep, base32Encode, base32Decode };
