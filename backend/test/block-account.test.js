'use strict';
/**
 * F199 (last part): the owner can block a customer from buying.
 *   - the switch sits on the admin customer lookup (privacy lookup card);
 *   - a blocked customer still signs in and sees their orders;
 *   - checkout and service bookings refuse with a neutral message,
 *     whether signed in, as a guest under the same email, or under the
 *     account after an email change;
 *   - unblocking restores everything; both directions reach Activity
 *     without the email address.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const OWNER = 'owner@test.local';
let ctx, db, api, adminCookie, buyerCookie, buyerId, productId, serviceId;

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async () => ({ id: 'test' });
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?, 'Owner','admin')").run(OWNER, pw);
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role,email_verified_at) VALUES ('layla@test.local',?, 'Layla Haddad','buyer',datetime('now'))").run(pw).lastInsertRowid;
  const maker = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('kiln@test.local',?, 'Mara Kiln','seller')").run(pw).lastInsertRowid;
  const shop = db.prepare("INSERT INTO shops (user_id,name,slug,status,pickup_address,pickup_phone) VALUES (?,?,?,'approved','Al Quoz 3, Dubai','+971500000001')").run(maker, 'Kiln & Clay', 'kiln-clay').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,50,'live')").run(shop, 'Mug', 'Ceramics', 6400).lastInsertRowid;
  const prov = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('noor@test.local',?, 'Noor','seller')").run(pw).lastInsertRowid;
  const pid = db.prepare("INSERT INTO service_providers (user_id,name,slug,status,categories) VALUES (?,?,?,'approved','[\"photography\"]')").run(prov, 'Noor Frames', 'noor-frames').lastInsertRowid;
  serviceId = db.prepare('INSERT INTO services (provider_id,title,category,price_cents) VALUES (?,?,?,?)').run(pid, 'Home shoot', 'photography', 30000).lastInsertRowid;
  adminCookie = await ctx.loginAs(OWNER, 'testpass123');
  buyerCookie = await ctx.loginAs('layla@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const checkout = (cookie, email) => api('POST', '/api/checkout', {
  cookie,
  body: {
    items: [{ productId, qty: 1 }], ...(email ? { email } : {}), phone: '0501234567',
    address: { name: 'Layla', line: 'Marina Gate 2, apt 2104', city: 'Dubai', emirate: 'Dubai' },
  },
});
const book = (cookie, email) => api('POST', `/api/services/${serviceId}/book`, {
  cookie, body: { name: 'Layla', email, phone: '0501234567', area: 'Dubai', agreeTerms: true, paymentMethod: 'direct' },
});
const lookup = async (email) => (await api('GET', `/api/admin/privacy/lookup?email=${encodeURIComponent(email)}`, { cookie: adminCookie })).data;

test('before any block, the buyer can check out and book', async () => {
  assert.equal((await checkout(buyerCookie)).status, 200);
  assert.equal((await book(buyerCookie, 'layla@test.local')).status, 201);
  assert.equal((await lookup('layla@test.local')).blocked, null);
});

test('blocking needs an admin and a real email; an admin cannot be blocked', async () => {
  assert.equal((await api('POST', '/api/admin/customers/block', { cookie: buyerCookie, body: { email: 'x@test.local' } })).status, 403);
  assert.equal((await api('POST', '/api/admin/customers/block', { cookie: adminCookie, body: { email: 'nope' } })).status, 400);
  assert.equal((await api('POST', '/api/admin/customers/block', { cookie: adminCookie, body: { email: OWNER } })).status, 400);
});

test('a blocked buyer keeps their account but checkout and bookings refuse neutrally', async () => {
  const r = await api('POST', '/api/admin/customers/block', { cookie: adminCookie, body: { email: 'Layla@test.local', note: 'Three returns in a month' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.blocked.note, 'Three returns in a month');
  assert.equal(r.data.blocked.by, OWNER);

  // Still signed in, still sees their orders.
  const sess = await api('GET', '/api/auth/session', { cookie: buyerCookie });
  assert.equal(sess.data.user.email, 'layla@test.local');
  assert.equal((await api('GET', '/api/account/orders', { cookie: buyerCookie })).status, 200);

  const co = await checkout(buyerCookie);
  assert.equal(co.status, 403);
  assert.equal(co.data.code, 'blocked');
  assert.match(co.data.error, /contact us/);
  assert.doesNotMatch(co.data.error, /return|block/i, 'no reason is shown to the customer');

  const bk = await book(buyerCookie, 'layla@test.local');
  assert.equal(bk.status, 403);
  assert.equal(bk.data.code, 'blocked');

  // The same person as a guest, under the same email — and after changing
  // the account's email (the block remembers the account id).
  assert.equal((await checkout(null, 'LAYLA@test.local')).status, 403);
  assert.equal((await book(null, 'layla@test.local')).status, 403);
  db.prepare("UPDATE users SET email='layla2@test.local' WHERE id=?").run(buyerId);
  assert.equal((await checkout(buyerCookie)).status, 403);
  assert.equal((await checkout(null, 'layla2@test.local')).status, 403, 'the new address is blocked through the account');
  db.prepare("UPDATE users SET email='layla@test.local' WHERE id=?").run(buyerId);

  // A different customer is untouched.
  assert.equal((await checkout(null, 'someone-else@test.local')).status, 200);

  const s = await lookup('layla@test.local');
  assert.ok(s.blocked && s.blocked.at, 'the lookup card shows the block');
  assert.equal(s.blocked.note, 'Three returns in a month');
});

test('a guest with no account can be blocked by email', async () => {
  assert.equal((await api('POST', '/api/admin/customers/block', { cookie: adminCookie, body: { email: 'guest@test.local' } })).status, 200);
  assert.equal((await checkout(null, 'guest@test.local')).status, 403);
  assert.equal((await book(null, 'guest@test.local')).status, 403);
  assert.equal((await api('POST', '/api/admin/customers/unblock', { cookie: adminCookie, body: { email: 'guest@test.local' } })).status, 200);
  assert.equal((await checkout(null, 'guest@test.local')).status, 200);
});

test('unblocking restores ordering, and Activity has both events without the email', async () => {
  const r = await api('POST', '/api/admin/customers/unblock', { cookie: adminCookie, body: { email: 'layla@test.local' } });
  assert.equal(r.status, 200);
  assert.equal((await checkout(buyerCookie)).status, 200);
  assert.equal((await book(buyerCookie, 'layla@test.local')).status, 201);
  assert.equal((await lookup('layla@test.local')).blocked, null);

  await new Promise((res) => setTimeout(res, 40));
  const acts = (await api('GET', '/api/admin/activity', { cookie: adminCookie })).data.actions;
  const blocked = acts.find((a) => a.action === 'Customer blocked from buying' && /Buyer #/.test(a.note || ''));
  const unblocked = acts.find((a) => a.action === 'Customer unblocked' && /Buyer #/.test(a.note || ''));
  assert.ok(blocked, 'block recorded');
  assert.ok(unblocked, 'unblock recorded');
  for (const a of [blocked, unblocked]) assert.doesNotMatch(JSON.stringify(a), /layla@test\.local/, 'no email in the log');
  assert.equal(blocked.before.blocked, false);
  assert.equal(unblocked.before.blocked, true);
  assert.equal(blocked.after.note, 'Three returns in a month');
});
