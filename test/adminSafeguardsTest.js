// System Admin protections and generated temporary passwords — pure, no
// database.
//   node test/adminSafeguardsTest.js

const path = require('path');
require.cache[path.resolve(__dirname, '../prismaClient.js')] = { loaded: true, exports: {} };

const { removesLastAdmin } = require('../services/adminSafeguards');
const { generateTemporaryPassword, passwordProblem, TEMP_LENGTH } = require('../services/passwordPolicy');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

const admin = { role: 'sysadmin', active: true };
check('last admin: disabling refused', removesLastAdmin(admin, { active: false }, 0));
check('last admin: demoting refused', removesLastAdmin(admin, { role: 'hr' }, 0));
check('last admin: other changes fine', !removesLastAdmin(admin, { role: 'sysadmin' }, 0) && !removesLastAdmin(admin, {}, 0));
check('with another active admin, disabling is fine', !removesLastAdmin(admin, { active: false }, 1));
check('non-admin accounts unaffected', !removesLastAdmin({ role: 'hr', active: true }, { active: false }, 0));
check('an already-disabled admin can be changed', !removesLastAdmin({ role: 'sysadmin', active: false }, { role: 'hr' }, 0));

const samples = Array.from({ length: 2000 }, generateTemporaryPassword);
check(`generated passwords are ${TEMP_LENGTH} characters`, samples.every((p) => p.length === TEMP_LENGTH));
check('generated passwords always meet the password rules', samples.every((p) => passwordProblem(p) === null));
check('no look-alike characters (0 O 1 l I)', samples.every((p) => !/[0O1lI]/.test(p)));
check('they differ every time', new Set(samples).size === samples.length);

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
