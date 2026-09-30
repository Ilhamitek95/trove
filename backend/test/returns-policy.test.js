'use strict';
/**
 * The 2026-09-30 returns policy: 15-day window, reason-based collection fee
 * with an admin override, the personalised-piece rule, unit-level returns,
 * refund on courier collection (with a 'refund now' override), and VAT
 * reversal with a credit-note reference.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ VAT_REGISTERED: '1' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let ctx, db, buyerCookie, adminCookie, shopId, buyerId;
let n = 0;

/** A delivered order. lines = [{ name, cents (unit), qty, personalization }]. */
function mkOrder({ lines, deliveredDaysAgo = 2, pi = true, credit = true }) {
  n += 1;
  const pid = `TRV-POL${n}`;
  const subtotal = lines.reduce((t, l) => t + l.cents * (l.qty || 1), 0);
  const delivery = subtotal > 20000 ? 0 : 3000;
  const total = subtotal + delivery;
  const vat = require('../src/config').vatFromGross(total);
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,service_fee_cents,shipping_cents,total_cents,status,rail,stripe_payment_intent_id,vat_amount_cents,title_transferred_at)
    VALUES (?,?, 'buyer@test.local', ?, 0, ?, ?, 'fulfilled', 'consignment', ?, ?, datetime('now'))`)
    .run(pid, buyerId, subtotal, delivery, total, pi ? `pi_${pid}` : null, vat).lastInsertRowid;
  const itemIds = lines.map((l) => db.prepare(`INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty,personalization)
    VALUES (?,?,?,?,?,?)`).run(id, shopId, l.name, l.cents, l.qty || 1, l.personalization || '').lastInsertRowid);
  db.prepare("INSERT INTO shipments (order_id,shop_id,status,delivered_at) VALUES (?,?, 'delivered', datetime('now', ?))").run(id, shopId, `-${deliveredDaysAgo} days`);
  db.prepare("UPDATE orders SET delivered_at=datetime('now', ?) WHERE id=?").run(`-${deliveredDaysAgo} days`, id);
  if (credit) db.prepare("INSERT INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?, 'credit_sale', ?)").run(shopId, id, require('../src/fees').split(subtotal).net);
  return { id, pid, itemIds, total, vat };
}
const ask = (pid, body) => ctx.api('POST', `/api/account/orders/${pid}/return-request`, {
  cookie: buyerCookie, body: { details: 'Please take it back, thank you.', images: [PNG], reason: 'changed-mind', ...body },
});
const adminRow = async (pid) => (await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie })).data.returns
  .find((r) => r.order.publicId === pid && r.status === 'requested');
const refundCalls = () => ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create');

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

test('the return window is 15 days from delivery: day 14 open, day 16 closed', async () => {
  const open = mkOrder({ lines: [{ name: 'Cup', cents: 5000 }], deliveredDaysAgo: 14 });
  const closed = mkOrder({ lines: [{ name: 'Cup', cents: 5000 }], deliveredDaysAgo: 16 });
  let res = await ask(closed.pid, { itemIds: closed.itemIds });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /15-day return window/);
  res = await ask(open.pid, { itemIds: open.itemIds });
  assert.equal(res.status, 201, res.text);
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const o = data.orders.find((x) => x.id === open.pid);
  assert.equal(o.returns.windowDays, 15);
  assert.deepEqual(o.returns.reasons.map((r) => r.value), ['changed-mind', 'damaged', 'wrong-item', 'not-as-described']);
});

test('the buyer picks one of four reasons; the old catch-all is gone', async () => {
  const o = mkOrder({ lines: [{ name: 'Cup', cents: 5000 }] });
  const res = await ask(o.pid, { itemIds: o.itemIds, reason: 'other' });
  assert.equal(res.status, 400);
});

test('collection fee: only changed-my-mind at or below AED 200 pays it; faults collect free', async () => {
  for (const [reason, fee] of [['changed-mind', 30], ['damaged', 0], ['wrong-item', 0], ['not-as-described', 0]]) {
    const o = mkOrder({ lines: [{ name: 'Cup', cents: 9000 }] });
    const res = await ask(o.pid, { itemIds: o.itemIds, reason });
    assert.equal(res.status, 201, res.text);
    const row = await adminRow(o.pid);
    assert.equal(row.reason, reason, 'the reason is stored on the request');
    assert.equal(row.feePreview, fee, `${reason} → fee ${fee}`);
    assert.equal(row.refundPreview, 90 - fee);
    assert.equal(row.faultReason, reason !== 'changed-mind');
  }
  // Over the threshold even a change of mind is free.
  const big = mkOrder({ lines: [{ name: 'Rug', cents: 25000 }] });
  await ask(big.pid, { itemIds: big.itemIds });
  assert.equal((await adminRow(big.pid)).feePreview, 0);
});

test('the admin can override the fee decision either way on approval', async () => {
  // Waive a change-of-mind fee.
  const a = mkOrder({ lines: [{ name: 'Cup', cents: 9000 }] });
  await ask(a.pid, { itemIds: a.itemIds, reason: 'changed-mind' });
  let row = await adminRow(a.pid);
  let res = await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie, body: { chargeFee: false } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.fee, 0);
  assert.equal(res.data.request.refund, 90);
  assert.equal(res.data.request.feeOverride, false);
  // Charge one on a 'damaged' claim the photos don't support.
  const b = mkOrder({ lines: [{ name: 'Cup', cents: 9000 }] });
  await ask(b.pid, { itemIds: b.itemIds, reason: 'damaged' });
  row = await adminRow(b.pid);
  res = await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie, body: { chargeFee: true } });
  assert.equal(res.data.request.fee, 30);
  assert.equal(res.data.request.refund, 60);
  assert.equal(res.data.request.feeOverride, true);
  assert.equal(db.prepare('SELECT fee_override FROM return_requests WHERE id=?').get(row.id).fee_override, 1);
});

test('personalised pieces only go back when faulty, wrong or not as described', async () => {
  const o = mkOrder({ lines: [{ name: 'Name mug', cents: 8000, personalization: 'AMAL' }, { name: 'Plain mug', cents: 6000 }] });
  let res = await ask(o.pid, { itemIds: [o.itemIds[0]], reason: 'changed-mind' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Personalised pieces/);
  res = await ask(o.pid, { itemIds: o.itemIds, reason: 'changed-mind' });
  assert.equal(res.status, 400, 'a personalised piece in the mix blocks a change-of-mind return');
  res = await ask(o.pid, { itemIds: [o.itemIds[1]], reason: 'changed-mind' });
  assert.equal(res.status, 201, 'the plain one can still go back');
  res = await ask(o.pid, { itemIds: [o.itemIds[0]], reason: 'not-as-described' });
  assert.equal(res.status, 201, res.text);
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const item = data.orders.find((x) => x.id === o.pid).returns.items.find((i) => i.name === 'Name mug');
  assert.equal(item.personalised, true);
});

test('partial units: 1 of 2 identical mugs goes back, money proportional, the other can follow', async () => {
  // One line, qty 2 at AED 125 each = AED 250 (free collection over AED 200).
  const o = mkOrder({ lines: [{ name: 'Mug', cents: 12500, qty: 2 }] });
  let res = await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 3 }] });
  assert.equal(res.status, 409, 'only 2 on the line');
  res = await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 0 }] });
  assert.equal(res.status, 400);
  res = await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 1 }] });
  assert.equal(res.status, 201, res.text);

  let { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  let line = data.orders.find((x) => x.id === o.pid).returns.items[0];
  assert.equal(line.qty, 2);
  assert.equal(line.available, 1, 'one unit is still free');
  assert.equal(line.locked, null);

  const row = await adminRow(o.pid);
  assert.equal(row.itemsTotal, 125);
  assert.equal(row.items[0].qty, 1);
  assert.equal(row.items[0].lineQty, 2);
  assert.equal(row.refundPreview, 125);
  await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie });
  res = await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: row.id } });
  assert.equal(res.data.request.status, 'refunded');
  assert.equal(refundCalls().at(-1).params.amount, 12500, 'one unit refunded');
  // Credit was split(25000).net = 15000 (unswept) → shrinks by split(12500).net = 7500.
  const credit = () => db.prepare("SELECT amount_cents FROM seller_balances WHERE order_id=? AND type='credit_sale'").get(o.id).amount_cents;
  assert.equal(credit(), 7500);
  assert.equal(db.prepare('SELECT refunded_at FROM orders WHERE id=?').get(o.id).refunded_at, null, 'one unit is still with the buyer');

  // The second unit follows: books close to zero, order stamped refunded.
  res = await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 1 }] });
  assert.equal(res.status, 201, res.text);
  res = await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 1 }] });
  assert.equal(res.status, 409, 'no units left');
  const row2 = await adminRow(o.pid);
  await ctx.api('POST', `/api/admin/returns/${row2.id}/approve`, { cookie: adminCookie });
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: row2.id } });
  assert.equal(credit(), 0);
  assert.ok(db.prepare('SELECT refunded_at FROM orders WHERE id=?').get(o.id).refunded_at);
  ({ data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie }));
  line = data.orders.find((x) => x.id === o.pid).returns.items[0];
  assert.equal(line.available, 0);
});

test('refund on collection: approved → collection booked → collected (courier webhook) → refunded, once', async () => {
  const o = mkOrder({ lines: [{ name: 'Vase', cents: 30000 }] });
  await ask(o.pid, { itemIds: o.itemIds, reason: 'damaged' });
  const row = await adminRow(o.pid);
  const before = refundCalls().length;
  const ap = await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie });
  assert.equal(ap.data.request.status, 'approved');
  assert.equal(refundCalls().length, before, 'approval refunds nothing');
  const ref = ap.data.request.collections[0].ref;
  assert.match(ref, /^QMOCK-R-/);

  // Settlement must not pay the maker while the return is in flight.
  const settlement = require('../src/settlement');
  db.prepare("UPDATE shipments SET return_window_ends_at=datetime('now','-1 day') WHERE order_id=?").run(o.id);
  db.prepare("UPDATE orders SET return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(o.id);
  const held = db.prepare(settlement.ELIGIBLE_CREDITS + ' AND b.order_id = @o').all({ at: db.prepare("SELECT datetime('now') AS t").get().t, o: o.id });
  assert.equal(held.length, 0, 'credit held while the return is in flight');

  // The courier's webhook (mock speaks the Quiqup shape) reports the pickup.
  let res = await ctx.api('POST', '/api/delivery/webhook', { body: { ref, event: 'collected' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.matched, true);
  let rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(row.id);
  assert.equal(rr.status, 'refunded');
  assert.ok(rr.collected_at && rr.refunded_at);
  assert.match(rr.refund_ref, /^re_mock_/);
  assert.equal(refundCalls().length, before + 1);
  assert.equal(refundCalls().at(-1).params.amount, 30000);

  // A repeated webhook never refunds twice.
  res = await ctx.api('POST', '/api/delivery/webhook', { body: { ref, event: 'delivered' } });
  assert.equal(refundCalls().length, before + 1);

  // Buyer view carries every step.
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const q = data.orders.find((x) => x.id === o.pid).returns.requests[0];
  assert.equal(q.status, 'refunded');
  assert.ok(q.collectionBookedAt && q.collectedAt && q.refundedAt);
});

test("admin 'refund now' is the exception path, and refunds only once", async () => {
  const o = mkOrder({ lines: [{ name: 'Vase', cents: 30000 }] });
  await ask(o.pid, { itemIds: o.itemIds, reason: 'wrong-item' });
  const row = await adminRow(o.pid);
  let res = await ctx.api('POST', `/api/admin/returns/${row.id}/refund-now`, { cookie: adminCookie });
  assert.equal(res.status, 409, 'must be approved first');
  await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie });
  const before = refundCalls().length;
  res = await ctx.api('POST', `/api/admin/returns/${row.id}/refund-now`, { cookie: adminCookie, body: { note: 'Courier lost the scan — piece is back with the maker' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.status, 'refunded');
  assert.match(res.data.request.refundNote, /lost the scan/);
  assert.equal(res.data.request.collectedAt, null, 'not claimed as collected');
  assert.equal(refundCalls().length, before + 1);
  // The courier's late report changes nothing.
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: row.id } });
  assert.equal(refundCalls().length, before + 1);
  res = await ctx.api('POST', `/api/admin/returns/${row.id}/refund-now`, { cookie: adminCookie });
  assert.equal(res.status, 409, 'already refunded');
});

test('VAT: a refunded return reverses the VAT inside the refund and carries a credit-note reference', async () => {
  // AED 100 + AED 30 delivery = AED 130 charged; VAT captured 5/105 × 13000 = 619.
  const o = mkOrder({ lines: [{ name: 'Bowl', cents: 6000 }, { name: 'Plate', cents: 4000 }] });
  assert.equal(o.vat, 619);
  await ask(o.pid, { itemIds: [o.itemIds[0]], reason: 'changed-mind' });
  const row = await adminRow(o.pid);
  await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie });
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: row.id } });
  const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(row.id);
  assert.equal(rr.refund_cents, 3000, '60 − 30 fee');
  assert.equal(rr.vat_reversed_cents, 143, '5/105 × 3000');
  assert.equal(rr.credit_note_ref, `CN-${o.pid}-R${row.id}`);
  assert.equal(db.prepare('SELECT vat_reversed_cents FROM orders WHERE id=?').get(o.id).vat_reversed_cents, 143);

  // The rest comes back: reversal is capped at what is left of the captured VAT.
  await ask(o.pid, { itemIds: [o.itemIds[1]], reason: 'damaged' });
  const row2 = await adminRow(o.pid);
  await ctx.api('POST', `/api/admin/returns/${row2.id}/approve`, { cookie: adminCookie });
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: row2.id } });
  const rr2 = db.prepare('SELECT * FROM return_requests WHERE id=?').get(row2.id);
  assert.equal(rr2.vat_reversed_cents, 190, '5/105 × 4000');
  const ord = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
  assert.equal(ord.vat_reversed_cents, 333);
  assert.ok(ord.vat_reversed_cents <= ord.vat_amount_cents);

  const rep = await ctx.api('GET', '/api/admin/vat-report', { cookie: adminCookie });
  const q = rep.data.rows.find((r) => r.rail === 'consignment');
  assert.ok(q.reversedCents >= 333);
  assert.equal(q.netVatCents, q.vatCents - q.reversedCents);
  assert.ok(rep.data.creditNotes.some((c) => c.reference === `CN-${o.pid}-R${row.id}` && c.vatCents === 143));
});

test('VAT: no VAT captured → nothing reversed, no credit note', async () => {
  const o = mkOrder({ lines: [{ name: 'Bowl', cents: 30000 }] });
  db.prepare('UPDATE orders SET vat_amount_cents=0 WHERE id=?').run(o.id);
  await ask(o.pid, { itemIds: o.itemIds, reason: 'damaged' });
  const row = await adminRow(o.pid);
  await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie });
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: row.id } });
  const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(row.id);
  assert.equal(rr.status, 'refunded');
  assert.equal(rr.vat_reversed_cents, 0);
  assert.equal(rr.credit_note_ref, null);
});

test('return emails tell the new order of events', () => {
  const email = require('../src/email');
  const order = { public_id: 'TRV-X1' };
  const items = [{ name: 'Mug', qty: 1, price_cents: 5000 }];
  const money = { gross: 5000, fee: 0, refund: 5000 };
  const ap = email.returnApproved({ order, items, money });
  assert.match(ap.subject, /collection booked/);
  assert.match(ap.html, /as soon as our courier has collected the item/);
  assert.match(ap.html, /approved → collection booked → collected → refunded/);
  const rf = email.returnRefunded({ order, items, money });
  assert.match(rf.subject, /refund is on its way/);
});

test("seller 'Revenue · 30d' excludes refunded amounts (returned units and whole-order refunds)", async () => {
  const sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
  const summary = async () => (await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie })).data.summary;
  const s0 = await summary();
  assert.equal(s0.days, 30);
  assert.equal(s0.revenueCents, s0.grossCents - s0.refundedCents);

  const o = mkOrder({ lines: [{ name: 'Mug', cents: 12500, qty: 2 }] });
  const s1 = await summary();
  assert.equal(s1.revenueCents - s0.revenueCents, 25000, 'a new paid order counts in full');

  // One of the two mugs comes back and is refunded.
  await ask(o.pid, { items: [{ id: o.itemIds[0], qty: 1 }] });
  const row = await adminRow(o.pid);
  await ctx.api('POST', `/api/admin/returns/${row.id}/approve`, { cookie: adminCookie });
  let s2 = await summary();
  assert.equal(s2.revenueCents, s1.revenueCents, 'approved but not yet refunded still counts');
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: row.id } });
  s2 = await summary();
  assert.equal(s1.revenueCents - s2.revenueCents, 12500, 'the refunded unit drops out');
  assert.equal(s2.refundedCents - s1.refundedCents, 12500);

  // A whole-order refund drops the whole order.
  const w = mkOrder({ lines: [{ name: 'Vase', cents: 40000 }] });
  const s3 = await summary();
  const res = await ctx.api('POST', `/api/admin/orders/${w.pid}/refund`, { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);
  const s4 = await summary();
  assert.equal(s3.revenueCents - s4.revenueCents, 40000);
  // ... and reverses the rest of its VAT with a credit note.
  const ord = db.prepare('SELECT * FROM orders WHERE id=?').get(w.id);
  assert.equal(ord.vat_reversed_cents, ord.vat_amount_cents);
  assert.equal(ord.credit_note_ref, `CN-${w.pid}`);

  // Orders older than 30 days are outside the window.
  const old = mkOrder({ lines: [{ name: 'Old', cents: 10000 }] });
  db.prepare("UPDATE orders SET created_at=datetime('now','-31 days') WHERE id=?").run(old.id);
  assert.equal((await summary()).revenueCents, s4.revenueCents);
});
