const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');
const { READ_ONLY_ROLES } = require('./requireRole');

// Read-only roles (the Auditor) may look at anything their routes allow but
// change nothing. This is checked here, for every authenticated request,
// rather than trusted to each route's role list — so a route that forgets
// to leave them out still can't be used to change data. The only requests
// they may send that aren't reads concern their own session: signing out,
// changing their own password, logging a print, and marking their own
// notifications read.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_ONLY_ALLOWED = [
  /^\/api\/auth\/(logout|change-password)$/,
  /^\/api\/audit\/event$/,
  /^\/api\/notifications\/(read-all|\d+\/read)$/
];

function readOnlyAllows(method, originalUrl) {
  if (READ_METHODS.has(method)) return true;
  const path = (originalUrl || '').split('?')[0].replace(/\/$/, '');
  return READ_ONLY_ALLOWED.some((re) => re.test(path));
}

// While an account still has a password someone else chose, it may only
// load itself, change the password, or sign out.
const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout']);

function allowedBeforePasswordChange(originalUrl) {
  return ALLOWED_BEFORE_PASSWORD_CHANGE.has((originalUrl || '').split('?')[0].replace(/\/$/, ''));
}

// Verifies the Bearer token, then loads the account fresh from the database
// so a deactivation or role change takes effect on the next request rather
// than when the 8h token expires.
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  let payload;
  try {
    payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // A two-step pass (from /login, before the code) is not a session.
  if (payload.purpose) return res.status(401).json({ error: 'Invalid or expired token' });

  try {
    const user = await prisma.portalUser.findUnique({ where: { id: payload.userId } });
    if (!user || !user.active) return res.status(401).json({ error: 'Account is disabled' });
    // System Admins must have signed in with their authenticator code. A
    // session from before two-step sign-in (or from before they became a
    // System Admin) is ended, sending them through it.
    // A reset authenticator (mfaEnabledAt cleared) ends their sessions too.
    if (user.role === 'sysadmin' && (payload.mfa !== true || !user.mfaEnabledAt)) {
      return res.status(401).json({ error: 'System Admins sign in with an authenticator code. Sign in again.', code: 'MFA_REQUIRED' });
    }
    req.user = {
      id: user.id,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      crewId: user.crewId,
      casualWorkerId: user.casualWorkerId,
      subcontractorName: user.subcontractorName,
      mustChangePassword: user.mustChangePassword
    };
    if (user.mustChangePassword && !allowedBeforePasswordChange(req.originalUrl)) {
      return res.status(403).json({ error: 'Choose a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    if (READ_ONLY_ROLES.includes(user.role) && !readOnlyAllows(req.method, req.originalUrl)) {
      return res.status(403).json({ error: 'Your account is read-only — it can view records but not change them.', code: 'READ_ONLY' });
    }
    next();
  } catch (err) {
    console.error('Authentication lookup failed:', err);
    res.status(500).json({ error: 'Could not verify your session.' });
  }
}

module.exports = authenticate;
module.exports.allowedBeforePasswordChange = allowedBeforePasswordChange;
module.exports.readOnlyAllows = readOnlyAllows;
