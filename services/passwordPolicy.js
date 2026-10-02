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

module.exports = { RULES, MAX_BYTES, unmetRules, passwordProblem };
