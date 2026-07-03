'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db;
let shopId, productId, orderId;

function fixtures() {
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')")
    .run(uid, 'Test Pots', 'test-pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?, 'live')")
    .run(shopId, 'Vase', 'Ceramics', 20000, 5).lastInsertRowid;
  // Pending order exactly as checkout would write it: 200 item + 9 service + 25 delivery.
  orderId = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-TEST01','buyer@test.local',20000,2500,900,23400,'pending','consignment','pi_test_1')`).run().lastInsertRowid;
  db.prepare("INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,1)")
    .run(orderId, productId, shopId, 'Vase', 20000);
}

const paidEvent = (eventId) => ({
  id: eventId,
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test_1', metadata: { order_id: String(orderId) } } },
});

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  fixtures();
});
after(async () => { await ctx.close(); });

test('payment success: order paid, title transferred, supplier credited at 20%', async () => {
  const res = await ctx.postWebhook(paidEvent('evt_pay_1'));
  assert.equal(res.status, 200);

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  assert.equal(order.status, 'paid');
  assert.ok(order.title_transferred_at, 'title_transferred_at must be stamped');
  assert.equal(order.vat_amount_cents, 0, 'VAT off by default');

  const credits = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='credit_sale'").all(orderId);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount_cents, 16000); // 20000 − 20%
  assert.equal(credits[0].shop_id, shopId);

  assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipments WHERE order_id=?').get(orderId).n, 1);
});

test('webhook idempotency: redelivered event changes nothing', async () => {
  const res = await ctx.postWebhook(paidEvent('evt_pay_1'));
  assert.equal(res.status, 200);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seller_balances WHERE order_id=?").get(orderId).n, 1);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipments WHERE order_id=?').get(orderId).n, 1);
});

test('a NEW event id for an already-paid order is also a no-op (status guard)', async () => {
  const res = await ctx.postWebhook(paidEvent('evt_pay_2'));
  assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seller_balances WHERE order_id=?").get(orderId).n, 1);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock, 4);
});

test('VAT capture when registered: consignment rail stores 5/105 of the total', async () => {
  process.env.VAT_REGISTERED = '1';
  const oid2 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-TEST02','buyer@test.local',20000,2500,900,23400,'pending','consignment','pi_test_2')`).run().lastInsertRowid;
  db.prepare("INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,1)")
    .run(oid2, productId, shopId, 'Vase', 20000);
  await ctx.postWebhook({ id: 'evt_vat_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test_2', metadata: { order_id: String(oid2) } } } });
  const o = db.prepare('SELECT vat_amount_cents FROM orders WHERE id=?').get(oid2);
  assert.equal(o.vat_amount_cents, 1114); // round(23400 × 5/105)
  delete process.env.VAT_REGISTERED;
});
