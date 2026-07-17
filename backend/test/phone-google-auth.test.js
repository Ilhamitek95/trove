'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({});
delete process.env.GOOGLE_CLIENT_ID; // google starts OFF; a test flips it on with a stub

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUAEMobile } = require('../src/phone');

let ctx, db;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
});
after(async () => { await ctx.close(); });

test('normalizeUAEMobile accepts every way people type a UAE mobile', () => {
  for (const raw of ['0501234567', '050 123 4567', '+971501234567', '+971 50 123 4567',
    '971501234567', '501234567', '50-123-4567', '(050) 123 4567']) {
    assert.equal(normalizeUAEMobile(raw), '+971501234567', raw);
  }
});

test('normalizeUAEMobile rejects everything that is not a UAE mobile', () => {
  for (const raw of ['', null, '043211234', '+97143211234', '12345', '05012345',
    '050123456789', '+447911123456', '+9716123456789', 'not a number', '5501234567']) {
    assert.equal(normalizeUAEMobile(raw), null, String(raw));
  }
});

test('register with a UAE mobile, then sign in with any spelling of it', async () => {
  const reg = await ctx.api('POST', '/api/auth/register', {
    body: { email: 'amina@example.com', password: 'testpass123', name: 'Amina', mobile: '050 765 4321' },
  });
  assert.equal(reg.status, 201);
  assert.equal(db.prepare("SELECT phone FROM users WHERE email='amina@example.com'").get().phone, '+971507654321');

  for (const identifier of ['0507654321', '+971 50 765 4321', '971507654321', '50 765 4321']) {
    const login = await ctx.api('POST', '/api/auth/login', { body: { identifier, password: 'testpass123' } });
    assert.equal(login.status, 200, identifier);
    assert.equal(login.data.user.email, 'amina@example.com');
  }

  // email login still works for the same account
  const byEmail = await ctx.api('POST', '/api/auth/login', { body: { email: 'amina@example.com', password: 'testpass123' } });
  assert.equal(byEmail.status, 200);
});

test('phone login failures: wrong password, unknown number, non-UAE number', async () => {
  const wrongPw = await ctx.api('POST', '/api/auth/login', { body: { identifier: '0507654321', password: 'nope' } });
  assert.equal(wrongPw.status, 401);
  assert.match(wrongPw.data.error, /mobile/i);
  const unknown = await ctx.api('POST', '/api/auth/login', { body: { identifier: '0509999999', password: 'testpass123' } });
  assert.equal(unknown.status, 401);
  const landline = await ctx.api('POST', '/api/auth/login', { body: { identifier: '043211234', password: 'testpass123' } });
  assert.equal(landline.status, 401);
});

test('register rejects an invalid mobile and a duplicate mobile', async () => {
  const bad = await ctx.api('POST', '/api/auth/register', {
    body: { email: 'x@example.com', password: 'testpass123', name: 'X', mobile: '04 321 1234' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /UAE mobile/);
  assert.ok(!db.prepare("SELECT 1 FROM users WHERE email='x@example.com'").get(), 'no orphan account');

  const dup = await ctx.api('POST', '/api/auth/register', {
    body: { email: 'y@example.com', password: 'testpass123', name: 'Y', mobile: '+971507654321' },
  });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /mobile number already exists/);
});

test('google sign-in is 503 until GOOGLE_CLIENT_ID is configured', async () => {
  const r = await ctx.api('POST', '/api/auth/google', { body: { credential: 'anything' } });
  assert.equal(r.status, 503);
});

test('google sign-in verifies the token, creates a buyer once, then reuses it', async (t) => {
  const google = require('../src/google-auth');
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  const realVerify = google.verifyIdToken;
  google.verifyIdToken = async (cred) => (cred === 'good-token' ? { email: 'googler@example.com', name: 'Googler' } : null);
  t.after(() => { google.verifyIdToken = realVerify; delete process.env.GOOGLE_CLIENT_ID; });

  const badToken = await ctx.api('POST', '/api/auth/google', { body: { credential: 'garbage' } });
  assert.equal(badToken.status, 401);

  const first = await ctx.api('POST', '/api/auth/google', { body: { credential: 'good-token' } });
  assert.equal(first.status, 200);
  assert.equal(first.data.user.email, 'googler@example.com');
  assert.equal(first.data.user.role, 'buyer');
  const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
  const me = await ctx.api('GET', '/api/auth/me', { cookie });
  assert.equal(me.status, 200, 'google sign-in creates a working session');

  const again = await ctx.api('POST', '/api/auth/google', { body: { credential: 'good-token' } });
  assert.equal(again.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email='googler@example.com'").get().c, 1, 'no duplicate account');
});
