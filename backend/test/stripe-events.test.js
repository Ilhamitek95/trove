'use strict';
/**
 * F038: card disputes and refunds made straight in the Stripe dashboard.
 * A dispute holds the order's maker credits from settlement and emails the
 * admin with the deadline; won lifts the hold, lost books the order as
 * refunded. A refund Trove did not make is spotted on charge.refunded: all
 * of what is still paid → booked as refunded; part of it → held for a person.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, shopId, productId, makerId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paidOrder(pid, pi, { delivered = false } = {}) {
  // A shop of its own per order, so the settlement preview speaks for this order only.
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(makerId, `Lamp Co ${pid}`, `lamp-${pid.toLowerCase()}`).lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,30000,50,'live')").run(shopId, 'Lamp', 'Lighting').lastInsertRowid;
  const oid = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES (?,?,30000,0,0,30000,'pending','consignment',?)`).run(pid, 'buyer@test.local', pi).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,30000,1)').run(oid, productId, shopId, 'Lamp');
  await ctx.postWebhook({ id: 'evt_' + pi, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(oid) } } } });
  await sleep(50);
  if (delivered) {
    const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
    await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });
    db.prepare("UPDATE shipments SET return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(sh.id);
    db.prepare("UPDATE orders SET return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(oid);
  }
  return oid;
}
const inPreview = async (oid) => {
  const p = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  return [...p.data.eligible, ...p.data.excluded].some((x) => x.shopId === shopId && x.creditCents > 0);
};
const order = (oid) => db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
const dispute = (id, pi, status, extra = {}) => ({ id, payment_intent: pi, amount: 30000, reason: 'fraudulent', status, evidence_details: { due_by: 1790000000 }, ...extra });

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(pw);
  makerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('a dispute holds the makers’ credit and flags the order; won lifts the hold', async () => {
  const oid = await paidOrder('TRV-SE01', 'pi_se_1', { delivered: true });
  assert.equal(await inPreview(oid), true, 'payable before the dispute');

  let r = await ctx.postWebhook({ id: 'evt_dp_1', type: 'charge.dispute.created', data: { object: dispute('dp_1', 'pi_se_1', 'needs_response') } });
  assert.equal(r.status, 200);
  let o = order(oid);
  assert.equal(o.hold_reason, 'dispute');
  assert.equal(o.attention, 'dispute');
  assert.ok(o.dispute_due_by);
  assert.equal(await inPreview(oid), false, 'held from settlement');
  r = await ctx.postWebhook({ id: 'evt_dp_1', type: 'charge.dispute.created', data: { object: dispute('dp_1', 'pi_se_1', 'needs_response') } });
  assert.equal(r.data.duplicate, true, 'a redelivered event is applied once');

  const list = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  const row = list.data.orders.find((x) => x.publicId === 'TRV-SE01');
  assert.equal(row.hold, 'dispute');
  assert.ok(row.dispute.dueBy);
  assert.equal((await ctx.api('POST', '/api/admin/orders/TRV-SE01/release-hold', { cookie: adminCookie })).status, 409, 'not while the dispute is open');

  await ctx.postWebhook({ id: 'evt_dp_1c', type: 'charge.dispute.closed', data: { object: dispute('dp_1', 'pi_se_1', 'won') } });
  o = order(oid);
  assert.equal(o.hold_reason, '');
  assert.equal(o.attention, '');
  assert.equal(o.refunded_at, null);
  assert.equal(await inPreview(oid), true);
});

test('a lost dispute books the order as refunded — the credit never pays, no return collection is booked', async () => {
  const oid = await paidOrder('TRV-SE02', 'pi_se_2', { delivered: true });
  await ctx.postWebhook({ id: 'evt_dp_2', type: 'charge.dispute.created', data: { object: dispute('dp_2', 'pi_se_2', 'needs_response') } });
  await ctx.postWebhook({ id: 'evt_dp_2c', type: 'charge.dispute.closed', data: { object: dispute('dp_2', 'pi_se_2', 'lost') } });
  const o = order(oid);
  assert.ok(o.refunded_at);
  assert.equal(o.attention, 'dispute_lost');
  assert.equal(await inPreview(oid), false);
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  assert.ok(!db.prepare("SELECT 1 FROM shipment_events WHERE shipment_id=? AND note LIKE 'Return pickup booked%'").get(sh.id));
});

test('charge.refunded: Trove’s own refunds are not external', async () => {
  const oid = await paidOrder('TRV-SE03', 'pi_se_3');
  const r = await ctx.api('POST', '/api/admin/orders/TRV-SE03/refund', { cookie: adminCookie });
  assert.equal(r.status, 200);
  await ctx.postWebhook({ id: 'evt_cr_3', type: 'charge.refunded', data: { object: { id: 'ch_3', payment_intent: 'pi_se_3', amount: 30000, amount_refunded: 30000, refunded: true } } });
  assert.equal(order(oid).external_refund_cents, 0);
});

test('a part refund made in the Stripe dashboard holds the order for a person; release-hold frees it', async () => {
  const oid = await paidOrder('TRV-SE04', 'pi_se_4', { delivered: true });
  ctx.stripeMock.addExternalRefund('pi_se_4', 10000);
  await ctx.postWebhook({ id: 'evt_cr_4', type: 'charge.refunded', data: { object: { id: 'ch_4', payment_intent: 'pi_se_4', amount: 30000, amount_refunded: 10000, refunded: false } } });
  let o = order(oid);
  assert.equal(o.external_refund_cents, 10000);
  assert.equal(o.hold_reason, 'external_refund');
  assert.equal(o.refunded_at, null);
  assert.equal(await inPreview(oid), false);
  assert.equal((await ctx.api('POST', '/api/admin/orders/TRV-SE04/release-hold', { cookie: adminCookie })).status, 200);
  o = order(oid);
  assert.equal(o.hold_reason, '');
  assert.equal(await inPreview(oid), true);
});

test('a full refund made in the Stripe dashboard books the order as refunded and stops the unsent parcel', async () => {
  const oid = await paidOrder('TRV-SE05', 'pi_se_5');
  ctx.stripeMock.addExternalRefund('pi_se_5', 30000);
  await ctx.postWebhook({ id: 'evt_cr_5', type: 'charge.refunded', data: { object: { id: 'ch_5', payment_intent: 'pi_se_5', amount: 30000, amount_refunded: 30000, refunded: true } } });
  await sleep(30);
  const o = order(oid);
  assert.ok(o.refunded_at);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE order_id=?').get(oid).status, 'cancelled');
  assert.equal(await inPreview(oid), false);
});
