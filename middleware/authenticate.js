const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');

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
      subcontractorName: user.subcontractorName
    };
    next();
  } catch (err) {
    console.error('Authentication lookup failed:', err);
    res.status(500).json({ error: 'Could not verify your session.' });
  }
}

module.exports = authenticate;
