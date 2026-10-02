// Password strength rules — the server's copy, and the one that decides.
// src/passwordPolicy.js mirrors it for the live checklist in the browser;
// test/passwordPolicyTest.js checks the two agree.
//
// Applies wherever a password is set (new account, reset, own change, CLI
// seeding) — not at sign-in, so existing passwords keep working.

const RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter (A–Z)', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter (a–z)', test: (p) => /[a-z]/.test(p) },
  { id: 'special', label: 'A special character (e.g. ! @ # $ % &)', test: (p) => /[^A-Za-z0-9\s]/.test(p) }
];

// bcrypt only uses the first 72 bytes, so anything longer would quietly be
// cut short.
const MAX_BYTES = 72;

// The rules a password fails (empty when it passes all of them).
function unmetRules(password) {
  const p = typeof password === 'string' ? password : '';
  return RULES.filter((r) => !r.test(p));
}

// An error message for a password that isn't acceptable, or null.
function passwordProblem(password) {
  if (typeof password !== 'string') return 'A password is required.';
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) return `Password is too long (${MAX_BYTES} characters at most).`;
  const unmet = unmetRules(password);
  if (!unmet.length) return null;
  return `Password needs: ${unmet.map((r) => r.label.replace(/^(At least|An?) /, (m) => m.toLowerCase())).join(', ')}.`;
}

// A one-time password for a new account or a reset — generated, so no
// admin ever chooses (or needs to know) someone else's password. Ten
// characters, always meeting the rules above, without look-alikes (0/O,
// 1/l/I) or symbols that are awkward to type, since people read it from an
// email.
const crypto = require('crypto');
const TEMP_SETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnpqrstuvwxyz',
  digit: '23456789',
  special: '!@#$%&*?'
};
const TEMP_LENGTH = 10;

function generateTemporaryPassword() {
  const pick = (set) => set[crypto.randomInt(set.length)];
  const all = Object.values(TEMP_SETS).join('');
  // One of each kind, the rest from everything, then shuffled.
  const chars = [pick(TEMP_SETS.upper), pick(TEMP_SETS.lower), pick(TEMP_SETS.digit), pick(TEMP_SETS.special)];
  while (chars.length < TEMP_LENGTH) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

module.exports = { RULES, MAX_BYTES, unmetRules, passwordProblem, generateTemporaryPassword, TEMP_LENGTH };
