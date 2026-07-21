'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '' }); // no Stripe at all — demo-payments mode

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, buyerCookie, otherCookie;
let shopId, mugId;

const ADDRESS = { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' };

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal Rashid','buyer')").run(pw);
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('other@test.local',?, 'Other Person','buyer')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  mugId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shopId, 'Mug', 'Ceramics', 6400, 5).lastInsertRowid;

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('demo checkout needs the address up front (no payment form to come back from)', async () => {
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: { items: [{ productId: mugId, qty: 1 }] } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /address/i);
});

test('demo checkout opens a REAL order and demo-complete pays it like the webhook would', async () => {
  let res = await ctx.api('POST', '/api/checkout', {
    cookie: buyerCookie, body: { items: [{ productId: mugId, qty: 2 }], address: ADDRESS },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.demo, true);
  assert.ok(res.data.orderId, 'public order id returned');
  assert.equal(res.data.clientSecret, undefined, 'no Stripe secret in demo mode');
  assert.equal(res.data.amount, 6400 * 2 + 900 + 2500, 'items + service + delivery');
  const pid = res.data.orderId;

  // Someone else cannot complete it.
  let steal = await ctx.api('POST', '/api/checkout/demo-complete', { cookie: otherCookie, body: { orderId: pid } });
  assert.equal(steal.status, 403);

  res = await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: pid } });
  assert.equal(res.status, 200, res.text);

  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(pid);
  assert.equal(order.status, 'paid');
  assert.ok(order.title_transferred_at, 'title transferred like a real payment');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(mugId).stock, 3, 'stock decremented');
  const ship = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(order.id);
  assert.ok(ship, 'shipment opened for the shop');
  const credit = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='credit_sale'").get(order.id);
  assert.equal(credit.amount_cents, Math.round(6400 * 2 * 0.8), 'supplier credited at 80%');

  // The buyer sees it in their account, return-eligible machinery included.
  const acct = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const mine = acct.data.orders.find((o) => o.id === pid);
  assert.ok(mine, 'order shows in the account');
  assert.equal(mine.status, 'paid');

  // Completing twice is refused.
  res = await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: pid } });
  assert.equal(res.status, 409);
});

test('a guest order can be claimed by the account created right after (same session)', async () => {
  // Guest: no auth cookie — capture the session Set-Cookie from checkout itself.
  const res = await fetch(ctx.baseUrl + '/api/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: mugId, qty: 1 }], email: 'guest@test.local', address: ADDRESS }),
  });
  assert.equal(res.status, 200);
  const guestCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(guestCookie, 'guest got a session');
  const { orderId } = await res.json();

  let r = await ctx.api('POST', '/api/checkout/demo-complete', { cookie: guestCookie, body: { orderId } });
  assert.equal(r.status, 200, r.text);

  r = await ctx.api('POST', '/api/auth/register', { cookie: guestCookie, body: { role: 'buyer', name: 'New Guest', email: 'guest@test.local', password: 'longenough1' } });
  assert.equal(r.status, 201, r.text);
  r = await ctx.api('POST', '/api/checkout/claim', { cookie: guestCookie, body: { orderId } });
  assert.equal(r.status, 200, r.text);

  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(orderId);
  const guest = db.prepare("SELECT id FROM users WHERE email='guest@test.local'").get();
  assert.equal(order.buyer_id, guest.id, 'order attached to the new account');

  // A different session cannot claim someone's demo order with just the id.
  const res2 = await fetch(ctx.baseUrl + '/api/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: mugId, qty: 1 }], email: 'guest2@test.local', address: ADDRESS }),
  });
  const { orderId: otherOrder } = await res2.json();
  r = await ctx.api('POST', '/api/checkout/claim', { cookie: buyerCookie, body: { orderId: otherOrder } });
  assert.equal(r.status, 403, 'session stamp required');
});

test('the demo door closes by itself the moment Stripe is configured', async () => {
  const res = await ctx.api('POST', '/api/checkout', {
    cookie: buyerCookie, body: { items: [{ productId: mugId, qty: 1 }], address: ADDRESS },
  });
  const pid = res.data.orderId;

  process.env.STRIPE_MOCK = '1'; // resolved at call time — simulates go-live
  try {
    const r = await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: pid } });
    assert.equal(r.status, 409, 'demo completion refused once payments are live');
    const co = await ctx.api('POST', '/api/checkout', {
      cookie: buyerCookie, body: { items: [{ productId: mugId, qty: 1 }], address: ADDRESS },
    });
    assert.ok(co.data.clientSecret, 'real checkout resumes with a PaymentIntent');
    assert.equal(co.data.demo, undefined);
  } finally {
    process.env.STRIPE_MOCK = '';
  }
});
