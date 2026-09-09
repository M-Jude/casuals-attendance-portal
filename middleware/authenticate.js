const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.user = payload; // { userId, subcontractorName }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authenticate;
