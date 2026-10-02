// Two-step sign-in for System Admins: the TOTP maths (RFC 6238 vector),
// and the whole sign-in flow through the real auth routes and middleware
// against an in-memory account table.
//   node test/twoStepTest.js

process.env.JWT_SECRET = 'test-secret';
process.env.SMTP_HOST = 'smtp.example.com';

const path = require('path');

// Emails are captured, not sent.
const mails = [];
require.cache[require.resolve('nodemailer')] = {
  loaded: true,
  exports: { createTransport: () => ({ sendMail: async (m) => { mails.push(m); return { response: '250' }; } }) }
};
const lastCode = () => (mails[mails.length - 1]?.text.match(/sign-in code is: (\d{6})/) || [])[1];
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const users = new Map();
const matches = (u, where) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((w) => matches(u, w));
  if (v && typeof v === 'object' && 'lt' in v) return u[k] !== null && u[k] < v.lt;
  return u[k] === v;
});
require.cache[path.resolve(__dirname, '../prismaClient.js')] = {
  loaded: true,
  exports: {
    portalUser: {
      findUnique: async ({ where }) => (where.id !== undefined ? users.get(where.id) : [...users.values()].find((u) => u.email === where.email)) || null,
      update: async ({ where, data }) => {
        const u = users.get(where.id);
        for (const [k, v] of Object.entries(data)) u[k] = v && typeof v === 'object' && 'increment' in v ? (u[k] || 0) + v.increment : v;
        return u;
      },
      updateMany: async ({ where, data }) => {
        const hits = [...users.values()].filter((u) => matches(u, where));
        hits.forEach((u) => Object.assign(u, data));
        return { count: hits.length };
      }
    },
    crew: { findUnique: async () => null },
    casualWorker: { findUnique: async () => null }
  }
};

const express = require('express');
const { codeAt, verifyCode, base32Encode, currentStep } = require('../services/totp');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

// RFC 6238 appendix B, SHA-1: secret "12345678901234567890", T=59s -> 94287082.
const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
check('RFC 6238 test vector (59 s)', codeAt(rfcSecret, 1) === '287082');
check('RFC 6238 test vector (1111111109 s)', codeAt(rfcSecret, Math.floor(1111111109 / 30)) === '081804');
const now = Date.now();
const step = currentStep(now);
check('accepts the current code', verifyCode(rfcSecret, codeAt(rfcSecret, step), { now }) === step);
check('accepts the previous code (clock drift)', verifyCode(rfcSecret, codeAt(rfcSecret, step - 1), { now }) === step - 1);
check('refuses an old code', verifyCode(rfcSecret, codeAt(rfcSecret, step - 3), { now }) === null);
check('refuses a reused code', verifyCode(rfcSecret, codeAt(rfcSecret, step), { now, lastStep: step }) === null);
check('refuses junk', verifyCode(rfcSecret, '12ab56', { now }) === null && verifyCode(rfcSecret, '', { now }) === null);

