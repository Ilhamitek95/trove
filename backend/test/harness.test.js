'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('app boots on a temp DB with the Stripe mock active', async () => {
  const res = await ctx.api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.stripe, true); // mock counts as configured
});

test('config endpoint serves the public money rules', async () => {
  const res = await ctx.api('GET', '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.data.currency, 'aed');
  assert.ok(res.data.serviceFeeCents >= 0);
  assert.ok(Array.isArray(res.data.serviceAreas));
});

test('webhook accepts a mock event and dedupes nothing yet (smoke)', async () => {
  const res = await ctx.postWebhook({ id: 'evt_smoke_1', type: 'noop.event', data: { object: {} } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { received: true });
});

test('auth round-trip works against the temp DB', async () => {
  const reg = await ctx.api('POST', '/api/auth/register', {
    body: { email: 'harness@test.local', password: 'testpass123', name: 'Harness', role: 'buyer' },
  });
  assert.equal(reg.status, 201, reg.text);
  const cookie = await ctx.loginAs('harness@test.local', 'testpass123');
  const me = await ctx.api('GET', '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'harness@test.local');
});
