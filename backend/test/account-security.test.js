'use strict';
/**
 * Account security:
 *   - every sign-in (password, sign-up) starts a brand-new session id, so an
 *     id planted before the sign-in is worthless after it (session fixation)
 *   - /api/services/apply never checks a password: an existing email that is
 *     not the signed-in account gets 409 sign_in_required, right or wrong
 *     password alike — it is not a second place to guess passwords
 *   - apply + enable-services share the sign-in rate limit
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db;
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

const APPLY = {
  name: 'Existing Person', email: 'existing@test.local', providerName: 'Existing Practice',
  categories: ['workshops'], location: 'Dubai, UAE', about: 'Workshops.', experience: '3+ years',
  instagram: '@existing', links: '', phone: '+971 50 111 2233', agreeSub: true, agreeTerms: true,
};

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('existing@test.local',?,'Existing','buyer')")
    .run(hashPassword('rightpass123'));
});
after(async () => { await ctx.close(); });

test('signing in replaces a planted session id with a fresh one', async () => {
  // A session id already in the browser (an attacker could have planted it)
  // is presented at the next sign-in.
  const planted = await fetch(ctx.baseUrl + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'existing@test.local', password: 'rightpass123' }),
  });
  const first = cookieOf(planted);
  assert.ok(first);
  const again = await ctx.api('POST', '/api/auth/login', { cookie: first, body: { email: 'existing@test.local', password: 'rightpass123' } });
  assert.equal(again.status, 200);
  const second = cookieOf(again);
  assert.ok(second && second !== first, 'a new session id is issued on sign-in');
  assert.equal((await ctx.api('GET', '/api/auth/me', { cookie: first })).status, 401, 'the old id no longer works');
  assert.equal((await ctx.api('GET', '/api/auth/me', { cookie: second })).status, 200);
});

test('services apply: an existing email that is not signed in gets 409 sign_in_required, whatever the password', async () => {
  for (const password of ['rightpass123', 'wrongpass123', undefined]) {
    const r = await ctx.api('POST', '/api/services/apply', { body: { ...APPLY, password } });
    assert.equal(r.status, 409, `password ${password}`);
    assert.equal(r.data.code, 'sign_in_required');
    assert.match(r.data.error, /sign in first/);
    assert.equal(r.headers.get('set-cookie'), null, 'never signs anyone in');
  }
  const uid = db.prepare("SELECT id FROM users WHERE email='existing@test.local'").get().id;
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM service_providers WHERE user_id=?').get(uid).c, 0, 'no profile attached');
});

test('services apply: the signed-in owner of that email can apply on the same session', async () => {
  const cookie = await ctx.loginAs('existing@test.local', 'rightpass123');
  const r = await ctx.api('POST', '/api/services/apply', { cookie, body: APPLY });
  assert.equal(r.status, 201, r.text);
  assert.equal((await ctx.api('GET', '/api/auth/me', { cookie })).data.provider.name, 'Existing Practice');
});

test('services apply: a new account needs 8+ characters and starts on a fresh session', async () => {
  const fresh = { ...APPLY, email: 'newprov@test.local', providerName: 'New Practice' };
  let r = await ctx.api('POST', '/api/services/apply', { body: { ...fresh, password: 'short' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /at least 8 characters/);
  r = await ctx.api('POST', '/api/services/apply', { body: { ...fresh, password: 'longenough1' } });
  assert.equal(r.status, 201, r.text);
  assert.ok(cookieOf(r));
});

test('services apply and enable-services share the sign-in rate limit', async () => {
  const ip = { 'x-forwarded-for': '198.51.100.77' };
  let last;
  for (let i = 0; i < 31; i++) {
    const res = await fetch(ctx.baseUrl + '/api/services/apply', {
      method: 'POST', headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ ...APPLY, password: 'guess' + i }),
    });
    last = res.status;
    await res.arrayBuffer();
    if (last === 429) break;
  }
  assert.equal(last, 429);
  const login = await fetch(ctx.baseUrl + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', ...ip },
    body: JSON.stringify({ email: 'existing@test.local', password: 'rightpass123' }),
  });
  await login.arrayBuffer();
  assert.equal(login.status, 429, 'one budget across all the account doors');
  const enable = await fetch(ctx.baseUrl + '/api/seller/enable-services', {
    method: 'POST', headers: { 'content-type': 'application/json', ...ip }, body: '{}',
  });
  await enable.arrayBuffer();
  assert.equal(enable.status, 429);
});
