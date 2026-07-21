'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// 1×1 transparent PNG — enough to exercise the image pipeline.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let ctx, db, buyerCookie, otherCookie, adminCookie, sellerCookie;
let shopId;
let smallOrderId, bigOrderId, undeliveredId, staleId;

const REQ = { reason: 'damaged', details: 'The handle snapped right off.', images: [PNG] };

function mkOrder({ pid, subtotal, delivered, buyer, pi = null }) {
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,service_fee_cents,total_cents,status,stripe_payment_intent_id)
    VALUES (?,?,?,?,900,?, 'fulfilled', ?)`).run(pid, buyer, 'amal@test.local', subtotal, subtotal + 900 + 2500, pi).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,1)')
    .run(id, shopId, 'Mug', subtotal);
  db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?, 'delivered')").run(id, shopId);
  if (delivered) db.prepare('UPDATE orders SET delivered_at=? WHERE id=?').run(
    db.prepare(`SELECT datetime('now', ?) AS d`).get(delivered).d, id);
  return id;
}

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  const buyer = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal Rashid','buyer')").run(pw).lastInsertRowid;
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('other@test.local',?, 'Other Person','buyer')").run(pw);
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?, 'Boss','admin')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;

  smallOrderId  = mkOrder({ pid: 'TRV-RET01', subtotal: 6400,  delivered: '-2 days',  buyer, pi: 'pi_ret_small' });
  bigOrderId    = mkOrder({ pid: 'TRV-RET02', subtotal: 60000, delivered: '-5 days',  buyer, pi: 'pi_ret_big' });
  staleId       = mkOrder({ pid: 'TRV-RET03', subtotal: 5000,  delivered: '-40 days', buyer });
  undeliveredId = mkOrder({ pid: 'TRV-RET04', subtotal: 5000,  delivered: null,       buyer });

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('eligibility gates: auth, ownership, delivery, the 30-day window, and the form itself', async () => {
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { body: REQ });
  assert.equal(res.status, 401, 'signed out');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: otherCookie, body: REQ });
  assert.equal(res.status, 404, "someone else's order looks like it does not exist");
  res = await ctx.api('POST', '/api/account/orders/TRV-RET04/return-request', { cookie: buyerCookie, body: REQ });
  assert.equal(res.status, 409, 'not delivered yet');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET03/return-request', { cookie: buyerCookie, body: REQ });
  assert.equal(res.status, 409, '30-day window closed');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: { ...REQ, reason: 'nonsense' } });
  assert.equal(res.status, 400, 'unknown reason');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: { ...REQ, images: [] } });
  assert.equal(res.status, 400, 'photos are required');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: { ...REQ, details: 'x' } });
  assert.equal(res.status, 400, 'details too short');
});

test('orders payload advertises eligibility and the exact money outcome', async () => {
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const small = data.orders.find((o) => o.id === 'TRV-RET01');
  assert.equal(small.returns.eligible, true);
  assert.equal(small.returns.fee, 25, 'under AED 500 → courier fee deducted');
  assert.equal(small.returns.refund, 39, '64 items − 25 fee');
  assert.ok(small.returns.deadline, 'deadline advertised');
  const big = data.orders.find((o) => o.id === 'TRV-RET02');
  assert.equal(big.returns.fee, 0, 'AED 500+ returns are free');
  assert.equal(big.returns.refund, 600);
  const stale = data.orders.find((o) => o.id === 'TRV-RET03');
  assert.equal(stale.returns.eligible, false);
});

test('a valid request is created once, with photos stored under /uploads/returns', async () => {
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: REQ });
  assert.equal(res.status, 201, res.text);
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: REQ });
  assert.equal(res.status, 409, 'no duplicate requests');

  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const o = data.orders.find((x) => x.id === 'TRV-RET01');
  assert.equal(o.returns.eligible, false, 'no longer eligible while a request exists');
  assert.equal(o.returns.request.status, 'requested');
  assert.equal(o.returns.request.reasonLabel, 'Arrived damaged');
  assert.match(o.returns.request.images[0], /^\/uploads\/returns\//);
});

test('the shop sees the request on its order view', async () => {
  const { data } = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  const row = data.orders.find((r) => r.order.publicId === 'TRV-RET01');
  assert.ok(row.returnRequest, 'return request attached');
  assert.equal(row.returnRequest.status, 'requested');
  assert.equal(row.returnRequest.reason, 'Arrived damaged');
  assert.equal(row.returnRequest.images.length, 1);
  const clean = data.orders.find((r) => r.order.publicId === 'TRV-RET02');
  assert.equal(clean.returnRequest, null);
});

test('withdrawing a pending request frees the order for a fresh one', async () => {
  let res = await ctx.api('DELETE', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie });
  assert.equal(res.status, 200);
  res = await ctx.api('DELETE', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie });
  assert.equal(res.status, 404, 'nothing left to withdraw');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: REQ });
  assert.equal(res.status, 201, 're-request allowed after withdrawal');
});

test('admin approval refunds items minus the fee, stamps the order, reverses settled credits', async () => {
  // Give the shop a credit for the small order that was ALREADY paid out.
  const settlementId = db.prepare("INSERT INTO settlements (run_date, status) VALUES (date('now'), 'paid')").run().lastInsertRowid;
  db.prepare(`INSERT INTO seller_balances (shop_id, order_id, settlement_id, type, amount_cents)
    VALUES (?,?,?, 'credit_sale', ?)`).run(shopId, smallOrderId, settlementId, 5120);

  let res = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const rr = res.data.returns.find((r) => r.order.publicId === 'TRV-RET01');
  assert.equal(rr.refundPreview, 39);
  assert.equal(rr.feePreview, 25);

  const calls = ctx.stripeMock.calls;
  const beforeCalls = calls.filter((c) => c.method === 'refunds.create').length;
  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.status, 'approved');
  assert.equal(res.data.request.refund, 39);
  assert.equal(res.data.request.fee, 25);

  const refundCalls = calls.filter((c) => c.method === 'refunds.create');
  assert.equal(refundCalls.length, beforeCalls + 1, 'one card refund');
  assert.equal(refundCalls[refundCalls.length - 1].params.amount, 3900, 'partial refund, in fils');

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(smallOrderId);
  assert.ok(order.refunded_at, 'order stamped refunded');
  const debit = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='debit_refund'").get(smallOrderId);
  assert.ok(debit, 'paid-out credit mirrored with a debit');
  assert.equal(debit.amount_cents, -5120, 'full supplier credit reversed — commission is never refunded');

  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 409, 'no double decisions');
});

test('AED 500+ orders return free; approval without a PaymentIntent still works (demo mode)', async () => {
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET02/return-request',
    { cookie: buyerCookie, body: { ...REQ, reason: 'changed-mind' } });
  assert.equal(res.status, 201, res.text);
  // Strip the PaymentIntent to simulate a demo-mode order.
  db.prepare('UPDATE orders SET stripe_payment_intent_id=NULL WHERE id=?').run(bigOrderId);

  const list = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  const rr = list.data.returns.find((r) => r.order.publicId === 'TRV-RET02');
  const before = ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create').length;
  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.fee, 0, 'free return at AED 500+');
  assert.equal(res.data.request.refund, 600);
  assert.equal(ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create').length, before, 'no card call without a PaymentIntent');
});

test('declining needs a reason the buyer can read', async () => {
  const oid = mkOrder({ pid: 'TRV-RET05', subtotal: 7000, delivered: '-1 days',
    buyer: db.prepare("SELECT id FROM users WHERE email='amal@test.local'").get().id });
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET05/return-request', { cookie: buyerCookie, body: REQ });
  assert.equal(res.status, 201, res.text);
  const list = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  const rr = list.data.returns.find((r) => r.order.publicId === 'TRV-RET05');

  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/decline`, { cookie: adminCookie, body: { reason: '' } });
  assert.equal(res.status, 400, 'reason required');
  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/decline`, { cookie: adminCookie, body: { reason: 'The photos show wear from use, not a fault.' } });
  assert.equal(res.status, 200);

  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const o = data.orders.find((x) => x.id === 'TRV-RET05');
  assert.equal(o.returns.request.status, 'declined');
  assert.match(o.returns.request.declineReason, /wear from use/);
  const order = db.prepare('SELECT refunded_at FROM orders WHERE id=?').get(oid);
  assert.equal(order.refunded_at, null, 'declined return refunds nothing');

  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 409, 'declined is final');
});

test('admin endpoints are admin-only', async () => {
  let res = await ctx.api('GET', '/api/admin/returns', { cookie: buyerCookie });
  assert.equal(res.status, 403);
  res = await ctx.api('POST', '/api/admin/returns/1/approve', {});
  assert.equal(res.status, 401);
});
