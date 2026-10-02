// Password strength rules — pure, no database — and a check that the
// browser's copy (src/passwordPolicy.js) gives the same verdicts as the
// server's (services/passwordPolicy.js).
//   node test/passwordPolicyTest.js

const fs = require('fs');
const path = require('path');
const { passwordProblem, unmetRules } = require('../services/passwordPolicy');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

const ids = (p) => unmetRules(p).map((r) => r.id).join(',');

check('strong password accepted', passwordProblem('Kampala#2026') === null);
check('special character can be any symbol', passwordProblem('Abcdefg_') === null && passwordProblem('Abcdefg€') === null);
check('too short', ids('Ab#1') === 'length');
check('no uppercase', ids('abcdefg#') === 'upper');
check('no lowercase', ids('ABCDEFG#') === 'lower');
check('no special character', ids('Abcdefgh1') === 'special');
check('a space is not a special character', ids('Abc defgh') === 'special');
check('empty fails every rule', ids('') === 'length,upper,lower,special');
check('message lists what is missing', passwordProblem('abcdefgh') === 'Password needs: an uppercase letter (A–Z), a special character (e.g. ! @ # $ % &).');
check('over 72 bytes refused (bcrypt would truncate)', /too long/.test(passwordProblem(`Aa#${'x'.repeat(70)}`)));
check('non-string refused', passwordProblem(undefined) === 'A password is required.');

const SAMPLES = ['', 'Kampala#2026', 'Ab#1', 'abcdefg#', 'ABCDEFG#', 'Abcdefgh1', 'Abc defgh', 'Abcdefg_', 'Abcdefg€', 'password', 'P@ssw0rd'];

async function main() {
  // Import the browser module as-is (it's an ES module in a CommonJS package).
  const source = fs.readFileSync(path.join(__dirname, '../src/passwordPolicy.js'), 'utf8');
  const browser = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const p of SAMPLES) {
    const server = ids(p);
    const client = browser.unmetRules(p).map((r) => r.id).join(',');
    check(`browser and server agree on ${JSON.stringify(p)}`, server === client && browser.isStrongPassword(p) === (passwordProblem(p) === null));
  }

  let failed = 0;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
