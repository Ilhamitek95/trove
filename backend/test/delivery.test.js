'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db;
let shopId, productId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkPaidWebhookOrder(pid, pi) {
  const orderId = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES (?,?,20000,2500,900,23400,'pending','consignment',?)`).run(pid, 'buyer@test.local', pi).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)')
    .run(orderId, productId, shopId, 'Vase');
  return orderId;
}

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')")
    .run(uid, 'Test Pots', 'test-pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,50,'live')")
    .run(shopId, 'Vase', 'Ceramics').lastInsertRowid;
});
after(async () => { await ctx.close(); });

test('payment books a mock pickup: shipment gets delivery_ref + carrier', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL01', 'pi_del_1');
  await ctx.postWebhook({ id: 'evt_del_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_1', metadata: { order_id: String(oid) } } } });
  await sleep(80); // booking is fire-and-forget after the payment transaction
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  assert.ok(sh, 'shipment created');
  assert.match(sh.delivery_ref, /^QMOCK-/);
  assert.equal(sh.carrier, 'Quiqup');
});

test('mock deliver endpoint stamps delivered + 7-day return window, idempotently', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL02', 'pi_del_2');
  await ctx.postWebhook({ id: 'evt_del_2', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_2', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);

  const r1 = await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });
  assert.equal(r1.status, 200, r1.text);
  const after1 = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(after1.status, 'delivered');
  assert.ok(after1.delivered_at);
  assert.ok(after1.return_window_ends_at > after1.delivered_at);

  // Second confirmation: no re-stamp, no window extension, no duplicate event.
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });
  const after2 = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(after2.delivered_at, after1.delivered_at);
  assert.equal(after2.return_window_ends_at, after1.return_window_ends_at);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND status='delivered'").get(sh.id).n, 1);

  // Single-shipment order → order fulfilled with order-level stamps.
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
  assert.equal(order.status, 'fulfilled');
  assert.ok(order.delivered_at);
  assert.ok(order.return_window_ends_at);
});

test('courier webhook by job reference marks delivered', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL03', 'pi_del_3');
  await ctx.postWebhook({ id: 'evt_del_3', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_3', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);

  const res = await ctx.api('POST', '/api/delivery/webhook', { body: { ref: sh.delivery_ref, event: 'delivered' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { received: true, matched: true });
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'delivered');
});

test('seller can undo an unsettled delivery; stamps clear and order reverts', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL04', 'pi_del_4');
  await ctx.postWebhook({ id: 'evt_del_4', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_4', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });

  const cookie = await ctx.loginAs('maker@test.local', 'testpass123');
  const undo = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'out_for_delivery' } });
  assert.equal(undo.status, 200, undo.text);

  const after = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(after.status, 'out_for_delivery');
  assert.equal(after.delivered_at, null);
  assert.equal(after.return_window_ends_at, null);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
  assert.equal(order.status, 'paid');
  assert.equal(order.delivered_at, null);
});

test('undo is blocked once the credit is swept into a settlement (409)', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL05', 'pi_del_5');
  await ctx.postWebhook({ id: 'evt_del_5', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_5', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });

  // Simulate the settlement sweep (the engine lands in the next workstream).
  const sid = db.prepare("INSERT INTO settlements (run_date) VALUES (date('now'))").run().lastInsertRowid;
  db.prepare("UPDATE seller_balances SET settlement_id=? WHERE order_id=? AND type='credit_sale'").run(sid, oid);

  const cookie = await ctx.loginAs('maker@test.local', 'testpass123');
  const undo = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'shipped' } });
  assert.equal(undo.status, 409);
  assert.match(undo.data.error, /settlement/i);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'delivered');
});
