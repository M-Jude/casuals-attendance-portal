// Isolated test of extractCookie() against the real Set-Cookie string
// returned by the live BioStar server, to confirm the parsing logic works
// before trusting it in the full sync.

// Re-implemented here (not exported from biostarClient.js) to test in
// isolation without needing axios/https/env vars wired up.
function extractCookie(setCookieHeader, cookieName) {
  if (!setCookieHeader) return null;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

  for (const cookieStr of cookies) {
    const match = cookieStr.match(new RegExp(`^${cookieName}=([^;]+)`));
    if (match) return `${cookieName}=${match[1]}`;
  }
  return null;
}

// The actual Set-Cookie value from Jude's Postman test
const realSetCookie = [
  'bs-ta-session-id=s%3AI-CSqDM6R-RJjJt4r6AcEem4ZaPPbLy7.dJdybEu85Limw1E8gJ7LDbTgBjnwmxi4VVopHjw5Qfk; Path=/; Expires=Tue, 08 Sep 2026 12:42:39 GMT; HttpOnly; Secure'
];

const result = extractCookie(realSetCookie, 'bs-ta-session-id');
console.log('Extracted Cookie header value:');
console.log(' ', result);

const checks = [
  ['extraction returns a non-null value', result !== null],
  ['starts with the cookie name', result?.startsWith('bs-ta-session-id=')],
  ['preserves the URL-encoded value verbatim', result === 'bs-ta-session-id=s%3AI-CSqDM6R-RJjJt4r6AcEem4ZaPPbLy7.dJdybEu85Limw1E8gJ7LDbTgBjnwmxi4VVopHjw5Qfk'],
  ['does not include Path/Expires/HttpOnly/Secure attributes', !result?.includes('Path=') && !result?.includes('Expires=')],
  ['returns null for a non-matching cookie name', extractCookie(realSetCookie, 'some-other-cookie') === null],
  ['returns null for missing Set-Cookie header', extractCookie(undefined, 'bs-ta-session-id') === null]
];

console.log('\nChecks:');
let allPassed = true;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) allPassed = false;
}

process.exit(allPassed ? 0 : 1);
