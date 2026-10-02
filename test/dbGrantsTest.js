// scripts/dbGrants.js: the permissions planned for the portal's database
// user — pure, no database.
//   node test/dbGrantsTest.js

const { planGrants } = require('../scripts/dbGrants');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

const plan = planGrants({
  database: 'casuals_portal',
  tables: ['AuditLog', 'PortalUser', 'DailyAttendanceSummary', '_prisma_migrations'],
  user: 'casuals_app',
  host: 'localhost'
});
const sql = plan.map((p) => p.sql);

check('ordinary tables: read and write',
  sql.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON `casuals_portal`.`PortalUser` TO 'casuals_app'@'localhost'"));
check('audit log: read and add only',
  sql.includes("GRANT SELECT, INSERT ON `casuals_portal`.`AuditLog` TO 'casuals_app'@'localhost'"));
check('audit log: never edit or delete (revoked, harmless if never granted)',
  plan.some((p) => p.optional && p.sql === "REVOKE UPDATE, DELETE ON `casuals_portal`.`AuditLog` FROM 'casuals_app'@'localhost'"));
check('no UPDATE or DELETE grant on the audit log', !sql.some((x) => /^GRANT .*(UPDATE|DELETE).*`AuditLog`/.test(x)));
check('Prisma’s migrations table is left alone', !sql.some((x) => x.includes('_prisma_migrations')));
check('nothing granted database-wide (no GRANT … ON `db`.*)', !sql.some((x) => /^GRANT .*`\.\*/.test(x)));
check('any database-wide privileges are cleared first (they would override the audit-log limits)',
  plan[0].optional && plan[0].sql === "REVOKE ALL PRIVILEGES ON `casuals_portal`.* FROM 'casuals_app'@'localhost'"
  && plan[1].sql === "REVOKE GRANT OPTION ON `casuals_portal`.* FROM 'casuals_app'@'localhost'");
// MySQL on Windows stores table names in lowercase — the live server did.
const lower = planGrants({ database: 'casuals_portal', tables: ['auditlog', 'portaluser', '_prisma_migrations'], user: 'casuals_app', host: 'localhost' }).map((p) => p.sql);
check('lowercase table names (Windows MySQL): audit log still read + add only',
  lower.includes("GRANT SELECT, INSERT ON `casuals_portal`.`auditlog` TO 'casuals_app'@'localhost'")
  && lower.includes("REVOKE UPDATE, DELETE ON `casuals_portal`.`auditlog` FROM 'casuals_app'@'localhost'")
  && !lower.some((x) => /^GRANT .*(UPDATE|DELETE).*`auditlog`/.test(x)));
check('names are quoted safely', planGrants({ database: 'd', tables: ['a`b'], user: "o'x", host: 'h' }).find((p) => p.sql.startsWith('GRANT')).sql === "GRANT SELECT, INSERT, UPDATE, DELETE ON `d`.`a``b` TO 'o\\'x'@'h'");

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
