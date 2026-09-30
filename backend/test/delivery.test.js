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
    VALUES (?,?,20000,3000,0,23000,'pending','consignment',?)`).run(pid, 'buyer@test.local', pi).lastInsertRowid;
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

// Undo is a manual-shipment feature: a parcel with no courier booking is the
// maker's to step (a courier-booked one is the courier's — see below).
const unbook = (id) => db.prepare("UPDATE shipments SET delivery_ref='' WHERE id=?").run(id);

test('seller can undo an unsettled delivery; stamps clear and order reverts', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL04', 'pi_del_4');
  await ctx.postWebhook({ id: 'evt_del_4', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_4', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  unbook(sh.id);
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
  unbook(sh.id);
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

test('courier-booked parcel: the shop can only mark it packed (or step that back) and cannot touch courier or tracking', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL06', 'pi_del_6');
  await ctx.postWebhook({ id: 'evt_del_6', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_6', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  assert.ok(sh.delivery_ref);
  const cookie = await ctx.loginAs('maker@test.local', 'testpass123');
  const patch = (body) => ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body });

  for (const status of ['delivered', 'out_for_delivery']) {
    const r = await patch({ status });
    assert.equal(r.status, 400, status);
    assert.equal(r.data.code, 'courier_managed');
  }
  let r = await patch({ carrier: 'Seller Own Van' });
  assert.equal(r.status, 400);
  r = await patch({ trackingNumber: 'FAKE-1' });
  assert.equal(r.status, 400);
  r = await patch({ trackingUrl: 'https://evil.example/track' });
  assert.equal(r.status, 400);
  const still = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(still.status, 'processing');
  assert.equal(still.delivered_at, null);
  assert.equal(still.return_window_ends_at, null);
  assert.equal(still.carrier, sh.carrier);

  // Packed, sending the unchanged courier fields the dashboard always sends: fine.
  r = await patch({ status: 'shipped', carrier: sh.carrier, trackingNumber: sh.tracking_number, trackingUrl: sh.tracking_url });
  assert.equal(r.status, 200, r.text);
  r = await patch({ status: 'processing' });
  assert.equal(r.status, 200, 'stepping packed back is allowed');

  // Once the courier has it out for delivery, the shop can't pull it back.
  await ctx.api('POST', '/api/delivery/webhook', { body: { ref: sh.delivery_ref, event: 'out_for_delivery' } });
  r = await patch({ status: 'shipped' });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'out_for_delivery');
});

test('courier-booked parcel: an admin in shop view can still correct it', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL07', 'pi_del_7');
  await ctx.postWebhook({ id: 'evt_del_7', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_7', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('adm-del@test.local',?,'A','admin')").run(hashPassword('adminpass123'));
  const adminCookie = await ctx.loginAs('adm-del@test.local', 'adminpass123');
  const imp = await ctx.api('POST', `/api/admin/impersonate/${shopId}`, { cookie: adminCookie });
  assert.equal(imp.status, 200);
  const cookie = (imp.headers.get('set-cookie') || '').split(';')[0];
  const r = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'delivered' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'delivered');
});

test('a shipment without a courier booking keeps the manual stepper, delivered included', async () => {
  const oid = mkPaidWebhookOrder('TRV-DEL08', 'pi_del_8');
  await ctx.postWebhook({ id: 'evt_del_8', type: 'payment_intent.succeeded', data: { object: { id: 'pi_del_8', metadata: { order_id: String(oid) } } } });
  await sleep(80);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  unbook(sh.id);
  const cookie = await ctx.loginAs('maker@test.local', 'testpass123');
  const r = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'delivered', carrier: 'Own van' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'delivered');
});
