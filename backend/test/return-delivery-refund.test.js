'use strict';
/**
 * Owner decisions of 2026-09-30 on returns money:
 *   A) the AED 30 collection fee stays PER RETURN REQUEST, and the buyer
 *      form says so ('send them back together … charged once');
 *   B) the ORIGINAL DELIVERY FEE is refunded when the WHOLE order comes back
 *      for a fault reason — the request that completes the order, when every
 *      returned unit's reason is a fault. Partial returns and any change of
 *      mind keep it. Refunded on top of the items at the card-refund step,
 *      VAT reversed with it, never touching the maker's credit; admin can
 *      override either way.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ VAT_REGISTERED: '1' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let ctx, db, buyerCookie, adminCookie, shopId, buyerId;
let n = 0;

function mkOrder({ lines }) {
  n += 1;
  const pid = `TRV-DLV${n}`;
  const subtotal = lines.reduce((t, l) => t + l.cents * (l.qty || 1), 0);
  const delivery = subtotal > 20000 ? 0 : 3000;
  const total = subtotal + delivery;
  const vat = require('../src/config').vatFromGross(total);
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,service_fee_cents,shipping_cents,total_cents,status,rail,stripe_payment_intent_id,vat_amount_cents,title_transferred_at)
    VALUES (?,?, 'buyer@test.local', ?, 0, ?, ?, 'fulfilled', 'consignment', ?, ?, datetime('now'))`)
    .run(pid, buyerId, subtotal, delivery, total, `pi_${pid}`, vat).lastInsertRowid;
  const itemIds = lines.map((l) => db.prepare(`INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty)
    VALUES (?,?,?,?,?)`).run(id, shopId, l.name, l.cents, l.qty || 1).lastInsertRowid);
  db.prepare("INSERT INTO shipments (order_id,shop_id,status,delivered_at) VALUES (?,?, 'delivered', datetime('now','-2 days'))").run(id, shopId);
  db.prepare("UPDATE orders SET delivered_at=datetime('now','-2 days') WHERE id=?").run(id);
  db.prepare("INSERT INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?, 'credit_sale', ?)").run(shopId, id, require('../src/fees').split(subtotal).net);
  return { id, pid, itemIds, total, vat, delivery };
}
const ask = (pid, body) => ctx.api('POST', `/api/account/orders/${pid}/return-request`, {
  cookie: buyerCookie, body: { details: 'It arrived in pieces, sorry.', images: [PNG], reason: 'damaged', ...body },
});
const adminRow = async (pid) => (await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie })).data.returns
  .find((r) => r.order.publicId === pid && r.status === 'requested');
const approve = async (pid, body = {}) => {
  const row = await adminRow(pid);
  const res = await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie, body });
  assert.equal(res.status, 200, res.text);
  return res.data.request;
};
const collect = (id) => ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: id } });
const refundCalls = () => ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create');
const credit = (orderId) => db.prepare("SELECT amount_cents FROM seller_balances WHERE order_id=? AND type='credit_sale'").get(orderId).amount_cents;
const buyerOrder = async (pid) => (await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie })).data.orders.find((x) => x.id === pid);

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?, 'Buyer','buyer')").run(pw).lastInsertRowid;
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?, 'Boss','admin')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?, 'Pots', 'pots', 'approved')").run(seller).lastInsertRowid;
  buyerCookie = await ctx.loginAs('buyer@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('whole order back for a fault: delivery refunded on top at the card step, VAT reversed on it, maker credit untouched by it', async () => {
  const o = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }, { name: 'Plate', cents: 3000 }] }); // AED 90 + AED 30 delivery
  let res = await ask(o.pid, { itemIds: o.itemIds, reason: 'damaged' });
  assert.equal(res.status, 201, res.text);
  const row = await adminRow(o.pid);
  assert.equal(row.deliveryRule, true);
  assert.equal(row.deliveryPreview, 30);
  assert.equal(row.refundPreview, 120);
  assert.equal(row.order.deliveryPaid, 30);

  const ap = await approve(o.pid);
  assert.equal(ap.deliveryRefund, 30);
  assert.equal(ap.refund, 120);
  const before = refundCalls().length;
  res = await collect(ap.id);
  assert.equal(res.data.request.status, 'refunded');
  assert.equal(refundCalls().length, before + 1);
  assert.equal(refundCalls().at(-1).params.amount, 12000, 'items AED 90 + delivery AED 30, in one card refund');

  const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(ap.id);
  assert.equal(rr.delivery_refund_cents, 3000);
  // VAT was 5/105 of the AED 120 charged; the whole of it reverses.
  assert.equal(rr.vat_reversed_cents, require('../src/config').vatFromGross(12000));
  const ord = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
  assert.equal(ord.vat_reversed_cents, ord.vat_amount_cents);
  assert.equal(rr.credit_note_ref, `CN-${o.pid}-R${ap.id}`);
  // The maker's credit reverses by the items only — never below zero.
  assert.equal(credit(o.id), 0);
  assert.ok(ord.refunded_at, 'the order is fully refunded');

  // The buyer's account shows it.
  const q = (await buyerOrder(o.pid)).returns.requests[0];
  assert.equal(q.deliveryRefund, 30);
  assert.equal(q.refund, 120);
});

test('a partial fault return keeps the delivery; the fault request that completes the order refunds it, once', async () => {
  const o = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }, { name: 'Plate', cents: 3000 }] });
  // Before anything goes back, the buyer's picker is told what a whole-order fault return would add.
  assert.equal((await buyerOrder(o.pid)).returns.wholeOrderFaultDelivery, 30);

  await ask(o.pid, { itemIds: [o.itemIds[0]], reason: 'damaged' });
  let ap = await approve(o.pid);
  assert.equal(ap.deliveryRefund, 0, 'the plate is still with the buyer');
  assert.equal(ap.refund, 60);
  await collect(ap.id);

  await ask(o.pid, { itemIds: [o.itemIds[1]], reason: 'wrong-item' });
  const row = await adminRow(o.pid);
  assert.equal(row.deliveryPreview, 30, 'this request completes the order, all for faults');
  ap = await approve(o.pid);
  assert.equal(ap.deliveryRefund, 30);
  assert.equal(ap.refund, 60);
  await collect(ap.id);
  assert.equal(refundCalls().at(-1).params.amount, 6000);
  const total = db.prepare("SELECT SUM(refund_cents) AS s FROM return_requests WHERE order_id=? AND status='refunded'").get(o.id).s;
  assert.equal(total, o.total, 'everything the buyer paid, and not a fil more');
});

test('units: 1 of 2 identical mugs is partial; the second unit back for a fault completes the order', async () => {
  const o = mkOrder({ lines: [{ name: 'Mug', cents: 4000, qty: 2 }] });
  await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 1 }] });
  let ap = await approve(o.pid);
  assert.equal(ap.deliveryRefund, 0);
  await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 1 }], reason: 'not-as-described' });
  ap = await approve(o.pid);
  assert.equal(ap.deliveryRefund, 30);
});

test('any change of mind in the whole order keeps the delivery fee', async () => {
  // Whole order, change of mind: fee charged, delivery kept.
  const a = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }] });
  await ask(a.pid, { itemIds: a.itemIds, reason: 'changed-mind' });
  let ap = await approve(a.pid);
  assert.equal(ap.deliveryRefund, 0);
  assert.equal(ap.fee, 30);
  assert.equal(ap.refund, 30);

  // First piece back as a change of mind, the rest for a fault: not every
  // returned unit is a fault, so the completing request keeps the delivery.
  const b = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }, { name: 'Plate', cents: 3000 }] });
  await ask(b.pid, { itemIds: [b.itemIds[0]], reason: 'changed-mind' });
  await approve(b.pid);
  assert.equal((await buyerOrder(b.pid)).returns.wholeOrderFaultDelivery, 0, 'the picker no longer offers it');
  await ask(b.pid, { itemIds: [b.itemIds[1]], reason: 'damaged' });
  const row = await adminRow(b.pid);
  assert.equal(row.deliveryRule, false);
  ap = await approve(b.pid);
  assert.equal(ap.deliveryRefund, 0);
  assert.equal(ap.refund, 30);

  // A declined change-of-mind request does not count against the rule.
  const c = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }] });
  await ask(c.pid, { itemIds: c.itemIds, reason: 'changed-mind' });
  const r0 = await adminRow(c.pid);
  await ctx.api('POST', `/api/admin/returns/${r0.id}/decline`, { cookie: adminCookie, body: { reason: 'Outside the policy, sorry' } });
  await ask(c.pid, { itemIds: c.itemIds, reason: 'damaged' });
  ap = await approve(c.pid);
  assert.equal(ap.deliveryRefund, 30);
});

test('no delivery paid (order over AED 200) → nothing extra to refund', async () => {
  const o = mkOrder({ lines: [{ name: 'Rug', cents: 25000 }] });
  await ask(o.pid, { itemIds: o.itemIds, reason: 'damaged' });
  const row = await adminRow(o.pid);
  assert.equal(row.deliveryPreview, 0);
  assert.equal(row.deliveryIfRefunded, 0);
  const ap = await approve(o.pid);
  assert.equal(ap.deliveryRefund, 0);
  assert.equal(ap.refund, 250);
});

test('admin override: keep it on a whole-order fault, give it on a partial, never twice', async () => {
  const a = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }] });
  await ask(a.pid, { itemIds: a.itemIds });
  let ap = await approve(a.pid, { refundDelivery: false });
  assert.equal(ap.deliveryRefund, 0);
  assert.equal(ap.deliveryOverride, false);
  assert.equal(ap.refund, 60);

  const b = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }, { name: 'Plate', cents: 3000 }] });
  await ask(b.pid, { itemIds: [b.itemIds[0]] });
  const row = await adminRow(b.pid);
  assert.equal(row.deliveryRule, false);
  assert.equal(row.deliveryIfRefunded, 30, 'the override would give back AED 30');
  ap = await approve(b.pid, { refundDelivery: true });
  assert.equal(ap.deliveryRefund, 30);
  assert.equal(ap.deliveryOverride, true);
  assert.equal(ap.refund, 90);
  // The rest follows for a fault: the delivery already went back.
  await ask(b.pid, { itemIds: [b.itemIds[1]] });
  ap = await approve(b.pid, { refundDelivery: true });
  assert.equal(ap.deliveryRefund, 0, 'the delivery fee is refunded at most once per order');
  assert.equal(ap.refund, 30);
});

test('charging the collection fee on a fault claim drops the delivery refund unless the admin asks for it', async () => {
  const a = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }] });
  await ask(a.pid, { itemIds: a.itemIds });
  let ap = await approve(a.pid, { chargeFee: true });
  assert.equal(ap.fee, 30);
  assert.equal(ap.deliveryRefund, 0);
  assert.equal(ap.refund, 30);

  const b = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }] });
  await ask(b.pid, { itemIds: b.itemIds });
  ap = await approve(b.pid, { chargeFee: true, refundDelivery: true });
  assert.equal(ap.refund, 60, '60 − 30 fee + 30 delivery');
});

test('the refund emails say the delivery came back', () => {
  const email = require('../src/email');
  const order = { public_id: 'TRV-X9' };
  const items = [{ name: 'Bowl', qty: 1, price_cents: 6000 }];
  const money = { gross: 6000, fee: 0, delivery: 3000, refund: 9000 };
  assert.match(email.returnRefunded({ order, items, money }).html, /including your AED 30 delivery/);
  assert.match(email.returnApproved({ order, items, money }).html, /including your AED 30 delivery/);
  assert.match(email.returnRequested({ order, items, money, reasonLabel: 'Faulty or damaged' }).html, /includes your AED 30 delivery/);
  const none = email.returnRefunded({ order, items, money: { gross: 6000, fee: 0, delivery: 0, refund: 6000 } });
  assert.doesNotMatch(none.html, /delivery\)/);
  assert.doesNotMatch(email.returnRequested({ order, items, money: { gross: 6000, fee: 0, delivery: 0, refund: 6000 }, reasonLabel: 'x' }).html, /isn't refundable/);
});

test('A: the collection fee is per return request, and the buyer form says to send pieces together', async () => {
  const o = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }, { name: 'Plate', cents: 3000 }] });
  const r = (await buyerOrder(o.pid)).returns;
  assert.equal(r.fee, 30, 'the amount the form shows comes from the server (fees.js)');
  // Two separate change-of-mind requests pay the fee twice …
  await ask(o.pid, { itemIds: [o.itemIds[0]], reason: 'changed-mind' });
  const a = await approve(o.pid);
  await ask(o.pid, { itemIds: [o.itemIds[1]], reason: 'changed-mind' });
  const b = await approve(o.pid);
  assert.equal(a.fee + b.fee, 60);
  // … which is why the form tells the buyer to send them together.
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-account.html'), 'utf8');
  assert.match(html, /Returning more than one piece\?<\/b> Send them back together and the \{amount\} collection fee is charged once\.',\{amount:aed\(r\.fee\)\}/);
  // Only when it could apply: a fee on the order, change of mind (or no reason yet), more than one piece.
  assert.match(html, /const together=r\.fee>0&&\(!reason\|\|reason==='changed-mind'\)&&units>1/);
});
