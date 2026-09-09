const axios = require('axios');
const https = require('https');

const TA_BASE_URL = process.env.BIOSTAR_TA_BASE_URL; // e.g. https://biostar-host:3002/tna
const BIOSTAR_USER = process.env.BIOSTAR_API_USER;
const BIOSTAR_PASS = process.env.BIOSTAR_API_PASS;

let taSessionCookie = null; // full "bs-ta-session-id=<value>" cookie string

function getAgent() {
  // Most on-prem BioStar servers use self-signed certs — point BIOSTAR_CA_CERT
  // at the real CA bundle rather than disabling verification.
  //
  // BIOSTAR_SKIP_TLS_VERIFY is a dev-only escape hatch for devices whose cert
  // fails Node's purpose check (e.g. "unsuitable certificate purpose") even
  // with the right CA — do not set this in production.
  if (process.env.BIOSTAR_SKIP_TLS_VERIFY === 'true') {
    return new https.Agent({ rejectUnauthorized: false });
  }

  return new https.Agent({
    rejectUnauthorized: true,
    ca: process.env.BIOSTAR_CA_CERT ? require('fs').readFileSync(process.env.BIOSTAR_CA_CERT) : undefined
  });
}

// Pulls a specific cookie's raw name=value pair out of a Set-Cookie header
// array, so it can be sent back verbatim on later requests via a Cookie
// header. Verified against a real Set-Cookie string from the live server —
// see test/cookieExtractionTest.js.
function extractCookie(setCookieHeader, cookieName) {
  if (!setCookieHeader) return null;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

  for (const cookieStr of cookies) {
    const match = cookieStr.match(new RegExp(`^${cookieName}=([^;]+)`));
    if (match) return `${cookieName}=${match[1]}`; // keep it URL-encoded, as received
  }
  return null;
}

// TA (Time & Attendance) login is a separate auth domain from the AC API —
// it takes the account's login_id (in a field confusingly named `user_id`,
// not the AC API's numeric user id) and password directly, and returns the
// session as a `bs-ta-session-id` Set-Cookie header rather than a plain
// response header, so it has to be replayed as a Cookie on later requests.
// Confirmed against a live server via test/liveBiostarCheck.js.
async function loginToTA() {
  const res = await axios.post(
    `${TA_BASE_URL}/login`,
    { user_id: BIOSTAR_USER, password: BIOSTAR_PASS },
    { httpsAgent: getAgent(), validateStatus: () => true }
  );

  taSessionCookie = extractCookie(res.headers['set-cookie'], 'bs-ta-session-id');

  if (!taSessionCookie) {
    throw new Error(`TA login failed — no bs-ta-session-id cookie in response (HTTP ${res.status}: ${JSON.stringify(res.data)})`);
  }
  return taSessionCookie;
}

// Fetches punch logs for a single calendar date (YYYY-MM-DD), across all
// users — there's no group/user filter on this endpoint, so matching against
// our own CasualWorker table (see attendanceSync.js) is what scopes it down
// to casuals.
// retrieveOnlyModified=false returns both device-recorded and manually
// modified punches, which is what we want for a complete daily sync.
async function fetchPunchLogsForDate(dateStr) {
  if (!taSessionCookie) await loginToTA();

  const res = await axios.post(
    `${TA_BASE_URL}/punch_logs/modified`,
    {
      date: dateStr,
      day_start_time: 0,
      retrieve_only_modified: false,
      limit: 5000
    },
    { headers: { Cookie: taSessionCookie }, httpsAgent: getAgent(), validateStatus: () => true }
  );

  if (res.status === 401 || res.status === 404) {
    // 401: TA session expired. 404 can also occur if the session cookie
    // wasn't accepted and BioStar's router falls through unexpectedly —
    // re-login once and retry either way before giving up.
    taSessionCookie = null;
    await loginToTA();
    return fetchPunchLogsForDate(dateStr);
  }

  if (res.status !== 200) {
    throw new Error(`Punch log fetch failed — HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }

  return res.data?.records || [];
}

// Fetches every user known to BioStar (paginated — this device has 2000+
// across all groups) and returns only those in the given user_group name
// (case-insensitive), e.g. "CASUALS". This is how we scope the portal to
// casual workers, since the TNA punch endpoint itself has no group filter.
async function fetchGroupUsers(groupName) {
  if (!taSessionCookie) await loginToTA();

  const wanted = groupName.toLowerCase();
  const matched = [];
  let offset = 0;
  const limit = 200;
  let total = Infinity;

  while (offset < total) {
    const res = await axios.get(`${TA_BASE_URL}/users`, {
      httpsAgent: getAgent(),
      headers: { Cookie: taSessionCookie },
      params: { offset, limit },
      validateStatus: () => true
    });

    if (res.status === 401 || res.status === 404) {
      taSessionCookie = null;
      await loginToTA();
      continue; // retry this same page with a fresh session
    }
    if (res.status !== 200) {
      throw new Error(`Failed to list BioStar users (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }

    total = res.data.total;
    const records = res.data.records || [];
    if (records.length === 0) break;

    for (const u of records) {
      if ((u.user_group?.name || '').toLowerCase() === wanted) {
        matched.push({ userId: u.user_id, name: u.name });
      }
    }

    offset += records.length;
  }

  return matched;
}

module.exports = { fetchPunchLogsForDate, fetchGroupUsers };
