// The sign-in email sent when HR / a System Admin creates an account or
// resets a password. Nodemailer and the database are stubbed: nothing is
// actually sent.
//   node test/accountEmailTest.js

const path = require('path');

const sent = [];
let failNext = null;
require.cache[require.resolve('nodemailer')] = {
  loaded: true,
  exports: {
    createTransport: () => ({
      sendMail: async (msg) => {
        if (failNext) { const e = new Error(failNext); failNext = null; throw e; }
        sent.push(msg);
        return { response: '250 OK' };
      }
    })
  }
};
require.cache[path.resolve(__dirname, '../prismaClient.js')] = { loaded: true, exports: {} };

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

async function main() {
  // Not configured: nothing sent, and the caller is told why.
  delete process.env.SMTP_HOST;
  const origWarn = console.warn;
  console.warn = () => {};
  let { sendAccountEmail } = require('../services/notify');
  const off = await sendAccountEmail({ kind: 'created', email: 'a@b.c', name: 'A', password: 'Temp#Pass1' });
  console.warn = origWarn;
  check('without SMTP settings nothing is sent, with a reason', !off.sent && /not set up/.test(off.error) && sent.length === 0);

  // Configured.
  delete require.cache[require.resolve('../services/notify')];
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'portal@example.com', SMTP_FROM: 'Casuals Portal <portal@example.com>', APP_BASE_URL: 'https://portal.example.com/' });
  ({ sendAccountEmail } = require('../services/notify'));

  const created = await sendAccountEmail({ kind: 'created', email: 'new.user@example.com', name: 'Sam Okello', password: 'Temp#Pass1' });
  const m = sent[0] || {};
  check('new account: reported as sent', created.sent === true);
  check('new account: to the account holder, from SMTP_FROM', m.to === 'new.user@example.com' && m.from === 'Casuals Portal <portal@example.com>');
  check('new account: subject', m.subject === '[Casuals Portal] Your new account');
  check('new account: greets them by name', /^Hello Sam Okello,/.test(m.text));
  check('new account: portal link (no trailing slash)', m.text.includes('https://portal.example.com\n'));
  check('new account: sign-in email and temporary password', m.text.includes('new.user@example.com') && m.text.includes('Temp#Pass1'));
  check('new account: says it is first-sign-in only, with the rules', /first sign-in only/.test(m.text) && /special character/.test(m.text));

  await sendAccountEmail({ kind: 'reset', email: 'x@example.com', name: '', password: 'New#Pass22' });
  const r = sent[1] || {};
  check('reset: its own subject and wording', r.subject === '[Casuals Portal] Your password has been reset' && /has been reset/.test(r.text));
  check('reset: no name gives a plain greeting', /^Hello,/.test(r.text));

  failNext = 'Invalid login: 535-5.7.8 Username and Password not accepted';
  const origError = console.error;
  console.error = () => {};
  const failed = await sendAccountEmail({ kind: 'created', email: 'y@example.com', name: 'Y', password: 'Temp#Pass1' });
  console.error = origError;
  check('a send failure is reported, not thrown', failed.sent === false && /Invalid login/.test(failed.error));

  let failedCount = 0;
  for (const [label, passed] of checks) {
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
    if (!passed) failedCount++;
  }
  console.log(`\n${checks.length - failedCount}/${checks.length} passed`);
  process.exit(failedCount ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
