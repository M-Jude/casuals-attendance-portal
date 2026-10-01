// Role gate for routes. Use after `authenticate`:
//   router.post('/users', authenticate, requireRole('sysadmin', 'hr'), ...)
//
// What each role can see and do:
//   sysadmin        everything, including system settings and any account
//   hr              all records; creates supervisor / finance / admin
//                   assistant accounts; approves permanent-Day months and
//                   escalated shifts; reviews worker pattern changes
//   admin_assistant all records; approves escalated shifts; manages
//                   schedules and exceptions
//   finance         approved records only (read-only)
//   supervisor      their own crew's records; approves their crew's shifts;
//                   records exceptions for their crew's workers

const ROLES = ['sysadmin', 'hr', 'admin_assistant', 'finance', 'supervisor'];

const ROLE_LABELS = {
  sysadmin: 'System Admin',
  hr: 'HR',
  admin_assistant: 'Admin Assistant',
  finance: 'Finance',
  supervisor: 'Shift Supervisor'
};

// Which roles each role may create accounts for.
const CAN_CREATE = {
  sysadmin: ROLES,
  hr: ['supervisor', 'finance', 'admin_assistant']
};

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this.' });
    }
    next();
  };
}

// Extra conditions on DailyAttendanceSummary for what this user may see.
function summaryVisibility(user) {
  const where = { worker: { subcontractorName: user.subcontractorName } };
  if (user.role === 'finance') where.approvedAt = { not: null };
  if (user.role === 'supervisor') where.approvalCrewId = user.crewId ?? -1;
  return where;
}

module.exports = { requireRole, summaryVisibility, ROLES, ROLE_LABELS, CAN_CREATE };
