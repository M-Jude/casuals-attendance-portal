const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole, ROLES, CAN_CREATE } = require('../middleware/requireRole');
const { resolveWorkerLink } = require('../services/accountLink');
const { setWorkerSchedule } = require('../services/workerSchedule');
const { todayEat } = require('../services/recompute');

const { passwordProblem } = require('../services/passwordPolicy');

const router = express.Router();
const SALT_ROUNDS = 12;

const PUBLIC_FIELDS = {
  id: true, email: true, name: true, role: true, crewId: true, active: true, createdAt: true, casualWorkerId: true, mustChangePassword: true,
  crew: { select: { id: true, name: true } },
  worker: { select: { id: true, name: true, biostarUserId: true, status: true } }
};

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

// Create an account. A supervisor must be linked to their worker record and
// leads the crew that worker rotates with; other roles may link one too.
router.post('/users', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const { email, name, role, password, casualWorkerId } = req.body || {};
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  if (!(CAN_CREATE[req.user.role] || []).includes(role)) return res.status(403).json({ error: 'You cannot create an account with that role.' });
  const weak = passwordProblem(password);
  if (weak) return res.status(400).json({ error: weak });

  try {
    const { worker, crewId } = await resolveWorkerLink({ casualWorkerId, role, subcontractorName: req.user.subcontractorName });
    const displayName = (typeof name === 'string' && name.trim()) || worker?.name || '';
    if (!displayName) return res.status(400).json({ error: 'Name is required.' });

    const existing = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const user = await prisma.portalUser.create({
      data: {
        email: email.trim().toLowerCase(),
        name: displayName,
        role,
        crewId: role === 'supervisor' ? crewId : null,
        casualWorkerId: worker ? worker.id : null,
        passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
        mustChangePassword: true, // the creator chose it: one-time, changed at first sign-in
        subcontractorName: req.user.subcontractorName,
        createdById: req.user.id
      },
      select: PUBLIC_FIELDS
    });
    res.locals.audit = { entityId: user.id };
    res.status(201).json({ user });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to create user:', err);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// Update an account: name, role, worker link, active flag, password — or move
// a supervisor to another crew (moveToCrewId), which moves their worker record
// to that crew's rotation and makes them its supervisor. HR may only change
// the roles it can create (not HR or System Admin accounts).
router.patch('/users/:id', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, role, active, password, casualWorkerId, moveToCrewId, effectiveFrom } = req.body || {};

  try {
    const target = await prisma.portalUser.findFirst({ where: { id, subcontractorName: req.user.subcontractorName } });
    if (!target) return res.status(404).json({ error: 'Account not found.' });

    const allowed = CAN_CREATE[req.user.role] || [];
    if (!allowed.includes(target.role)) return res.status(403).json({ error: 'You cannot change this account.' });
    if (role !== undefined && (!ROLES.includes(role) || !allowed.includes(role))) {
      return res.status(403).json({ error: 'You cannot assign that role.' });
    }
    if (active === false && target.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });

    // Moving a supervisor: their worker record joins the new crew's rotation,
    // and they stay supervisor of it (the UI has already asked HR to confirm).
    if (moveToCrewId !== undefined) {
      if (target.role !== 'supervisor' || !target.casualWorkerId) return res.status(400).json({ error: 'Only a supervisor can be moved to another crew.' });
      await setWorkerSchedule({
        workerId: target.casualWorkerId,
        type: 'crew',
        crewId: moveToCrewId,
        effectiveFrom: /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom || '') ? effectiveFrom : todayEat(),
        note: 'Moved with their supervisor account',
        userId: req.user.id,
        subcontractorName: req.user.subcontractorName,
        supervisorAction: 'keep'
      });
      return res.json({ user: await prisma.portalUser.findUnique({ where: { id }, select: PUBLIC_FIELDS }) });
    }

    const data = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (role !== undefined) data.role = role;
    if (typeof active === 'boolean') data.active = active;
    if (password !== undefined) {
      const weak = passwordProblem(password);
      if (weak) return res.status(400).json({ error: weak });
      data.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      // A password chosen for someone else is one-time; resetting your own isn't.
      data.mustChangePassword = target.id !== req.user.id;
    }

    // The worker link and (for supervisors) the crew are checked together
    // whenever the role, the link, or re-enabling could change them.
    const finalRole = data.role ?? target.role;
    const finalWorkerId = casualWorkerId !== undefined ? (casualWorkerId || null) : target.casualWorkerId;
    const reEnabling = data.active === true && !target.active;

    // An account whose worker left the BioStar group stays disabled.
    if (reEnabling && finalWorkerId) {
      const worker = await prisma.casualWorker.findUnique({ where: { id: finalWorkerId } });
      if (worker && worker.status !== 'active') {
        return res.status(400).json({ error: `${worker.name}'s worker record is inactive (not in the BioStar casuals group), so this account can't be re-enabled.` });
      }
    }
    // A supervisor re-enabled after a move leads whatever crew they rotate with now.
    if (role !== undefined || casualWorkerId !== undefined || (reEnabling && finalRole === 'supervisor')) {
      const { worker, crewId } = await resolveWorkerLink({
        casualWorkerId: finalWorkerId, role: finalRole, subcontractorName: req.user.subcontractorName, accountId: target.id
      });
      data.casualWorkerId = worker ? worker.id : null;
      data.crewId = finalRole === 'supervisor' ? crewId : null;
    }

    const user = await prisma.portalUser.update({ where: { id }, data, select: PUBLIC_FIELDS });
    const changed = ['name', 'role', 'active', 'casualWorkerId', 'crewId'].filter((k) => k in data && data[k] !== target[k]);
    res.locals.audit = { details: { before: Object.fromEntries(changed.map((k) => [k, target[k]])), after: Object.fromEntries(changed.map((k) => [k, data[k]])) } };
    res.json({ user });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to update user:', err);
    res.status(500).json({ error: 'Could not update the account.' });
  }
});

module.exports = router;
