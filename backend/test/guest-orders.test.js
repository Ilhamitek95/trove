'use strict';
/**
 * Guest orders join the buyer's account (src/guest-orders.js):
 *
 *   - an order placed as a guest is attached to the account with that email
 *     once the account's email is CONFIRMED — by the welcome link, Google,
 *     a password-reset link, or on the next sign-in / order-list visit
 *   - an unconfirmed account claims nothing (typing a stranger's email at
 *     sign-up must not hand over the stranger's orders)
 *   - unpaid (pending) orders and orders that already belong to an account
 *     stay where they are; email case and spaces don't matter
 *   - once attached, the order can be returned from the account
 *   - the guest's receipt says how to reach the order instead of promising an
 *     account page they can't see; the storefront's copy says the same
 */
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let ctx, db, shopId, productId;
const PW = 'testpass123';

function order(publicId, email, { status = 'paid', buyerId = null } = {}) {
  const id = db.prepare(`INSERT INTO orders (public_id, buyer_id, email, subtotal_cents, shipping_cents, total_cents, status, shipping_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(publicId, buyerId, email, 6400, 3000, 9400, status,
    JSON.stringify({ name: 'Gina Guest', line: 'Villa 3', city: 'Jumeirah 1, Dubai' })).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id, product_id, shop_id, name_snapshot, price_cents, qty) VALUES (?,?,?,?,?,?)')
    .run(id, productId, shopId, 'Mug', 6400, 1);
  return id;
}
const owner = (publicId) => db.prepare('SELECT buyer_id FROM orders WHERE public_id=?').get(publicId).buyer_id;
function user(email, { verified = false } = {}) {
  const { hashPassword } = require('../src/middleware');
  return db.prepare(`INSERT INTO users (email, password_hash, name, role, email_verified_at) VALUES (?,?,?,'buyer',${verified ? "datetime('now')" : 'NULL'})`)
    .run(email, hashPassword(PW), 'Test Buyer').lastInsertRowid;
}
const ids = async (cookie) => (await ctx.api('GET', '/api/account/orders', { cookie })).data.orders.map((o) => o.id).sort();

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker-go@test.local',?, 'Maker','seller')").run(hashPassword(PW)).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Guest Pots', 'guest-pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shopId, 'Mug', 'Ceramics', 6400, 5).lastInsertRowid;
});
after(async () => { await ctx.close(); });

test('an unconfirmed account sees none of the guest orders placed with its email', async () => {
  order('TRV-GUEST1', 'gina@test.local');
  const reg = await ctx.api('POST', '/api/auth/register', { body: { role: 'buyer', name: 'Gina', email: 'gina@test.local', password: PW } });
  assert.equal(reg.status, 201, reg.text);
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  assert.deepEqual(await ids(cookie), []);
  assert.equal(owner('TRV-GUEST1'), null, 'still a guest order');
  // Signing in again changes nothing while the email is unproven.
  const again = await ctx.loginAs('gina@test.local', PW);
  assert.deepEqual(await ids(again), []);
  assert.equal(owner('TRV-GUEST1'), null);
});

test('confirming the email (the welcome link) attaches the guest orders — paid only, any case, never someone else’s', async () => {
  order('TRV-GUEST2', '  Gina@Test.Local ');                   // typed with capitals and spaces
  order('TRV-GUEST3', 'gina@test.local', { status: 'pending' }); // never paid: stays out
  order('TRV-OTHER1', 'someone-else@test.local');
  const otherId = user('owned@test.local', { verified: true });
  order('TRV-OWNED1', 'gina@test.local', { buyerId: otherId }); // already in another account: untouched
  const gina = db.prepare('SELECT * FROM users WHERE email=?').get('gina@test.local');
  const token = require('../src/accounts').issueToken(gina, 'verify');
  const res = await ctx.api('GET', `/api/auth/verify-email?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 302);
  assert.equal(owner('TRV-GUEST1'), gina.id);
  assert.equal(owner('TRV-GUEST2'), gina.id);
  assert.equal(owner('TRV-GUEST3'), null, 'pending order left alone');
  assert.equal(owner('TRV-OTHER1'), null);
  assert.equal(owner('TRV-OWNED1'), otherId);
  const cookie = await ctx.loginAs('gina@test.local', PW);
  assert.deepEqual(await ids(cookie), ['TRV-GUEST1', 'TRV-GUEST2']);
});

