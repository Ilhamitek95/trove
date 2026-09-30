'use strict';
/**
 * Account recovery: forgot/reset password, change password, email
 * confirmation, the Google pre-hijack rule and the My details profile.
 *
 * Load-bearing rules:
 *   - /forgot answers the same neutral 200 whether or not the email exists,
 *     and only a real account gets a link
 *   - a reset token is stored hashed, works once, expires after an hour, and
 *     only the newest one works
 *   - a reset or a password change signs out every other session
 *   - Google sign-in to an unconfirmed password account confirms the email
 *     AND voids the unproven password (closing the pre-hijack hole)
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://trove.test' });
delete process.env.GOOGLE_CLIENT_ID;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, sent, ipN = 0;

// Each call comes from its own address so the sign-in limiter (30 per 10
// minutes per address) never trips over this file's own traffic.
async function call(method, pathname, { body, cookie, ip } = {}) {
  const res = await fetch(ctx.baseUrl + pathname, {
    method, redirect: 'manual',
    headers: {
      'x-forwarded-for': ip || `198.51.100.${(++ipN % 250) + 1}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const tick = () => new Promise((r) => setImmediate(r));
const linkIn = (mail, path) => {
  const m = mail.html.match(new RegExp(`https://trove\\.test${path.replace('?', '\\?')}([A-Za-z0-9_-]+)`));
  return m && m[1];
};
async function signIn(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, r.text);
  return r.cookie;
}
function makeUser(email, password = 'oldpass123', extra = {}) {
  const { hashPassword } = require('../src/middleware');
  const cols = { email, password_hash: hashPassword(password), name: 'Layla Haddad', role: 'buyer', ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
}

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  sent = [];
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
});
after(async () => { await ctx.close(); });

test('forgot: the same neutral answer for a real and an unknown email; only the real one gets a link', async () => {
  makeUser('layla@test.local');
  sent.length = 0;
  const known = await call('POST', '/api/auth/forgot', { body: { email: ' Layla@Test.local ' } });
  const unknown = await call('POST', '/api/auth/forgot', { body: { email: 'nobody@test.local' } });
  const empty = await call('POST', '/api/auth/forgot', { body: {} });
  await tick();
  for (const r of [known, unknown, empty]) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, known.data, 'no way to tell which emails have accounts');
  }
  assert.equal(sent.length, 1, 'one email, for the real account only');
  assert.equal(sent[0].to, 'layla@test.local');
  assert.match(sent[0].subject, /Reset your Trove password/);
  const token = linkIn(sent[0], '/reset?token=');
  assert.ok(token, 'the email carries the /reset link');
  const row = db.prepare("SELECT * FROM auth_tokens WHERE kind='reset' ORDER BY id DESC").get();
  assert.notEqual(row.token_hash, token, 'only a hash is stored');
  assert.equal(row.token_hash, require('../src/accounts').hashToken(token));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM auth_tokens').all()).includes(token), 'the raw token is nowhere in the table');
  assert.ok(row.expires_at - Date.now() <= 60 * 60 * 1000 && row.expires_at - Date.now() > 59 * 60 * 1000, 'expires in an hour');
});

test('forgot rides the sign-in limiter', async () => {
  const r = await call('POST', '/api/auth/forgot', { body: { email: 'x@test.local' } });
  assert.equal(r.headers.get('ratelimit-limit'), '30');
});

test('reset: short password refused without spending the link; then it works once, signs everyone out and signs this browser in', async () => {
  const uid = makeUser('omar@test.local');
  const phoneA = await signIn('omar@test.local', 'oldpass123');
  const laptopB = await signIn('omar@test.local', 'oldpass123');
  sent.length = 0;
  await call('POST', '/api/auth/forgot', { body: { email: 'omar@test.local' } });
  await tick();
  const token = linkIn(sent[0], '/reset?token=');

  assert.equal((await call('GET', `/api/auth/reset?token=${token}`)).data.valid, true);
  assert.equal((await call('GET', '/api/auth/reset?token=nonsense')).data.valid, false);

  const short = await call('POST', '/api/auth/reset', { body: { token, password: 'short' } });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /at least 8/);

  sent.length = 0;
  const ok = await call('POST', '/api/auth/reset', { body: { token, password: 'brandnew123' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.user.email, 'omar@test.local');
  assert.equal((await call('GET', '/api/auth/me', { cookie: ok.cookie })).status, 200, 'signed in on this browser');
  for (const old of [phoneA, laptopB]) assert.equal((await call('GET', '/api/auth/me', { cookie: old })).status, 401, 'every earlier session is signed out');

  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'omar@test.local', password: 'oldpass123' } })).status, 401);
  await signIn('omar@test.local', 'brandnew123');
  assert.ok(db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(uid).email_verified_at, 'the link proved the inbox');
  await tick();
  assert.ok(sent.some((m) => m.to === 'omar@test.local' && /password was changed/.test(m.subject)), 'a heads-up email');

  const again = await call('POST', '/api/auth/reset', { body: { token, password: 'another123' } });
  assert.equal(again.status, 400, 'single use');
  assert.equal(again.data.code, 'bad_token');
});

test('reset: an expired link and a superseded link are both refused', async () => {
  const accounts = require('../src/accounts');
  const uid = makeUser('sara@test.local');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const stale = accounts.issueToken(user, 'reset', Date.now() - 61 * 60 * 1000);
  const r1 = await call('POST', '/api/auth/reset', { body: { token: stale, password: 'brandnew123' } });
  assert.equal(r1.status, 400, 'older than an hour');

  const first = accounts.issueToken(user, 'reset');
  const second = accounts.issueToken(user, 'reset');
  assert.equal((await call('POST', '/api/auth/reset', { body: { token: first, password: 'brandnew123' } })).status, 400, 'only the newest link works');
  assert.equal((await call('POST', '/api/auth/reset', { body: { token: second, password: 'brandnew123' } })).status, 200);
});

test('change password: needs the current one and 8+ characters, and signs out the other sessions', async () => {
  makeUser('noor@test.local');
  const here = await signIn('noor@test.local', 'oldpass123');
  const elsewhere = await signIn('noor@test.local', 'oldpass123');

  const wrong = await call('POST', '/api/auth/password', { cookie: here, body: { current: 'nope', password: 'brandnew123' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, 'wrong_password');
  const short = await call('POST', '/api/auth/password', { cookie: here, body: { current: 'oldpass123', password: 'short' } });
  assert.equal(short.status, 400);
  assert.equal((await call('POST', '/api/auth/password', { body: { current: 'a', password: 'brandnew123' } })).status, 401, 'signed-in only');

  const ok = await call('POST', '/api/auth/password', { cookie: here, body: { current: 'oldpass123', password: 'brandnew123' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await call('GET', '/api/auth/me', { cookie: ok.cookie })).status, 200, 'this browser carries on');
  assert.equal((await call('GET', '/api/auth/me', { cookie: elsewhere })).status, 401, 'the other device is signed out');
  await signIn('noor@test.local', 'brandnew123');
});

test('Google-only accounts: set a password without a current one, or through the reset email', async (t) => {
  const google = require('../src/google-auth');
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  const real = google.verifyIdToken;
  google.verifyIdToken = async (cred) => (cred === 'g-hana' ? { email: 'hana@test.local', name: 'Hana' } : cred === 'g-rami' ? { email: 'rami@test.local', name: 'Rami' } : null);
  t.after(() => { google.verifyIdToken = real; delete process.env.GOOGLE_CLIENT_ID; });

  const g = await call('POST', '/api/auth/google', { body: { credential: 'g-hana' } });
  assert.equal(g.status, 200);
  assert.equal(g.data.user.hasPassword, false);
  assert.equal(g.data.user.emailVerified, true, 'Google proved the inbox');
  const set = await call('POST', '/api/auth/password', { cookie: g.cookie, body: { password: 'hanapass123' } });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.data.user.hasPassword, true);
  await signIn('hana@test.local', 'hanapass123');

  await call('POST', '/api/auth/google', { body: { credential: 'g-rami' } });
  sent.length = 0;
  await call('POST', '/api/auth/forgot', { body: { email: 'rami@test.local' } });
  await tick();
  const token = linkIn(sent[0], '/reset?token=');
  assert.equal((await call('POST', '/api/auth/reset', { body: { token, password: 'ramipass123' } })).status, 200);
  await signIn('rami@test.local', 'ramipass123');
});

test('Google sign-in to an unconfirmed password account confirms it and voids the unproven password', async (t) => {
  // An attacker registers with the victim's email before the victim ever
  // arrives, and stays signed in.
  const reg = await call('POST', '/api/auth/register', { body: { email: 'victim@test.local', password: 'attacker123', name: 'Not The Victim' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.emailVerified, false);
  const attacker = reg.cookie;

  const google = require('../src/google-auth');
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  const real = google.verifyIdToken;
  google.verifyIdToken = async (cred) => (cred === 'g-victim' ? { email: 'victim@test.local', name: 'Victim' } : cred === 'g-kept' ? { email: 'kept@test.local', name: 'Kept' } : null);
  t.after(() => { google.verifyIdToken = real; delete process.env.GOOGLE_CLIENT_ID; });

  const v = await call('POST', '/api/auth/google', { body: { credential: 'g-victim' } });
  assert.equal(v.status, 200);
  assert.equal(v.data.user.emailVerified, true);
  assert.equal(v.data.user.hasPassword, false, 'the password set by whoever registered is gone');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'victim@test.local', password: 'attacker123' } })).status, 401, 'the attacker password no longer works');
  assert.equal((await call('GET', '/api/auth/me', { cookie: attacker })).status, 401, 'the attacker session is signed out');
  assert.equal((await call('GET', '/api/auth/me', { cookie: v.cookie })).status, 200, 'the real owner is in');

  // A CONFIRMED password account keeps its password when its owner uses Google.
  makeUser('kept@test.local', 'keptpass123', { email_verified_at: '2026-09-01 10:00:00' });
  assert.equal((await call('POST', '/api/auth/google', { body: { credential: 'g-kept' } })).status, 200);
  await signIn('kept@test.local', 'keptpass123');
});

test('register sends a welcome with a confirm link; the link confirms once and shopping never waits on it', async () => {
  sent.length = 0;
  const reg = await call('POST', '/api/auth/register', { body: { email: 'new@test.local', password: 'newpass123', name: 'Dana Aziz' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.emailVerified, false);
  assert.equal((await call('GET', '/api/account/orders', { cookie: reg.cookie })).status, 200, 'unconfirmed accounts use the site as normal');
  await tick();
  const mail = sent.find((m) => m.to === 'new@test.local');
  assert.ok(mail, 'welcome email sent to the new account');
  assert.match(mail.subject, /confirm your email/);
  assert.match(mail.html, /Hello Dana/);
  const token = linkIn(mail, '/api/auth/verify-email?token=');
  assert.ok(token);

  const hit = await call('GET', `/api/auth/verify-email?token=${token}`, { cookie: reg.cookie });
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get('location'), '/account?verified=1');
  assert.equal((await call('GET', '/api/auth/me', { cookie: reg.cookie })).data.user.emailVerified, true);
  const twice = await call('GET', `/api/auth/verify-email?token=${token}`);
  assert.equal(twice.headers.get('location'), '/login?verify=expired', 'single use');
});

test('My details: name and UAE mobile persist; bad, taken and empty mobiles are handled', async () => {
  makeUser('ali@test.local');
  makeUser('taken@test.local', 'oldpass123', { phone: '+971509990000' });
  const cookie = await signIn('ali@test.local', 'oldpass123');
  const upd = await call('PATCH', '/api/account/me', { cookie, body: { name: '  Ali Hassan ', phone: '050 111 2233' } });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.data.user.name, 'Ali Hassan');
  assert.equal(upd.data.user.phone, '+971501112233', 'normalised');
  assert.equal((await call('GET', '/api/auth/me', { cookie })).data.user.phone, '+971501112233');
  const byPhone = await call('POST', '/api/auth/login', { body: { identifier: '0501112233', password: 'oldpass123' } });
  assert.equal(byPhone.status, 200, 'the new mobile signs in');

  assert.equal((await call('PATCH', '/api/account/me', { cookie, body: { phone: '04 321 1234' } })).status, 400);
  assert.equal((await call('PATCH', '/api/account/me', { cookie, body: { phone: '0509990000' } })).status, 409);
  assert.equal((await call('PATCH', '/api/account/me', { cookie, body: { name: '<b>x</b>' } })).status, 400);
  assert.equal((await call('PATCH', '/api/account/me', { cookie, body: { name: '' } })).status, 400);
  assert.equal((await call('PATCH', '/api/account/me', { cookie, body: {} })).status, 400);
  const cleared = await call('PATCH', '/api/account/me', { cookie, body: { phone: '' } });
  assert.equal(cleared.data.user.phone, null);
  assert.equal((await call('PATCH', '/api/account/me', { body: { name: 'x' } })).status, 401);
});
