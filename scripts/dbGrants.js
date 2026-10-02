// Least-privilege database access for the running portal.
//
// The portal connects (DATABASE_URL) as its own MySQL user — not root — that
// can read and change ordinary records but can only READ and ADD audit-log
// entries, never edit or delete them. MySQL can't exclude one table from a
// database-wide grant, so the app user gets its rights table by table; this
// script (re)applies them, so tables added by later migrations are covered.
// The deploy runs it after every migration.
//
// It connects as the migration user (MIGRATE_DATABASE_URL: all privileges
// on the portal database, WITH GRANT OPTION) and grants to the user named in
// DATABASE_URL, at each host in APP_DB_HOSTS (default "localhost,127.0.0.1";
// hosts where that user doesn't exist are skipped). Then it connects as the
// app user and checks that editing or deleting audit entries is refused
// (with statements that match no rows, so nothing changes even if allowed).
//
//   node scripts/dbGrants.js            # show what it would do
//   node scripts/dbGrants.js --apply    # do it, then verify
//   node scripts/dbGrants.js --verify   # only verify

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

// Tables the app user may only read and add to.
const APPEND_ONLY = ['AuditLog'];
// Prisma's own bookkeeping — the app never touches it.
const SKIP = ['_prisma_migrations'];

const q = (name) => `\`${String(name).replace(/`/g, '``')}\``;
const s = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function parseDbUrl(url, label) {
  if (!url) throw new Error(`${label} is not set in .env.`);
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), database: decodeURIComponent(u.pathname.slice(1)) };
}

// The GRANT / REVOKE statements for one app user@host — pure, so it's tested.
function planGrants({ database, tables, user, host }) {
  const grantee = `${s(user)}@${s(host)}`;
  // MySQL adds privileges up across levels, so a database-wide grant (e.g.
  // UPDATE on casuals_portal.*) would override the table-level limits
  // below. Clear any first; "no such grant" is fine.
  const statements = [
    { sql: `REVOKE ALL PRIVILEGES ON ${q(database)}.* FROM ${grantee}`, optional: true },
    { sql: `REVOKE GRANT OPTION ON ${q(database)}.* FROM ${grantee}`, optional: true }
  ];
  // Table names compared without case: MySQL on Windows (the default
  // lower_case_table_names=1) stores AuditLog as `auditlog`.
  const named = (list, table) => list.some((t) => t.toLowerCase() === table.toLowerCase());
  for (const table of tables) {
    if (named(SKIP, table)) continue;
    const target = `${q(database)}.${q(table)}`;
    if (named(APPEND_ONLY, table)) {
      statements.push({ sql: `GRANT SELECT, INSERT ON ${target} TO ${grantee}` });
      // In case it was ever granted more; "no such grant" is fine.
      statements.push({ sql: `REVOKE UPDATE, DELETE ON ${target} FROM ${grantee}`, optional: true });
    } else {
      statements.push({ sql: `GRANT SELECT, INSERT, UPDATE, DELETE ON ${target} TO ${grantee}` });
    }
  }
  return statements;
}