test('an order placed as a guest by an existing, confirmed account appears on its next visit — and can be returned', async () => {
  const samId = user('samira@test.local', { verified: true });
  const cookie = await ctx.loginAs('samira@test.local', PW);
  assert.deepEqual(await ids(cookie), []);
  // Samira checks out while signed out (another phone, a cleared browser).
  const oid = order('TRV-SAMIRA', 'samira@test.local');
  db.prepare("UPDATE orders SET status='fulfilled', delivered_at=datetime('now','-1 day') WHERE id=?").run(oid);
  assert.deepEqual(await ids(cookie), ['TRV-SAMIRA'], 'the order list itself picks it up');
  assert.equal(owner('TRV-SAMIRA'), samId);
  const item = db.prepare('SELECT id FROM order_items WHERE order_id=?').get(oid);
  const ret = await ctx.api('POST', '/api/account/orders/TRV-SAMIRA/return-request', {
    cookie, body: { items: [{ orderItemId: item.id, qty: 1 }], reason: 'damaged', details: 'Arrived with a crack along the rim', photos: [] },
  });
  assert.notEqual(ret.status, 404, `the return route now finds the order (${ret.status} ${ret.text})`);
});

test('a confirmed email claims on sign-in; the reset link counts as confirming', async () => {
  const id = user('lina@test.local', { verified: true });
  order('TRV-LINA01', 'lina@test.local');
  await ctx.loginAs('lina@test.local', PW);
  assert.equal(owner('TRV-LINA01'), id, 'claimed on sign-in');

  // Reset link: proves the inbox of an account that never confirmed.
  const noorId = user('noor@test.local');
  order('TRV-NOOR01', 'noor@test.local');
  const noor = db.prepare('SELECT * FROM users WHERE id=?').get(noorId);
  const token = require('../src/accounts').issueToken(noor, 'reset');
  const r = await ctx.api('POST', '/api/auth/reset', { body: { token, password: 'newpass12345' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(owner('TRV-NOOR01'), noorId, 'claimed after the reset proved the inbox');
});

test('claimForUser is a no-op for unconfirmed or missing accounts', () => {
  const g = require('../src/guest-orders');
  const id = user('nobody-yet@test.local');
  order('TRV-NOBODY', 'nobody-yet@test.local');
  assert.equal(g.claimForUser(id), 0);
  assert.equal(g.claimForUser(999999), 0);
  assert.equal(owner('TRV-NOBODY'), null);
});

test('the guest receipt tells them how to reach the order; an account receipt keeps the return line', () => {
  const email = require('../src/email');
  const base = { public_id: 'TRV-RCPT1', email: 'gina@test.local', subtotal_cents: 6400, shipping_cents: 3000, service_fee_cents: 0, total_cents: 9400, created_at: '2026-10-02 06:00:00' };
  const args = { items: [{ name: 'Mug', qty: 1, price_cents: 6400, shop: 'Guest Pots', image: '' }], shops: ['Guest Pots'], ship: null };
  const guest = email.orderConfirmation({ order: { ...base, buyer_id: null }, ...args }).html;
  assert.match(guest, /You checked out as a guest/);
  assert.match(guest, /gina@test\.local and confirm the address/);
  assert.doesNotMatch(guest, /request a return from this order in your account/);
  const member = email.orderConfirmation({ order: { ...base, buyer_id: 7 }, ...args }).html;
  assert.match(member, /request a return from this order in your account/);
  assert.doesNotMatch(member, /checked out as a guest/);
});

test('storefront + account copy no longer promise a link the order does not have', () => {
  const DOCS = path.join(__dirname, '..', '..', 'docs');
  const store = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8');
  assert.doesNotMatch(store, /your receipt keeps this order linked to your email/);
  assert.match(store, /sign in to it and this order appears there once the email is confirmed/);
  const acct = fs.readFileSync(path.join(DOCS, 'trove-account.html'), 'utf8');
  assert.match(acct, /function guestOrdersHint\(\)/);
  assert.match(acct, /Confirm your email address and those orders appear here/);
});
