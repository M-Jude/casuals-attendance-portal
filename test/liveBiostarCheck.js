// Run this from a machine that can reach your BioStar server directly.
// It is NOT part of the app — it's a one-off connectivity/shape check.
//
// Usage:
//   BIOSTAR_TA_BASE_URL=https://<host>:3002/tna \
//   BIOSTAR_API_USER=<login_id> \
//   BIOSTAR_API_PASS=<password> \
//   BIOSTAR_CA_CERT=/path/to/ca.pem \
//   node test/liveBiostarCheck.js [YYYY-MM-DD]
//
// It will print exactly which step fails, so you can tell immediately
// whether it's the TA login or the punch-log fetch that needs adjusting
// for your BioStar version.

const axios = require('axios');
const https = require('https');
const fs = require('fs');

const TA_BASE_URL = process.env.BIOSTAR_TA_BASE_URL;
const USER = process.env.BIOSTAR_API_USER;
const PASS = process.env.BIOSTAR_API_PASS;
const CA_CERT = process.env.BIOSTAR_CA_CERT;
const dateArg = process.argv[2] || new Date().toISOString().slice(0, 10);

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
requireEnv('BIOSTAR_TA_BASE_URL', TA_BASE_URL);
requireEnv('BIOSTAR_API_USER', USER);
requireEnv('BIOSTAR_API_PASS', PASS);

function getAgent() {
  if (process.env.BIOSTAR_SKIP_TLS_VERIFY === 'true') {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return new https.Agent({
    rejectUnauthorized: true,
    ca: CA_CERT ? fs.readFileSync(CA_CERT) : undefined
  });
}

function logStep(n, label) {
  console.log(`\n[Step ${n}] ${label}`);
}

async function main() {
  logStep(1, `TA login — POST ${TA_BASE_URL}/login`);
  const loginRes = await axios.post(
    `${TA_BASE_URL}/login`,
    { user_id: USER, password: PASS },
    { httpsAgent: getAgent(), validateStatus: () => true }
  );

  console.log(`  HTTP ${loginRes.status}`);
  const setCookie = loginRes.headers['set-cookie']?.find((c) => c.startsWith('bs-ta-session-id='));

  if (!setCookie) {
    console.error('  FAILED — no bs-ta-session-id cookie in response.');
    console.error('  Response body:', JSON.stringify(loginRes.data, null, 2));
    process.exit(1);
  }
  const sessionCookie = setCookie.split(';')[0];
  console.log(`  OK — TA session cookie received: ${sessionCookie.slice(0, 24)}...`);

  logStep(2, `Punch log fetch — POST ${TA_BASE_URL}/punch_logs/modified (date=${dateArg})`);
  const punchRes = await axios.post(
    `${TA_BASE_URL}/punch_logs/modified`,
    { date: dateArg, day_start_time: 0, retrieve_only_modified: false, limit: 50 },
    { headers: { Cookie: sessionCookie }, httpsAgent: getAgent(), validateStatus: () => true }
  );

  console.log(`  HTTP ${punchRes.status}`);
  if (punchRes.status !== 200) {
    console.error('  FAILED — non-200 response.');
    console.error('  Response body:', JSON.stringify(punchRes.data, null, 2));
    process.exit(1);
  }

  const records = punchRes.data?.records || [];
  console.log(`  OK — ${records.length} punch record(s) returned for ${dateArg}`);
  if (records.length > 0) {
    console.log('  Sample record:', JSON.stringify(records[0], null, 2));
  } else {
    console.log('  (No punches for this date — try a date you know has attendance activity.)');
  }

  console.log('\nAll steps completed.');
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
