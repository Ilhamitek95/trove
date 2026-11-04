'use strict';
/**
 * 'Since launch' on the admin Overview + the apply page's lead event (4 Nov 2026).
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ RATE_LIMIT_DISABLED: '1' });

const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');

let ctx, db, api, adminCookie;
before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async () => ({ id: 'test' });
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@test.local',?, 'Owner','admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('owner@test.local', 'adminpass123');
});
after(async () => { await ctx.close(); });

test('the overview counts accounts, applications, orders, bookings, messages and searches since launch', async () => {
  const before = (await api('GET', '/api/admin/stats', { cookie: adminCookie })).data.sinceLaunch;
  assert.equal(before.since, '2026-10-15');
  for (const k of ['accounts', 'buyers', 'makerApplications', 'providerApplications', 'orders', 'bookings', 'messages', 'searches']) {
    assert.equal(typeof before[k], 'number', k);
  }
  // A new shopper account and a new maker application count; the admin never does.
  const reg = await api('POST', '/api/auth/register', { body: { name: 'Launch Lina', email: 'launch-lina@test.local', password: 'testpass123' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const maker = await api('POST', '/api/auth/register', { body: {
    role: 'seller', name: 'Launch Maker', email: 'launch-maker@test.local', password: 'testpass123', shopName: 'Launch Pots',
    category: 'ceramics', maker: 'me', plannedProducts: 'Bowls', location: 'Dubai', about: 'Pots.', instagram: '@launchpots', phone: '+971500000000',
  } });
  assert.ok([200, 201].includes(maker.status), JSON.stringify(maker.data));
  db.prepare("INSERT INTO contact_messages (name, email, message) VALUES ('L', 'l@test.local', 'hello')").run();
  const after_ = (await api('GET', '/api/admin/stats', { cookie: adminCookie })).data.sinceLaunch;
  assert.equal(after_.accounts - before.accounts, 2);
  assert.equal(after_.buyers - before.buyers, 1);
  assert.equal(after_.makerApplications - before.makerApplications, 1);
  assert.equal(after_.messages - before.messages, 1);
  // Rows from before launch never count.
  db.prepare("UPDATE users SET created_at = '2026-10-01 10:00:00' WHERE email = 'launch-lina@test.local'").run();
  const old = (await api('GET', '/api/admin/stats', { cookie: adminCookie })).data.sinceLaunch;
  assert.equal(old.accounts - before.accounts, 1);
});

test('the admin page renders the strip and the apply page reports a lead', () => {
  const admin = read('trove-admin.html');
  assert.match(admin, /id="launchCard"/);
  assert.match(admin, /function renderSinceLaunch\(l\)/);
  assert.match(admin, /renderSinceLaunch\(s\.sinceLaunch\)/);
  const apply = read('trove-apply.html');
  assert.match(apply, /troveTrack\('generate_lead',\{method:'apply',lead_type:ROLE\}\)/);
  // Never personal data in the event.
  assert.doesNotMatch(apply, /troveTrack\('generate_lead',\{[^}]*(email|name|phone)/);
});