async function main() {
  users.set(1, { id: 1, email: 'ict@caa.co.ug', name: 'ICT', role: 'sysadmin', active: true, subcontractorName: 'A', passwordHash: await bcrypt.hash('Admin#Pass1', 4), mustChangePassword: false, mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null });
  users.set(2, { id: 2, email: 'hr@caa.co.ug', name: 'HR', role: 'hr', active: true, subcontractorName: 'A', passwordHash: await bcrypt.hash('Hr#Pass123', 4), mustChangePassword: false, mfaEnabledAt: null });

  const authenticate = require('../middleware/authenticate');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.get('/api/thing', authenticate, (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const get = async (token) => (await fetch(`${base}/api/thing`, { headers: { Authorization: `Bearer ${token}` } })).status;

  try {
    const hr = await post('/api/auth/login', { email: 'hr@caa.co.ug', password: 'Hr#Pass123' });
    check('other roles sign in with a password only', hr.status === 200 && hr.body.token && await get(hr.body.token) === 200);

    const first = await post('/api/auth/login', { email: 'ict@caa.co.ug', password: 'Admin#Pass1' });
    check('System Admin: password alone gives no session, but a setup pass', first.status === 200 && !first.body.token && first.body.mfaSetupRequired && first.body.mfaToken);
    check('the pass is not a session', await get(first.body.mfaToken) === 401);

    const setup = await post('/api/auth/mfa/setup', { mfaToken: first.body.mfaToken });
    check('setup gives a QR code and key', setup.status === 200 && setup.body.qrDataUrl.startsWith('data:image/png') && setup.body.otpauthUri.startsWith('otpauth://totp/'));
    const secret = setup.body.secret.replace(/\s/g, '');

    const wrong = await post('/api/auth/mfa/enable', { mfaToken: first.body.mfaToken, code: '000000' === codeAt(secret, currentStep()) ? '111111' : '000000' });
    check('setup refuses a wrong code', wrong.status === 400 && !users.get(1).mfaEnabledAt);
    const enabled = await post('/api/auth/mfa/enable', { mfaToken: first.body.mfaToken, code: codeAt(secret, currentStep()) });
    check('setup with the right code signs in', enabled.status === 200 && enabled.body.token && users.get(1).mfaEnabledAt);
    check('that session works', await get(enabled.body.token) === 200);

    const old = jwt.sign({ userId: 1, subcontractorName: 'A' }, 'test-secret', { expiresIn: '8h' });
    check('a System Admin session without the code is refused', await get(old) === 401);

    const second = await post('/api/auth/login', { email: 'ict@caa.co.ug', password: 'Admin#Pass1' });
    check('next time: asked for the code', second.body.mfaRequired && second.body.mfaToken);
    const reused = await post('/api/auth/mfa/verify', { mfaToken: second.body.mfaToken, code: codeAt(secret, users.get(1).mfaLastStep) });
    check('the code used for setup can’t be used again', reused.status === 400);
    users.get(1).mfaLastStep -= 2; // as if the setup code was a minute ago
    const ok = await post('/api/auth/mfa/verify', { mfaToken: second.body.mfaToken, code: codeAt(secret, currentStep()) });
    check('the current code signs in', ok.status === 200 && ok.body.token && await get(ok.body.token) === 200);
    const replay = await post('/api/auth/mfa/verify', { mfaToken: second.body.mfaToken, code: codeAt(secret, currentStep()) });
    check('…and can’t be replayed', replay.status === 400);

    Object.assign(users.get(1), { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null });
    check('after a reset, existing sessions end', await get(ok.body.token) === 401);
    const third = await post('/api/auth/login', { email: 'ict@caa.co.ug', password: 'Admin#Pass1' });
    check('…and the next sign-in sets up again', third.body.mfaSetupRequired === true);

    const forged = jwt.sign({ userId: 1, purpose: 'mfa' }, 'wrong-secret');
    check('a forged pass is refused', (await post('/api/auth/mfa/verify', { mfaToken: forged, code: '123456' })).status === 401);

    // ---------------------------------------------------------- email codes
    users.set(3, { id: 3, email: 'ops@caa.co.ug', name: 'Ops', role: 'sysadmin', active: true, subcontractorName: 'A', passwordHash: await bcrypt.hash('Ops#Pass12', 4), mustChangePassword: false, mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null, mfaMethod: null, mfaEmailCodeHash: null, mfaEmailCodeExpiresAt: null, mfaEmailCodeSentAt: null, mfaEmailCodeAttempts: 0 });
    const ops = users.get(3);
    const login3 = await post('/api/auth/login', { email: 'ops@caa.co.ug', password: 'Ops#Pass12' });
    check('email setup: offered at first sign-in, with a masked address', login3.body.mfaSetupRequired && login3.body.emailHint === 'o•••@caa.co.ug');
    const sent = await post('/api/auth/mfa/email/send', { mfaToken: login3.body.mfaToken });
    check('email setup: a code is emailed to the account', sent.status === 200 && mails.length === 1 && mails[0].to === 'ops@caa.co.ug' && /^\d{6}$/.test(lastCode()));
    check('only a hash of the code is stored', ops.mfaEmailCodeHash && ops.mfaEmailCodeHash !== lastCode() && ops.mfaEmailCodeHash.length === 64);
    const tooSoon = await post('/api/auth/mfa/email/send', { mfaToken: login3.body.mfaToken });
    check('resend within a minute is refused, with the wait', tooSoon.status === 429 && tooSoon.body.wait > 0 && mails.length === 1);
    const setupOk = await post('/api/auth/mfa/enable', { mfaToken: login3.body.mfaToken, code: lastCode(), method: 'email' });
    check('email setup: the emailed code confirms it and signs in', setupOk.status === 200 && setupOk.body.token && ops.mfaMethod === 'email' && ops.mfaEnabledAt);
    check('…and that session works', await get(setupOk.body.token) === 200);

    ops.mfaEmailCodeSentAt = new Date(Date.now() - 120000); // a while later
    const login4 = await post('/api/auth/login', { email: 'ops@caa.co.ug', password: 'Ops#Pass12' });
    check('email user: a code is sent automatically at sign-in', login4.body.mfaRequired && login4.body.method === 'email' && login4.body.emailSent === true && mails.length === 2);
    const code4 = lastCode();
    const bad = await post('/api/auth/mfa/verify', { mfaToken: login4.body.mfaToken, code: code4 === '000000' ? '111111' : '000000' });
    check('a wrong emailed code is refused and counted', bad.status === 400 && ops.mfaEmailCodeAttempts === 1);
    const good = await post('/api/auth/mfa/verify', { mfaToken: login4.body.mfaToken, code: code4 });
    check('the right emailed code signs in', good.status === 200 && good.body.token);
    const again = await post('/api/auth/mfa/verify', { mfaToken: login4.body.mfaToken, code: code4 });
    check('…and can’t be used twice', again.status === 400);

    ops.mfaEmailCodeSentAt = new Date(Date.now() - 120000);
    await post('/api/auth/mfa/email/send', { mfaToken: login4.body.mfaToken });
    const code5 = lastCode();
    ops.mfaEmailCodeExpiresAt = new Date(Date.now() - 1000);
    check('an expired code is refused', (await post('/api/auth/mfa/verify', { mfaToken: login4.body.mfaToken, code: code5 })).status === 400);

    ops.mfaEmailCodeSentAt = new Date(Date.now() - 120000);
    await post('/api/auth/mfa/email/send', { mfaToken: login4.body.mfaToken });
    const code6 = lastCode();
    ops.mfaEmailCodeAttempts = 5;
    const locked = await post('/api/auth/mfa/verify', { mfaToken: login4.body.mfaToken, code: code6 });
    check('after 5 wrong tries even the right code is refused', locked.status === 400 && /Send a new one/.test(locked.body.error));

    // An authenticator-app user asking for an email instead.
    Object.assign(users.get(1), { mfaMethod: 'app', mfaSecret: secret, mfaEnabledAt: new Date(), mfaLastStep: null, mfaEmailCodeSentAt: null, mfaEmailCodeAttempts: 0 });
    const login5 = await post('/api/auth/login', { email: 'ict@caa.co.ug', password: 'Admin#Pass1' });
    check('app user: no email sent unless asked', login5.body.method === 'app' && login5.body.emailSent === undefined);
    const before = mails.length;
    const ask = await post('/api/auth/mfa/email/send', { mfaToken: login5.body.mfaToken });
    check('app user: can ask for an emailed code instead', ask.status === 200 && mails.length === before + 1 && mails[mails.length - 1].to === 'ict@caa.co.ug');
    const viaEmail = await post('/api/auth/mfa/verify', { mfaToken: login5.body.mfaToken, code: lastCode(), channel: 'email' });
    check('app user: the emailed code signs them in', viaEmail.status === 200 && viaEmail.body.token);

    const { sanitize } = require('../services/audit');
    check('codes are masked in the audit log', sanitize({ mfaToken: 'x', code: '123456' }).code === '••••••');
  } finally {
    server.close();
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
