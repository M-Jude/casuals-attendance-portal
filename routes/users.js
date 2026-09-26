const express = require('express');
const bcrypt = require('bcrypt');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole, ROLES, CAN_CREATE } = require('../middleware/requireRole');

const router = express.Router();
const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

const PUBLIC_FIELDS = {
  id: true, email: true, name: true, role: true, crewId: true, active: true, createdAt: true,
  crew: { select: { id: true, name: true } }
};

async function validateCrew(crewId, subcontractorName) {
  if (crewId === null || crewId === undefined || crewId === '') return null;
  const crew = await prisma.crew.findFirst({ where: { id: Number(crewId), subcontractorName } });
  if (!crew) throw Object.assign(new Error('Unknown crew.'), { status: 400 });
  return crew.id;
}

router.get('/users', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  try {
    const users = await prisma.portalUser.findMany({
      where: { subcontractorName: req.user.subcontractorName },
      select: PUBLIC_FIELDS,
      orderBy: [{ role: 'asc' }, { name: 'asc' }]
    });
    res.json({ users, canCreate: CAN_CREATE[req.user.role] || [] });
  } catch (err) {
    console.error('Failed to list users:', err);
    res.status(500).json({ error: 'Could not load accounts.' });
  }
});

router.post('/users', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const { email, name, role, password, crewId } = req.body || {};
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!(CAN_CREATE[req.user.role] || []).includes(role)) return res.status(403).json({ error: 'You cannot create an account with that role.' });
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  try {
    const crew = await validateCrew(crewId, req.user.subcontractorName);
    if (role === 'supervisor' && !crew) return res.status(400).json({ error: 'A shift supervisor must lead a crew.' });

    const existing = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const user = await prisma.portalUser.create({
      data: {
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role,
        crewId: role === 'supervisor' ? crew : null,
        passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
        subcontractorName: req.user.subcontractorName,
        createdById: req.user.id
      },
      select: PUBLIC_FIELDS
    });
    res.status(201).json({ user });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to create user:', err);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// Update name, crew, active flag, role or password. HR may only change the
// roles it can create (not HR or System Admin accounts).
router.patch('/users/:id', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, role, crewId, active, password } = req.body || {};

  try {
    const target = await prisma.portalUser.findFirst({ where: { id, subcontractorName: req.user.subcontractorName } });
    if (!target) return res.status(404).json({ error: 'Account not found.' });

    const allowed = CAN_CREATE[req.user.role] || [];
    if (!allowed.includes(target.role)) return res.status(403).json({ error: 'You cannot change this account.' });
    if (role !== undefined && (!ROLES.includes(role) || !allowed.includes(role))) {
      return res.status(403).json({ error: 'You cannot assign that role.' });
    }
    if (active === false && target.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });

    const data = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (role !== undefined) data.role = role;
    if (typeof active === 'boolean') data.active = active;
    if (crewId !== undefined) data.crewId = await validateCrew(crewId, req.user.subcontractorName);
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      }
      data.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    }

    const finalRole = data.role ?? target.role;
    const finalCrew = data.crewId !== undefined ? data.crewId : target.crewId;
    if (finalRole === 'supervisor' && !finalCrew) return res.status(400).json({ error: 'A shift supervisor must lead a crew.' });
    if (finalRole !== 'supervisor') data.crewId = null;

    const user = await prisma.portalUser.update({ where: { id }, data, select: PUBLIC_FIELDS });
    res.json({ user });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to update user:', err);
    res.status(500).json({ error: 'Could not update the account.' });
  }
});

module.exports = router;
