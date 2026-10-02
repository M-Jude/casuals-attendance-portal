// When the server answers without its usual { error } message. A bare 404
// means the API doesn't have that endpoint — almost always a server still
// running an older version after an update.
function fallbackMessage(status) {
  if (status === 404) return 'The server doesn’t have this feature yet — the portal API needs restarting after the latest update.';
  if (status === 502 || status === 503 || status === 504) return 'Can’t reach the portal server right now. Try again in a moment.';
  return `Something went wrong on the server (error ${status}). Try again.`;
}

// JSON fetch helper bound to the signed-in user's token. A 401 means the
// session is over (expired, or the account was disabled) — sign out.
export function makeApi(token, onUnauthorized) {
  return async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) {
      onUnauthorized();
      throw new Error('Your session has ended. Sign in again.');
    }
    const data = await res.json().catch(() => ({}));
    // The response body rides along (err.data) — e.g. a 409 asking which way
    // to go when a supervisor's worker record is moved.
    if (!res.ok) throw Object.assign(new Error(data.error || fallbackMessage(res.status)), { status: res.status, data });
    return data;
  };
}

export const ROLE_LABEL = {
  sysadmin: 'System Admin',
  hr: 'HR',
  admin_assistant: 'Admin Assistant',
  finance: 'Finance',
  supervisor: 'Shift Supervisor',
  auditor: 'Auditor',
  director: 'Director'
};

// Roles that can see but never change anything (the API refuses their
// changes too). Pages hide their editing controls for them.
export function isReadOnly(user) {
  return ['auditor', 'director', 'finance'].includes(user?.role);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-09-24" → "24 Sep 2026" (a date label, no timezone shifting).
export function formatDateLabel(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala'
  });
}

export function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' });
}

// Today's date in Kampala as YYYY-MM-DD.
export function todayEat() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
