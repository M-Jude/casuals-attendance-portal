// Who an account id was — for "approved by" and similar — including
// accounts that have since been deleted ("Jane Okello (account deleted)").
//
// An id is matched to the live account only if that account already existed
// at the time in question; otherwise to the deleted account that held the id
// then. (MySQL before 8.0 can hand a deleted account's id to a new account
// after a restart, and history must not then name the wrong person.)

const prisma = require('../prismaClient');

// Pure: picks the right name. live: Map(id -> {name,email,createdAt});
// gone: Map(id -> [{name,email,accountCreatedAt,deletedAt}]).
function nameAt(id, at, live, gone) {
  if (!id) return '';
  const when = at ? new Date(at).getTime() : null;
  const current = live.get(id);
  if (current && (when === null || new Date(current.createdAt).getTime() <= when)) return current.name || current.email;
  const candidates = (gone.get(id) || []).filter((d) => when === null
    || (new Date(d.accountCreatedAt).getTime() <= when && new Date(d.deletedAt).getTime() >= when));
  const past = candidates[0] || (gone.get(id) || [])[0];
  if (past) return `${past.name || past.email} (account deleted)`;
  return current ? current.name || current.email : 'Unknown account';
}

// Loads what nameAt needs for these ids. Returns (id, at) => name.
async function accountNameResolver(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return () => '';
  const [liveRows, goneRows] = await Promise.all([
    prisma.portalUser.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true, createdAt: true } }),
    prisma.deletedAccount.findMany({ where: { accountId: { in: unique } }, orderBy: { deletedAt: 'desc' } })
  ]);
  const live = new Map(liveRows.map((u) => [u.id, u]));
  const gone = new Map();
  for (const d of goneRows) {
    if (!gone.has(d.accountId)) gone.set(d.accountId, []);
    gone.get(d.accountId).push(d);
  }
  return (id, at) => nameAt(id, at, live, gone);
}

module.exports = { nameAt, accountNameResolver };
