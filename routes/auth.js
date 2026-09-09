const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.portalUser.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { userId: user.id, subcontractorName: user.subcontractorName },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token });
});

module.exports = router;