async function apply({ dryRun }) {
  const app = parseDbUrl(process.env.DATABASE_URL, 'DATABASE_URL');
  const migrate = parseDbUrl(process.env.MIGRATE_DATABASE_URL, 'MIGRATE_DATABASE_URL');
  if (app.user === migrate.user) throw new Error('DATABASE_URL and MIGRATE_DATABASE_URL use the same MySQL user — the portal must use its own, limited user.');
  if (app.user === 'root') throw new Error('DATABASE_URL still uses root. Point it at the portal’s own MySQL user (see deploy/mysql/setup-users.sql).');
  const hosts = (process.env.APP_DB_HOSTS || 'localhost,127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);

  const db = new PrismaClient({ datasources: { db: { url: process.env.MIGRATE_DATABASE_URL } } });
  try {
    const rows = await db.$queryRawUnsafe('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = \'BASE TABLE\'', migrate.database);
    const tables = rows.map((r) => r.name).sort();
    console.log(`Database ${migrate.database}: ${tables.length} tables. App user: ${app.user} @ ${hosts.join(', ')}.`);

    let granted = 0;
    for (const host of hosts) {
      const plan = planGrants({ database: migrate.database, tables, user: app.user, host });
      if (dryRun) {
        plan.forEach((st) => console.log(`  ${st.sql};`));
        continue;
      }
      try {
        for (const st of plan) {
          try {
            await db.$executeRawUnsafe(st.sql);
          } catch (err) {
            if (!st.optional) throw err;
          }
        }
        granted++;
        console.log(`  ${app.user}@${host}: read/write on ${tables.length - SKIP.length - APPEND_ONLY.length} tables, read + add only on ${APPEND_ONLY.join(', ')}.`);
      } catch (err) {
        // The user doesn't exist at this host (MySQL 1133 / 1410) — skip it.
        if (/1133|1410|can't find any matching row|not allowed to create a user/i.test(err.message)) {
          console.log(`  ${app.user}@${host}: no such MySQL user — skipped.`);
        } else {
          throw err;
        }
      }
    }
    if (!dryRun && granted === 0) throw new Error(`No MySQL user ${app.user} found at ${hosts.join(' or ')}. Create it first (deploy/mysql/setup-users.sql).`);
    if (dryRun) console.log('\nDry run — nothing changed. Add --apply to do it.');
  } finally {
    await db.$disconnect();
  }
}

// Connects as the app user: ordinary reads work, audit edits/deletes don't.
async function verify() {
  const app = parseDbUrl(process.env.DATABASE_URL, 'DATABASE_URL');
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const results = [];
  const expectDenied = async (label, sql) => {
    try {
      await db.$executeRawUnsafe(sql);
      results.push([label, false, 'was allowed']);
    } catch (err) {
      const denied = /denied/i.test(err.message);
      results.push([label, denied, denied ? 'refused' : err.message.split('\n').pop()]);
    }
  };
  try {
    await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM `AuditLog`');
    results.push(['read the audit log', true, 'allowed']);
    await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM `PortalUser`');
    results.push(['read ordinary records', true, 'allowed']);
    // WHERE 1 = 0: matches nothing, so even if it were allowed nothing changes.
    await expectDenied('edit audit entries', 'UPDATE `AuditLog` SET `summary` = `summary` WHERE 1 = 0');
    await expectDenied('delete audit entries', 'DELETE FROM `AuditLog` WHERE 1 = 0');
    await expectDenied('change the table structure', 'ALTER TABLE `AuditLog` COMMENT = \'\'');
  } catch (err) {
    results.push(['connect and read as the app user', false, err.message.split('\n').pop()]);
  }

  console.log(`\nChecks as ${app.user}:`);
  for (const [label, ok, note] of results) console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label} — ${note}`);
  const failed = results.filter(([, ok]) => !ok).length;

  if (failed) {
    // Any user may see its own grants: show where the extra rights come from.
    try {
      const [{ who }] = await db.$queryRawUnsafe('SELECT CURRENT_USER() AS who');
      const grants = await db.$queryRawUnsafe('SHOW GRANTS');
      console.log(`\nMySQL matched this login to ${who}, which has:`);
      for (const row of grants) console.log(`  ${Object.values(row)[0]}`);
      console.log('\nThe audit log can only be protected if none of these give UPDATE or DELETE on the whole server');
      console.log('(ON *.*) or the whole database. Remove those as root, e.g.');
      console.log(`  REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${who};`);
      console.log('then run this script again with --apply (it puts back the table-by-table permissions).');
      console.log('If the login matched a different account than expected (e.g. one with host %), remove or fix that account.');
    } catch (err) {
      console.log(`\n(Couldn’t list this login’s grants: ${err.message.split('\n').pop()})`);
    }
  }
  await db.$disconnect();
  if (failed) throw new Error(`${failed} check${failed === 1 ? '' : 's'} failed — the audit log is not protected as intended.`);
  console.log('The portal’s database user can read and add audit entries but cannot change or delete them.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--verify')) return verify();
  if (args.includes('--apply')) {
    await apply({ dryRun: false });
    return verify();
  }
  return apply({ dryRun: true });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { planGrants, APPEND_ONLY };
