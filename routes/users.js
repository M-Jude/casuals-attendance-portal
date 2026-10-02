const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');
const { requireRole, ROLES, ROLE_LABELS, CAN_CREATE } = require('../middleware/requireRole');
const { resolveWorkerLink } = require('../services/accountLink');
const { setWorkerSchedule } = require('../services/workerSchedule');
const { todayEat } = require('../services/recompute');

const { generateTemporaryPassword } = require('../services/passwordPolicy');
const { sendAccountEmail } = require('../services/notify');
const { removesLastAdmin, otherActiveAdminCount, tellAdmins } = require('../services/adminSafeguards');

const router = express.Router();
const SALT_ROUNDS = 12;

const PUBLIC_FIELDS = {
  id: true, email: true, name: true, role: true, crewId: true, active: true, createdAt: true, casualWorkerId: true, mustChangePassword: true, mfaEnabledAt: true, mfaMethod: true,
  crew: { select: { id: true, name: true } },
  worker: { select: { id: true, name: true, biostarUserId: true, status: true } }
};

router.get('/users', authenticate, requireRole('sysadmin', 'hr', 'auditor'), async (req, res) => {
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
// The password is generated here, never chosen by the person creating the
// account: it's emailed to the new user and must be replaced at first
// sign-in. Only if that email fails is it returned (once) so it can be
// passed on another way.
router.post('/users', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const { email, name, role, casualWorkerId } = req.body || {};
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  if (!(CAN_CREATE[req.user.role] || []).includes(role)) return res.status(403).json({ error: 'You cannot create an account with that role.' });
  const password = generateTemporaryPassword();

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
        mustChangePassword: true, // generated: one-time, replaced at first sign-in
        subcontractorName: req.user.subcontractorName,
        createdById: req.user.id
      },
      select: PUBLIC_FIELDS
    });
    // Email them the sign-in details; the account stands either way.
    const mail = await sendAccountEmail({ kind: 'created', email: user.email, name: user.name, password });
    res.locals.audit = {
      entityId: user.id,
      details: { welcomeEmail: mail.sent ? 'sent' : `not sent: ${mail.error}`, ...(mail.sent ? {} : { temporaryPasswordShownToCreator: true }) }
    };
    if (role === 'sysadmin') {
      await tellAdmins(req.user.subcontractorName, {
        title: `New System Admin: ${user.name} <${user.email}>`,
        body: `${req.user.name || req.user.email} created a System Admin account for ${user.name} <${user.email}>.\n\nIf this wasn't expected, disable the account in Users and investigate.`
      });
    }
    res.status(201).json({ user, emailed: mail.sent, emailError: mail.error || null, ...(mail.sent ? {} : { temporaryPassword: password }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    // Two identical requests at once (a double click): the second hits the
    // unique email rather than the check above.
    if (err.code === 'P2002') return res.status(409).json({ error: 'An account with that email already exists.' });
    console.error('Failed to create user:', err);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// Update an account: name, role, worker link, active flag, a new generated
// temporary password (resetPassword: true) — or move a supervisor to
// another crew (moveToCrewId), which moves their worker record to that
// crew's rotation and makes them its supervisor. HR may only change the
// roles it can create (not HR, Auditor or System Admin accounts).
router.patch('/users/:id', authenticate, requireRole('sysadmin', 'hr'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, role, active, resetPassword, resetTwoStep, casualWorkerId, moveToCrewId, effectiveFrom } = req.body || {};

  try {
    const target = await prisma.portalUser.findFirst({ where: { id, subcontractorName: req.user.subcontractorName } });
    if (!target) return res.status(404).json({ error: 'Account not found.' });

    const allowed = CAN_CREATE[req.user.role] || [];
    if (!allowed.includes(target.role)) return res.status(403).json({ error: 'You cannot change this account.' });
    if (role !== undefined && (!ROLES.includes(role) || !allowed.includes(role))) {
      return res.status(403).json({ error: 'You cannot assign that role.' });
    }
    if (active === false && target.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
    if (removesLastAdmin(target, { role, active }, await otherActiveAdminCount(target))) {
      return res.status(409).json({ error: `${target.name || target.email} is the only active System Admin, so they can't be disabled or given another role. Make someone else a System Admin first.` });
    }

    // Moving a supervisor: their worker record joins the new crew's rotation,
    // and they stay supervisor of it (the UI has already asked HR to confirm).
    if (moveToCrewId !== undefined) {
      if (target.role !== 'supervisor' || !target.casualWorkerId) return res.status(400).json({ error: 'Only a supervisor can be moved to another crew.' });
      const recalculated = await setWorkerSchedule({
        workerId: target.casualWorkerId,
        type: 'crew',
        crewId: moveToCrewId,
        effectiveFrom: /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom || '') ? effectiveFrom : todayEat(),
        note: 'Moved with their supervisor account',
        userId: req.user.id,
        subcontractorName: req.user.subcontractorName,
        supervisorAction: 'keep'
      });
      return res.json({ user: await prisma.portalUser.findUnique({ where: { id }, select: PUBLIC_FIELDS }), recalculated });
    }

    const data = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (role !== undefined) data.role = role;
    if (typeof active === 'boolean') data.active = active;
    // A new generated one-time password, emailed to them below.
    const password = resetPassword === true ? generateTemporaryPassword() : null;
    if (password) {
      data.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      data.mustChangePassword = true;
    }
    // A lost authenticator: another System Admin clears it, and the account
    // sets a new one up at its next sign-in. (Not your own — that would let a
    // stolen session remove the second step.)
    const clearTwoStep = () => Object.assign(data, {
      mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null, mfaMethod: null,
      mfaEmailCodeHash: null, mfaEmailCodeExpiresAt: null, mfaEmailCodeSentAt: null, mfaEmailCodeAttempts: 0
    });
    if (resetTwoStep === true) {
      if (req.user.role !== 'sysadmin' || target.role !== 'sysadmin') return res.status(403).json({ error: 'Only a System Admin can reset another System Admin’s two-step sign-in.' });
      if (target.id === req.user.id) return res.status(400).json({ error: 'Ask another System Admin to reset your two-step sign-in.' });
      clearTwoStep();
    }
    // Leaving the System Admin role drops their authenticator; if they're
    // made one again, they set up a fresh one.
    if (role !== undefined && role !== 'sysadmin' && target.role === 'sysadmin') clearTwoStep();

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
    const details = { before: Object.fromEntries(changed.map((k) => [k, target[k]])), after: Object.fromEntries(changed.map((k) => [k, data[k]])) };

    // The new temporary password is emailed to them; only if that fails is
    // it returned, once, to pass on another way.
    let mail = null;
    if (password) {
      mail = await sendAccountEmail({ kind: 'reset', email: user.email, name: user.name, password });
      details.resetEmail = mail.sent ? 'sent' : `not sent: ${mail.error}`;
      if (!mail.sent) details.temporaryPasswordShownToAdmin = true;
    }
    res.locals.audit = { details };

    // Anything touching who is a System Admin, or a System Admin's access,
    // is told to all of them.
    const who = `${user.name || user.email} <${user.email}>`;
    const by = req.user.name || req.user.email;
    const adminEvents = [];
    if ('role' in data && data.role !== target.role && (data.role === 'sysadmin' || target.role === 'sysadmin')) {
      adminEvents.push(data.role === 'sysadmin' ? `${by} made ${who} a System Admin.` : `${by} removed System Admin from ${who} (now ${ROLE_LABELS[data.role]}).`);
    }
    if (target.role === 'sysadmin' && 'active' in data && data.active !== target.active) {
      adminEvents.push(`${by} ${data.active ? 're-enabled' : 'disabled'} System Admin ${who}.`);
    }
    if (target.role === 'sysadmin' && password) adminEvents.push(`${by} reset the password of System Admin ${who}.`);
    if (resetTwoStep === true) adminEvents.push(`${by} reset the two-step sign-in of System Admin ${who}. They'll set up a new authenticator at their next sign-in.`);
    if (adminEvents.length) {
      await tellAdmins(req.user.subcontractorName, {
        title: `System Admin change: ${user.name || user.email}`,
        body: `${adminEvents.join('\n')}\n\nIf this wasn't expected, check Users and the audit log.`
      });
    }

    res.json({ user, ...(mail ? { emailed: mail.sent, emailError: mail.error || null, ...(mail.sent ? {} : { temporaryPassword: password }) } : {}) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Failed to update user:', err);
    res.status(500).json({ error: 'Could not update the account.' });
  }
});

module.exports = router;
