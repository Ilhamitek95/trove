'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// 1×1 transparent PNG — enough to exercise the image pipeline.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let ctx, db, buyerCookie, otherCookie, adminCookie, sellerCookie;
let shopId;

const FORM = { reason: 'damaged', details: 'The handle snapped right off.', images: [PNG] };

/** Create a delivered order; items = [{name, cents}]. Returns { id, itemIds }. */
function mkOrder({ pid, items, delivered, buyer, pi = null }) {
  const subtotal = items.reduce((t, i) => t + i.cents, 0);
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,service_fee_cents,total_cents,status,stripe_payment_intent_id)
    VALUES (?,?,?,?,0,?, 'fulfilled', ?)`).run(pid, buyer, 'amal@test.local', subtotal, subtotal + (subtotal > 20000 ? 0 : 3000), pi).lastInsertRowid;
  const itemIds = items.map((i) =>
    db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,1)')
      .run(id, shopId, i.name, i.cents).lastInsertRowid);
  db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?, 'delivered')").run(id, shopId);
  if (delivered) db.prepare('UPDATE orders SET delivered_at=? WHERE id=?').run(
    db.prepare(`SELECT datetime('now', ?) AS d`).get(delivered).d, id);
  return { id, itemIds };
}

let small, big, stale, undelivered;

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

  // Two items so the partial-return math is visible: 64 + 36 = AED 100 order.
  small       = mkOrder({ pid: 'TRV-RET01', items: [{ name: 'Mug', cents: 6400 }, { name: 'Bowl', cents: 3600 }], delivered: '-2 days',  buyer, pi: 'pi_ret_small' });
  big         = mkOrder({ pid: 'TRV-RET02', items: [{ name: 'Rug', cents: 60000 }],                              delivered: '-5 days',  buyer, pi: 'pi_ret_big' });
  stale       = mkOrder({ pid: 'TRV-RET03', items: [{ name: 'Pot', cents: 5000 }],                               delivered: '-40 days', buyer });
  undelivered = mkOrder({ pid: 'TRV-RET04', items: [{ name: 'Pot', cents: 5000 }],                               delivered: null,       buyer });

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const reqBody = (itemIds, extra = {}) => ({ ...FORM, itemIds, ...extra });

test('eligibility gates: auth, ownership, delivery, the 30-day window, and the form itself', async () => {
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { body: reqBody(small.itemIds) });
  assert.equal(res.status, 401, 'signed out');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: otherCookie, body: reqBody(small.itemIds) });
  assert.equal(res.status, 404, "someone else's order looks like it does not exist");
  res = await ctx.api('POST', '/api/account/orders/TRV-RET04/return-request', { cookie: buyerCookie, body: reqBody(undelivered.itemIds) });
  assert.equal(res.status, 409, 'not delivered yet');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET03/return-request', { cookie: buyerCookie, body: reqBody(stale.itemIds) });
  assert.equal(res.status, 409, '30-day window closed');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody([]) });
  assert.equal(res.status, 400, 'items are required');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody(big.itemIds) });
  assert.equal(res.status, 400, "another order's items are rejected");
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody(small.itemIds, { reason: 'nonsense' }) });
  assert.equal(res.status, 400, 'unknown reason');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody(small.itemIds, { images: [] }) });
  assert.equal(res.status, 400, 'photos are required');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody(small.itemIds, { details: 'x' }) });
  assert.equal(res.status, 400, 'details too short');
});

test('orders payload advertises the pickable items and the fee rule', async () => {
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const s = data.orders.find((o) => o.id === 'TRV-RET01');
  assert.equal(s.returns.eligible, true);
  assert.equal(s.returns.fee, 30, 'AED 200 and below → courier fee deducted');
  assert.equal(s.returns.items.length, 2, 'both items pickable');
  assert.deepEqual(s.returns.items.map((i) => i.price).sort((a, b) => a - b), [36, 64]);
  assert.ok(s.returns.items.every((i) => !i.locked), 'nothing locked yet');
  assert.ok(s.returns.deadline, 'deadline advertised');
  assert.ok(s.items.every((i) => i.orderItemId), 'order lines carry their item ids');
  const b = data.orders.find((o) => o.id === 'TRV-RET02');
  assert.equal(b.returns.fee, 0, 'over AED 200 collects free');
  const st = data.orders.find((o) => o.id === 'TRV-RET03');
  assert.equal(st.returns.eligible, false);
});

test('a valid request locks its items; the same item cannot ride twice', async () => {
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody([small.itemIds[0]]) });
  assert.equal(res.status, 201, res.text);
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody([small.itemIds[0]]) });
  assert.equal(res.status, 409, 'item already in an open request');

  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const o = data.orders.find((x) => x.id === 'TRV-RET01');
  assert.equal(o.returns.eligible, true, 'the other item is still returnable');
  assert.equal(o.returns.items.find((i) => i.name === 'Mug').locked, 'requested');
  assert.equal(o.returns.items.find((i) => i.name === 'Bowl').locked, null);
  assert.equal(o.returns.requests.length, 1);
  assert.equal(o.returns.requests[0].status, 'requested');
  assert.equal(o.returns.requests[0].reasonLabel, 'Arrived damaged');
  assert.equal(o.returns.requests[0].itemsTotal, 64);
  assert.match(o.returns.requests[0].images[0], /^\/uploads\/returns\//);
});

test('the shop sees the request on its order view and in its returns feed', async () => {
  const { data } = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  const row = data.orders.find((r) => r.order.publicId === 'TRV-RET01');
  assert.ok(row.returnRequest, 'return request attached');
  assert.equal(row.returnRequest.status, 'requested');
  assert.equal(row.returnRequest.reason, 'Arrived damaged');
  assert.equal(row.returnRequest.items.length, 1, "only the requested item rides");
  assert.equal(row.returnRequest.items[0].name, 'Mug');
  assert.equal(row.returnRequest.images.length, 1);
  const clean = data.orders.find((r) => r.order.publicId === 'TRV-RET02');
  assert.equal(clean.returnRequest, null);

  const feed = await ctx.api('GET', '/api/seller/returns', { cookie: sellerCookie });
  assert.equal(feed.status, 200);
  const fr = feed.data.returns.find((r) => r.order.publicId === 'TRV-RET01');
  assert.ok(fr, 'request in the returns feed');
  assert.equal(fr.itemsTotal, 64);
  assert.equal(fr.creditImpact, 38.4, 'the AED 38.40 sale credit would reverse');

  const denied = await ctx.api('GET', '/api/seller/returns', { cookie: buyerCookie });
  assert.equal(denied.status, 403, 'sellers only');
});

test('withdrawing a pending request frees its items for a fresh one', async () => {
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const rid = data.orders.find((x) => x.id === 'TRV-RET01').returns.requests[0].id;
  let res = await ctx.api('DELETE', `/api/account/orders/TRV-RET01/return-requests/${rid}`, { cookie: buyerCookie });
  assert.equal(res.status, 200);
  res = await ctx.api('DELETE', `/api/account/orders/TRV-RET01/return-requests/${rid}`, { cookie: buyerCookie });
  assert.equal(res.status, 404, 'nothing left to withdraw');
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody([small.itemIds[0]]) });
  assert.equal(res.status, 201, 're-request allowed after withdrawal');
});

test('approving a partial return refunds those items minus the fee and reverses only their credit', async () => {
  // The shop's credit for the whole order (split(10000).net = 6000) was
  // ALREADY paid out in a settlement run.
  const settlementId = db.prepare("INSERT INTO settlements (run_date, status) VALUES (date('now'), 'paid')").run().lastInsertRowid;
  db.prepare(`INSERT INTO seller_balances (shop_id, order_id, settlement_id, type, amount_cents)
    VALUES (?,?,?, 'credit_sale', ?)`).run(shopId, small.id, settlementId, 6000);

  let res = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const rr = res.data.returns.find((r) => r.order.publicId === 'TRV-RET01' && r.status === 'requested');
  assert.equal(rr.itemsTotal, 64, 'request carries its own items total');
  assert.equal(rr.refundPreview, 34, '64 item − 30 fee');
  assert.equal(rr.feePreview, 30);

  const calls = ctx.stripeMock.calls;
  const before = calls.filter((c) => c.method === 'refunds.create').length;
  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.status, 'approved');
  assert.equal(res.data.request.refund, 34);
  assert.equal(res.data.request.fee, 30);

  const refundCalls = calls.filter((c) => c.method === 'refunds.create');
  assert.equal(refundCalls.length, before + 1, 'one card refund');
  assert.equal(refundCalls[refundCalls.length - 1].params.amount, 3400, 'partial refund, in fils');

  let order = db.prepare('SELECT * FROM orders WHERE id=?').get(small.id);
  assert.equal(order.refunded_at, null, 'one item back ≠ the order refunded');
  let debits = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='debit_refund'").all(small.id);
  assert.equal(debits.length, 1);
  assert.equal(debits[0].amount_cents, -3840, "the Mug's credit share reverses — commission is never refunded");

  // The buyer sends the Bowl back too → second request, second fee, and the
  // order closes out exactly: remaining credit 2160 reverses, order stamps.
  res = await ctx.api('POST', '/api/account/orders/TRV-RET01/return-request', { cookie: buyerCookie, body: reqBody([small.itemIds[1]], { reason: 'changed-mind' }) });
  assert.equal(res.status, 201, res.text);
  const list = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  const rr2 = list.data.returns.find((r) => r.order.publicId === 'TRV-RET01' && r.status === 'requested');
  assert.equal(rr2.refundPreview, 6, '36 item − 30 fee');
  res = await ctx.api('POST', `/api/admin/returns/${rr2.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);

  order = db.prepare('SELECT * FROM orders WHERE id=?').get(small.id);
  assert.ok(order.refunded_at, 'every item back → order stamped refunded');
  debits = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='debit_refund'").all(small.id);
  assert.equal(debits.reduce((t, d) => t + d.amount_cents, 0), -6000, 'debits close the books to the fil');

  res = await ctx.api('POST', `/api/admin/returns/${rr2.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 409, 'no double decisions');
});

test('an unswept credit shrinks in place instead of debiting', async () => {
  const buyer = db.prepare("SELECT id FROM users WHERE email='amal@test.local'").get().id;
  const o = mkOrder({ pid: 'TRV-RET06', items: [{ name: 'Vase', cents: 6400 }], delivered: '-1 days', buyer, pi: 'pi_ret_unswept' });
  db.prepare("INSERT INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?, 'credit_sale', ?)")
    .run(shopId, o.id, 3840);

  let res = await ctx.api('POST', '/api/account/orders/TRV-RET06/return-request', { cookie: buyerCookie, body: reqBody(o.itemIds) });
  assert.equal(res.status, 201, res.text);
  const list = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  const rr = list.data.returns.find((r) => r.order.publicId === 'TRV-RET06');
  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);

  const credit = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='credit_sale'").get(o.id);
  assert.equal(credit.amount_cents, 0, 'unpaid credit reduced to nothing');
  const debit = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='debit_refund'").get(o.id);
  assert.equal(debit, undefined, 'no debit for money that was never paid out');
  assert.ok(db.prepare('SELECT refunded_at FROM orders WHERE id=?').get(o.id).refunded_at, 'single-item order fully refunded');
});

test('a fully-returned order blocks the manual whole-order refund (no double pay-out)', async () => {
  const res = await ctx.api('POST', '/api/admin/orders/TRV-RET06/refund', { cookie: adminCookie });
  assert.equal(res.status, 409);
});

test('orders over AED 200 return free; approval without a PaymentIntent still works (demo mode)', async () => {
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET02/return-request',
    { cookie: buyerCookie, body: reqBody(big.itemIds, { reason: 'changed-mind' }) });
  assert.equal(res.status, 201, res.text);
  // Strip the PaymentIntent to simulate a demo-mode order.
  db.prepare('UPDATE orders SET stripe_payment_intent_id=NULL WHERE id=?').run(big.id);

  const list = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  const rr = list.data.returns.find((r) => r.order.publicId === 'TRV-RET02');
  const before = ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create').length;
  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.fee, 0, 'free return over AED 200');
  assert.equal(res.data.request.refund, 600);
  assert.equal(ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create').length, before, 'no card call without a PaymentIntent');
});

test('declining needs a reason the buyer can read; the item frees up afterwards', async () => {
  const buyer = db.prepare("SELECT id FROM users WHERE email='amal@test.local'").get().id;
  const o = mkOrder({ pid: 'TRV-RET05', items: [{ name: 'Plate', cents: 7000 }], delivered: '-1 days', buyer });
  let res = await ctx.api('POST', '/api/account/orders/TRV-RET05/return-request', { cookie: buyerCookie, body: reqBody(o.itemIds) });
  assert.equal(res.status, 201, res.text);
  const list = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  const rr = list.data.returns.find((r) => r.order.publicId === 'TRV-RET05');

  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/decline`, { cookie: adminCookie, body: { reason: '' } });
  assert.equal(res.status, 400, 'reason required');
  res = await ctx.api('POST', `/api/admin/returns/${rr.id}/decline`, { cookie: adminCookie, body: { reason: 'The photos show wear from use, not a fault.' } });
  assert.equal(res.status, 200);

  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const ord = data.orders.find((x) => x.id === 'TRV-RET05');
  assert.equal(ord.returns.requests[0].status, 'declined');
  assert.match(ord.returns.requests[0].declineReason, /wear from use/);
  assert.equal(ord.returns.items[0].locked, null, 'a declined item can be requested again');
  assert.equal(ord.returns.eligible, true);
  const order = db.prepare('SELECT refunded_at FROM orders WHERE id=?').get(o.id);
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
