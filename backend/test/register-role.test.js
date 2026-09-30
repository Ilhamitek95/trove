'use strict';
// Sign-up can never hand out the admin role — only buyer, seller or both.
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

for (const role of ['admin', 'ADMIN', 'superadmin', ['admin'], 1]) {
  test(`register refuses role ${JSON.stringify(role)}`, async () => {
    const email = `r${Math.random().toString(36).slice(2, 8)}@test.local`;
    const res = await ctx.api('POST', '/api/auth/register', {
      body: { email, password: 'testpass123', name: 'Nope', role },
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(ctx.db.prepare('SELECT 1 FROM users WHERE email=?').get(email), undefined);
  });
}

test('a refused admin sign-up gets no session and no admin access', async () => {
  const res = await ctx.api('POST', '/api/auth/register', {
    body: { email: 'sneaky@test.local', password: 'testpass123', name: 'Sneaky', role: 'admin' },
  });
  assert.equal(res.status, 400);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const stats = await ctx.api('GET', '/api/admin/stats', { cookie });
  assert.notEqual(stats.status, 200);
});

test('buyer is the default role and buyer sign-up still works', async () => {
  const res = await ctx.api('POST', '/api/auth/register', {
    body: { email: 'plain@test.local', password: 'testpass123', name: 'Plain' },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(ctx.db.prepare('SELECT role FROM users WHERE email=?').get('plain@test.local').role, 'buyer');
});
