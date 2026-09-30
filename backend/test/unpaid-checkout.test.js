'use strict';
/**
 * Unpaid checkouts: the order row + PaymentIntent exist from the moment the
 * payment form mounts, but they are not orders until paid — hidden from the
 * admin list (and sellers only ever see shipments, which start at payment),
 * and swept after 24 hours with the PaymentIntent cancelled first.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, stripe, adminCookie, sellerCookie, productId;
const ADDRESS = { name: 'Buyer', line: '1 Marina Walk', city: 'Dubai', emirate: 'Dubai' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const age = (publicId, hours) => db.prepare("UPDATE orders SET created_at=datetime('now', ?) WHERE public_id=?").run(`-${hours} hours`, publicId);
const openCheckout = async () => (await ctx.api('POST', '/api/checkout', { body: { items: [{ productId, qty: 1 }], email: 'b@test.local', address: ADDRESS, phone: '0501234567' } })).data;
const { sweepUnpaid } = require('../src/order-sweep');

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  stripe = ctx.stripeMock;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('adm@test.local',?,'A','admin')").run(hashPassword('adminpass123'));
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('mk@test.local',?,'M','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(uid, 'Pots', 'pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,50,'live')").run(shopId, 'Bowl', 'Ceramics').lastInsertRowid;
  adminCookie = await ctx.loginAs('adm@test.local', 'adminpass123');
  sellerCookie = await ctx.loginAs('mk@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('an unpaid checkout is not an order: absent from the admin and seller lists until paid', async () => {
  const co = await openCheckout();
  assert.ok(co.clientSecret);
  let list = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  assert.ok(!list.data.orders.some((o) => o.publicId === co.orderId), 'hidden from admin while unpaid');
  let mine = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  assert.equal(mine.data.orders.length, 0);

  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(co.orderId);
  await ctx.postWebhook({ id: 'evt_unpaid_1', type: 'payment_intent.succeeded', data: { object: { id: order.stripe_payment_intent_id, metadata: { order_id: String(order.id) } } } });
  await sleep(40);
  list = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  assert.ok(list.data.orders.some((o) => o.publicId === co.orderId && o.status === 'paid'), 'shown once paid');
  mine = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  assert.equal(mine.data.orders.length, 1);
});

test('the sweep cancels day-old unpaid checkouts and their PaymentIntents, and leaves fresh ones alone', async () => {
  const old = await openCheckout();
  const fresh = await openCheckout();
  age(old.orderId, 25);
  stripe.reset();
  const r = await sweepUnpaid();
  assert.ok(r.cancelled >= 1);
  const o = db.prepare('SELECT * FROM orders WHERE public_id=?').get(old.orderId);
  assert.equal(o.status, 'cancelled');
  const cancels = stripe.calls.filter((c) => c.method === 'paymentIntents.cancel');
  assert.deepEqual(cancels.map((c) => c.params.id), [o.stripe_payment_intent_id]);
  assert.equal(db.prepare('SELECT status FROM orders WHERE public_id=?').get(fresh.orderId).status, 'pending');
  // Swept drafts don't clutter the admin list either.
  const list = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  assert.ok(!list.data.orders.some((x) => x.publicId === old.orderId));
});

test('a PaymentIntent that was paid meanwhile is left for the webhook, not cancelled', async () => {
  const co = await openCheckout();
  age(co.orderId, 30);
  const pi = db.prepare('SELECT stripe_payment_intent_id AS pi FROM orders WHERE public_id=?').get(co.orderId).pi;
  stripe.setIntentStatus(pi, 'succeeded');
  const r = await sweepUnpaid();
  assert.ok(r.skipped >= 1);
  assert.equal(db.prepare('SELECT status FROM orders WHERE public_id=?').get(co.orderId).status, 'pending');
});

test('a payment that still lands on a swept order is refunded automatically and flagged', async () => {
  const co = await openCheckout();
  age(co.orderId, 26);
  await sweepUnpaid();
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(co.orderId);
  assert.equal(order.status, 'cancelled');
  stripe.reset();
  await ctx.postWebhook({ id: 'evt_late_1', type: 'payment_intent.succeeded', data: { object: { id: order.stripe_payment_intent_id, metadata: { order_id: String(order.id) } } } });
  await sleep(40);
  const after = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(after.attention, 'paid_after_cancel');
  assert.ok(after.refunded_at);
  assert.deepEqual(stripe.calls.filter((c) => c.method === 'refunds.create').map((c) => c.params.payment_intent), [order.stripe_payment_intent_id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shipments WHERE order_id=?').get(order.id).c, 0);
});

test('without Stripe (demo mode) the sweep just cancels the order', async () => {
  db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,created_at)
    VALUES ('TRV-DEMO99','d@test.local',100,0,0,100,'pending',datetime('now','-2 days'))`).run();
  stripe.reset();
  await sweepUnpaid({ stripe: null });
  assert.equal(db.prepare("SELECT status FROM orders WHERE public_id='TRV-DEMO99'").get().status, 'cancelled');
  assert.equal(stripe.calls.length, 0);
});
