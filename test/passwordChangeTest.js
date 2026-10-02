// One-time passwords: an account whose password someone else chose can only
// change it (or sign out) until it has. Runs the real auth routes and
// middleware against an in-memory stand-in for the database.
//   node test/passwordChangeTest.js

process.env.JWT_SECRET = 'test-secret';

const path = require('path');
const bcrypt = require('bcryptjs');

// In-memory portalUser table, swapped in for the Prisma client.
const users = new Map();
const fakePrisma = {
  portalUser: {
    findUnique: async ({ where }) => (where.id !== undefined ? users.get(where.id) : [...users.values()].find((u) => u.email === where.email)) || null,
    update: async ({ where, data }) => Object.assign(users.get(where.id), data)
  }
};
require.cache[path.resolve(__dirname, '../prismaClient.js')] = { exports: fakePrisma, loaded: true, id: 'prisma' };

const express = require('express');
const authenticate = require('../middleware/authenticate');
const { allowedBeforePasswordChange } = authenticate;

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

check('profile allowed before the change', allowedBeforePasswordChange('/api/auth/me'));
check('change-password allowed', allowedBeforePasswordChange('/api/auth/change-password'));
check('sign-out allowed', allowedBeforePasswordChange('/api/auth/logout/'));
check('query string ignored', allowedBeforePasswordChange('/api/auth/me?x=1'));
check('other API paths blocked', !allowedBeforePasswordChange('/api/users') && !allowedBeforePasswordChange('/api/auth/me/../../users'));

async function main() {
  users.set(1, { id: 1, email: 'new@example.com', name: 'New', role: 'hr', active: true, subcontractorName: 'A', passwordHash: await bcrypt.hash('given-pass-1', 4), mustChangePassword: true });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.get('/api/attendance', authenticate, (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    const login = await call('POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'given-pass-1' } });
    check('the temporary password signs in', login.status === 200 && login.body.token);
    const token = login.body.token;

    const me = await call('GET', '/api/auth/me', { token });
    check('profile says a change is required', me.status === 200 && me.body.user.mustChangePassword === true);

    const blocked = await call('GET', '/api/attendance', { token });
    check('everything else is refused until changed', blocked.status === 403 && blocked.body.code === 'PASSWORD_CHANGE_REQUIRED');

    const wrong = await call('POST', '/api/auth/change-password', { token, body: { currentPassword: 'nope-nope', newPassword: 'my-own-pass' } });
    check('wrong current password is a 400 (not a sign-out 401)', wrong.status === 400);
    check('…and changes nothing', users.get(1).mustChangePassword === true);

    const short = await call('POST', '/api/auth/change-password', { token, body: { currentPassword: 'given-pass-1', newPassword: 'short' } });
    check('too-short new password refused', short.status === 400);

    const same = await call('POST', '/api/auth/change-password', { token, body: { currentPassword: 'given-pass-1', newPassword: 'given-pass-1' } });
    check('reusing the given password refused', same.status === 400);

    const ok = await call('POST', '/api/auth/change-password', { token, body: { currentPassword: 'given-pass-1', newPassword: 'my-own-pass' } });
    check('valid change accepted', ok.status === 200);
    check('flag cleared', users.get(1).mustChangePassword === false);
    check('new password stored hashed', users.get(1).passwordHash !== 'my-own-pass' && await bcrypt.compare('my-own-pass', users.get(1).passwordHash));

    const after = await call('GET', '/api/attendance', { token });
    check('the same session now works', after.status === 200);

    const oldLogin = await call('POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'given-pass-1' } });
    check('the temporary password no longer works', oldLogin.status === 401);
    const newLogin = await call('POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'my-own-pass' } });
    check('the new password signs in', newLogin.status === 200);
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
