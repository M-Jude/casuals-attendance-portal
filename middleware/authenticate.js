const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');

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

  try {
    const user = await prisma.portalUser.findUnique({ where: { id: payload.userId } });
    if (!user || !user.active) return res.status(401).json({ error: 'Account is disabled' });
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
    next();
  } catch (err) {
    console.error('Authentication lookup failed:', err);
    res.status(500).json({ error: 'Could not verify your session.' });
  }
}

module.exports = authenticate;
module.exports.allowedBeforePasswordChange = allowedBeforePasswordChange;
