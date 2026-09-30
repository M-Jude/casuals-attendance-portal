// Unit tests for the audit trail's helpers — pure, no database.
//   node test/auditTest.js

const { describeDevice, sanitize, clientIp, downloadStamp } = require('../services/audit');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; SM-A515F Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Mobile Safari/537.36',
  androidReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  tablet: 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
};

check('Android phone: browser, OS, model, type', describeDevice(UA.android) === 'Chrome 128 on Android 14 (SM-A515F) · Phone');
check('reduced Android UA has no fake model "K"', describeDevice(UA.androidReduced) === 'Chrome 128 on Android 10 · Phone');
check('iPhone: iOS major version', describeDevice(UA.iphone) === 'Safari 17 on iOS 17 (iPhone) · Phone');
check('installed app is noted', describeDevice(UA.iphone, 'app').endsWith('· installed app'));
check('Edge on Windows, not Chrome', describeDevice(UA.edge) === 'Edge 128 on Windows 10/11 · Computer');
check('Safari on macOS', describeDevice(UA.mac) === 'Safari 17 on macOS · Computer');
check('Android without "Mobile" is a tablet', describeDevice(UA.tablet).endsWith('· Tablet'));
check('curl is an API client', describeDevice('curl/8.4.0') === 'API client (curl 8.4.0)');
check('no user agent', describeDevice('') === 'Unknown device');

const clean = sanitize({ email: 'a@b.c', password: 'secret123', nested: { token: 'x', newPassword: 'y', ok: 1 }, list: [{ passwordHash: 'z' }] });
check('passwords masked', clean.password === '••••••' && clean.nested.newPassword === '••••••' && clean.list[0].passwordHash === '••••••');
check('tokens masked', clean.nested.token === '••••••');
check('other values kept', clean.email === 'a@b.c' && clean.nested.ok === 1);
check('long strings trimmed', sanitize({ note: 'x'.repeat(900) }).note.length === 501);

check('IPv4-mapped IPv6 address unwrapped', clientIp({ ip: '::ffff:192.168.1.20' }) === '192.168.1.20');
check('IPv6 loopback shown as 127.0.0.1', clientIp({ ip: '::1' }) === '127.0.0.1');

const res = { locals: {} };
const stamp = downloadStamp({ user: { name: 'Jane Auma', email: 'jane@example.com', role: 'hr' } }, res);
check('download stamp names the user and role', stamp.by === 'Jane Auma <jane@example.com> (HR)');
check('download stamp reference format', /^DL-\d{8}-[0-9A-F]{6}$/.test(stamp.ref));
check('download ref handed to the audit entry', res.locals.audit.downloadRef === stamp.ref);
check('download stamp text has time in EAT', /on \d{2} \w{3} \d{4} \d{2}:\d{2} EAT - Ref DL-/.test(stamp.text));

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
