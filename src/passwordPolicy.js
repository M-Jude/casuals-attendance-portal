// Password strength rules for the live checklist — a mirror of
// services/passwordPolicy.js, which is what the server enforces.
// test/passwordPolicyTest.js checks the two agree; change both together.

export const RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter (A–Z)', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter (a–z)', test: (p) => /[a-z]/.test(p) },
  { id: 'special', label: 'A special character (e.g. ! @ # $ % &)', test: (p) => /[^A-Za-z0-9\s]/.test(p) }
];

export const MAX_BYTES = 72;

export function unmetRules(password) {
  const p = typeof password === 'string' ? password : '';
  return RULES.filter((r) => !r.test(p));
}

export function isStrongPassword(password) {
  return typeof password === 'string' && !unmetRules(password).length && new TextEncoder().encode(password).length <= MAX_BYTES;
}
