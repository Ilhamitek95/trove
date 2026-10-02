'use strict';
/**
 * Cancelling pieces before dispatch (owner 2026-10-02, findings F034/F041):
 * per line and per unit, partial Stripe refund, maker credit + VAT reversal,
 * an empty parcel cancelled with its courier booking, 'never shipped' for a
 * whole parcel, the delivery fee back when nothing is left to deliver — and
 * the whole-order refund's credit note crediting only VAT not yet reversed.
 * Tax invoice + credit notes (F363) ride along since VAT is on here.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ VAT_REGISTERED: '1' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let ctx, db, adminCookie, buyerCookie, otherCookie, makerACookie;
let shopA, shopB, mug, wallet, vase, buyerId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fees = () => require('../src/fees');
const cfg = () => require('../src/config');

/** A paid order: lines = [{ product, shop, cents, qty }]; paid through the webhook. */
async function paidOrder(pid, pi, lines, { shipping = null } = {}) {
  const sub = lines.reduce((t, l) => t + l.cents * l.qty, 0);
  const ship = shipping != null ? shipping : (sub > 20000 ? 0 : 3000);
  const oid = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id,shipping_json)
    VALUES (?,?,?,?,?,?,0,?,'pending','consignment',?,?)`)
    .run(pid, buyerId, 'buyer@test.local', '+971501112233', sub, ship, sub + ship, pi, JSON.stringify({ name: 'Amal Buyer', line: '1 Marina Walk', city: 'Dubai Marina, Dubai' })).lastInsertRowid;
  const ids = lines.map((l) => db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,?)')
    .run(oid, l.product, l.shop, l.name, l.cents, l.qty).lastInsertRowid);
  const r = await ctx.postWebhook({ id: 'evt_' + pi, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(oid) } } } });
  assert.equal(r.status, 200);
  await sleep(60); // courier booking is fire-and-forget
  return { oid, ids, ship: (shopId) => db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(oid, shopId) };
}
const order = (oid) => db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
const credit = (oid, shopId) => db.prepare("SELECT amount_cents FROM seller_balances WHERE order_id=? AND shop_id=? AND type='credit_sale'").get(oid, shopId).amount_cents;
const refunds = () => ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create');

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(pw);
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?, 'Amal Buyer','buyer')").run(pw).lastInsertRowid;
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('other@test.local',?, 'Other','buyer')").run(pw);
  const ua = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('kiln@test.local',?, 'Mara Kiln','seller')").run(pw).lastInsertRowid;
  const ub = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('ember@test.local',?, 'Eli Ember','seller')").run(pw).lastInsertRowid;
  shopA = db.prepare("INSERT INTO shops (user_id,name,slug,status,pickup_address,pickup_phone) VALUES (?,?,?,'approved','Al Quoz 3, Dubai','+971500000001')").run(ua, 'Kiln & Clay', 'kiln-clay').lastInsertRowid;
  shopB = db.prepare("INSERT INTO shops (user_id,name,slug,status,pickup_address,pickup_phone) VALUES (?,?,?,'approved','JLT, Dubai','+971500000002')").run(ub, 'Ember Goods', 'ember-goods').lastInsertRowid;
  const prod = (shop, name, cents) => db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,50,'live')").run(shop, name, 'Ceramics', cents).lastInsertRowid;
  mug = { product: prod(shopA, 'Mug', 6400), shop: shopA, name: 'Mug', cents: 6400 };
  vase = { product: prod(shopA, 'Vase', 5000), shop: shopA, name: 'Vase', cents: 5000 };
  wallet = { product: prod(shopB, 'Wallet', 19500), shop: shopB, name: 'Wallet', cents: 19500 };
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('buyer@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
  makerACookie = await ctx.loginAs('kiln@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

let multi; // TRV-CX01: 2 mugs from Kiln & Clay + a wallet from Ember Goods (AED 323, free delivery)

test('partial cancel: one of two mugs — partial refund, credit + VAT reversed for that unit only, the parcel carries on', async () => {
  multi = await paidOrder('TRV-CX01', 'pi_cx_1', [{ ...mug, qty: 2 }, { ...wallet, qty: 1 }]);
  const [mugLine] = multi.ids;
  const o0 = order(multi.oid);
  assert.equal(o0.vat_amount_cents, cfg().vatFromGross(32300));
  const creditA0 = credit(multi.oid, shopA);
  assert.equal(creditA0, fees().split(12800).net);

  const pick = await ctx.api('GET', '/api/admin/orders/TRV-CX01/cancellable', { cookie: adminCookie });
  assert.equal(pick.status, 200);
  assert.equal(pick.data.lines.find((l) => l.id === mugLine).cancellable, 2);

  const dry = await ctx.api('POST', '/api/admin/orders/TRV-CX01/cancel-items', { cookie: adminCookie, body: { items: [{ id: mugLine, qty: 1 }], dryRun: true } });
  assert.deepEqual([dry.data.refundCents, dry.data.deliveryCents, dry.data.whole], [6400, 0, false]);
  assert.equal(db.prepare('SELECT cancelled_qty FROM order_items WHERE id=?').get(mugLine).cancelled_qty, 0, 'a dry run changes nothing');

  ctx.stripeMock.reset();
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CX01/cancel-items', { cookie: adminCookie, body: { items: [{ id: mugLine, qty: 1 }], reason: 'buyer_request', note: 'Buyer changed their mind' } });
  assert.equal(r.status, 200, r.text);
  const [ref] = refunds();
  assert.equal(ref.params.payment_intent, 'pi_cx_1');
  assert.equal(ref.params.amount, 6400);
  assert.equal(ref.params.metadata.trove_kind, 'cancellation');

  assert.equal(db.prepare('SELECT cancelled_qty FROM order_items WHERE id=?').get(mugLine).cancelled_qty, 1);
  assert.equal(credit(multi.oid, shopA), creditA0 - fees().split(6400).net, "the maker's unpaid credit shrinks by that unit");
  assert.equal(credit(multi.oid, shopB), fees().split(19500).net, 'the other maker is untouched');
  const o1 = order(multi.oid);
  assert.equal(o1.vat_reversed_cents, cfg().vatFromGross(6400));
  assert.equal(o1.refunded_at, null);
  assert.equal(r.data.cancellation.creditNoteRef, `CN-TRV-CX01-C${r.data.cancellation.id}`);
  assert.equal(multi.ship(shopA).status, 'processing', 'the rest of the parcel still goes');

  // The maker sees one mug to pack, the cancelled one called out.
  const mine = await ctx.api('GET', '/api/seller/orders', { cookie: makerACookie });
  const card = mine.data.orders.find((x) => x.order.publicId === 'TRV-CX01');
  const line = card.items.find((i) => i.name === 'Mug');
  assert.deepEqual([line.qty, line.cancelledQty], [1, 1]);
  assert.equal(card.itemTotal, 64);
  assert.ok(card.timeline.some((e) => /Cancelled by Trove and refunded: Mug/.test(e.note)));

  // No unit can be cancelled twice.
  const again = await ctx.api('POST', '/api/admin/orders/TRV-CX01/cancel-items', { cookie: adminCookie, body: { items: [{ id: mugLine, qty: 2 }] } });
  assert.equal(again.status, 409);
});

test('never shipped: the whole Ember parcel is cancelled and refunded, its courier booking cancelled; Kiln & Clay completes the order and its payout', async () => {
  const shB = multi.ship(shopB);
  assert.ok(shB.delivery_ref, 'courier order was booked at payment');
  ctx.stripeMock.reset();
  const r = await ctx.api('POST', `/api/admin/orders/TRV-CX01/parcels/${shB.id}/cancel`, { cookie: adminCookie, body: { note: 'Maker unreachable' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(refunds()[0].params.amount, 19500);
  assert.equal(r.data.cancellation.reason, 'not_shipped');
  assert.equal(multi.ship(shopB).status, 'cancelled');
  assert.equal(require('../src/delivery/quiqup-mock')._jobs.get(shB.delivery_ref).status, 'cancelled', 'no driver comes');
  assert.equal(credit(multi.oid, shopB), 0, 'nothing is owed to the maker who never sent it');
  assert.equal(order(multi.oid).refunded_at, null, 'the mug is still on its way');

  // Ember's dashboard shows it cancelled and won't let them revive it.
  const emberCookie = await ctx.loginAs('ember@test.local', 'testpass123');
  const back = await ctx.api('PATCH', `/api/seller/shipments/${shB.id}`, { cookie: emberCookie, body: { status: 'processing' } });
  assert.equal(back.status, 409);

  // Kiln & Clay delivers: the order completes despite the cancelled parcel.
  const shA = multi.ship(shopA);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: shA.id } });
  const o = order(multi.oid);
  assert.equal(o.status, 'fulfilled');
  assert.ok(o.return_window_ends_at, 'the buyer return window opens on the delivered parcel');
  db.prepare("UPDATE shipments SET return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(shA.id);
  db.prepare("UPDATE orders SET return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(multi.oid);
  const prev = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  const kiln = [...prev.data.eligible, ...prev.data.excluded].find((x) => x.shopId === shopA);
  assert.ok(kiln, "Kiln & Clay's credit is no longer stuck behind the cancelled parcel");
  assert.equal(kiln.creditCents, fees().split(6400).net);
  assert.ok(![...prev.data.eligible, ...prev.data.excluded].some((x) => x.shopId === shopB && x.creditCents > 0));
});

test('a cancelled unit can never be sent back as a return', async () => {
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const o = data.orders.find((x) => x.id === 'TRV-CX01');
  const mugItem = o.returns.items.find((i) => i.name === 'Mug');
  assert.deepEqual([mugItem.qty, mugItem.available], [1, 1]);
  assert.ok(!o.returns.items.some((i) => i.name === 'Wallet'), 'the cancelled parcel has nothing to return');
  assert.equal(o.cancellations.length, 2);
});

test('cancelling everything left refunds the delivery fee too and closes the order as refunded', async () => {
  const small = await paidOrder('TRV-CX02', 'pi_cx_2', [{ ...vase, qty: 1 }]);
  ctx.stripeMock.reset();
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CX02/cancel-items', { cookie: adminCookie, body: { items: [{ id: small.ids[0], qty: 1 }] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(refunds()[0].params.amount, 8000, 'AED 50 vase + AED 30 delivery');
  assert.equal(r.data.cancellation.deliveryRefund, 30);
  const o = order(small.oid);
  assert.ok(o.refunded_at);
  assert.equal(o.vat_reversed_cents, o.vat_amount_cents, 'all the VAT back, exactly once');
  assert.equal(small.ship(shopA).status, 'cancelled');
  // Nothing left: a second cancellation or a full refund is refused.
  assert.equal((await ctx.api('POST', '/api/admin/orders/TRV-CX02/refund', { cookie: adminCookie })).status, 409);
});

test('the admin can keep the delivery fee on a whole cancellation (override)', async () => {
  const o = await paidOrder('TRV-CX03', 'pi_cx_3', [{ ...vase, qty: 1 }]);
  ctx.stripeMock.reset();
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CX03/cancel-items', { cookie: adminCookie, body: { items: [{ id: o.ids[0], qty: 1 }], refundDelivery: false } });
  assert.equal(r.status, 200, r.text);
  assert.equal(refunds()[0].params.amount, 5000);
});

test('guards: a parcel the courier has collected, bad quantities, a refunded order', async () => {
  const o = await paidOrder('TRV-CX04', 'pi_cx_4', [{ ...mug, qty: 1 }, { ...wallet, qty: 1 }]);
  db.prepare("UPDATE shipments SET status='shipped', collected_at=datetime('now') WHERE id=?").run(o.ship(shopA).id);
  let r = await ctx.api('POST', '/api/admin/orders/TRV-CX04/cancel-items', { cookie: adminCookie, body: { items: [{ id: o.ids[0], qty: 1 }] } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /courier|return/i);
  r = await ctx.api('POST', '/api/admin/orders/TRV-CX04/cancel-items', { cookie: adminCookie, body: { items: [{ id: o.ids[1], qty: 2 }] } });
  assert.equal(r.status, 409);
  r = await ctx.api('POST', '/api/admin/orders/TRV-CX04/cancel-items', { cookie: adminCookie, body: { items: [] } });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/admin/orders/TRV-CX04/cancel-items', { cookie: adminCookie, body: { items: [{ id: o.ids[1], qty: -1 }] } });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/admin/orders/TRV-CX04/cancel-items', { body: { items: [{ id: o.ids[1], qty: 1 }] } });
  assert.equal(r.status, 401, 'admin only');
});

test('a failed card refund cancels nothing', async () => {
  const o = await paidOrder('TRV-CX05', 'pi_cx_5', [{ ...mug, qty: 2 }]);
  const before = credit(o.oid, shopA);
  ctx.stripeMock.refunds.failNext = 'Your card was declined';
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CX05/cancel-items', { cookie: adminCookie, body: { items: [{ id: o.ids[0], qty: 1 }] } });
  assert.equal(r.status, 502);
  assert.equal(db.prepare('SELECT cancelled_qty FROM order_items WHERE id=?').get(o.ids[0]).cancelled_qty, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_cancellations WHERE order_id=?').get(o.oid).n, 0);
  assert.equal(credit(o.oid, shopA), before);
  assert.equal(order(o.oid).vat_reversed_cents, 0);
});

test('whole-order refund after a refunded return: its credit note carries only the VAT not already credited (no double VAT credit)', async () => {
  const o = await paidOrder('TRV-CX06', 'pi_cx_6', [{ ...mug, qty: 1 }, { ...vase, qty: 1 }]);
  const sh = o.ship(shopA);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });
  // The buyer returns the mug (faulty), it is collected and refunded.
  const rq = await ctx.api('POST', '/api/account/orders/TRV-CX06/return-request', { cookie: buyerCookie,
    body: { items: [{ id: o.ids[0], qty: 1 }], reason: 'damaged', details: 'Chipped on arrival.', images: [PNG] } });
  assert.equal(rq.status, 201, rq.text);
  const rr = db.prepare('SELECT * FROM return_requests WHERE order_id=?').get(o.oid);
  assert.equal((await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie, body: {} })).status, 200);
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: rr.id } });
  const done = db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr.id);
  assert.equal(done.status, 'refunded');
  assert.ok(done.vat_reversed_cents > 0);

  ctx.stripeMock.reset();
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CX06/refund', { cookie: adminCookie });
  assert.equal(r.status, 200, r.text);
  const after = order(o.oid);
  assert.equal(after.whole_refund_vat_cents, after.vat_amount_cents - done.vat_reversed_cents, 'only the VAT still owed');
  assert.equal(after.vat_reversed_cents, after.vat_amount_cents, 'total reversed never exceeds what was captured');
  assert.equal(after.whole_refund_cents, after.total_cents - done.refund_cents);
  assert.equal(refunds()[0].params.amount, undefined, 'Stripe refunds what is still paid');

  const vat = await ctx.api('GET', '/api/admin/vat-report', { cookie: adminCookie });
  const notes = vat.data.creditNotes.filter((n) => n.order === 'TRV-CX06');
  assert.equal(notes.reduce((t, n) => t + n.vatCents, 0), after.vat_amount_cents, 'credit notes add up to the VAT captured, not more');
});

test('whole-order refund after a cancellation: same rule — no VAT credited twice', async () => {
  const o = await paidOrder('TRV-CX07', 'pi_cx_7', [{ ...mug, qty: 2 }]);
  await ctx.api('POST', '/api/admin/orders/TRV-CX07/cancel-items', { cookie: adminCookie, body: { items: [{ id: o.ids[0], qty: 1 }] } });
  const c = db.prepare('SELECT * FROM order_cancellations WHERE order_id=?').get(o.oid);
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CX07/refund', { cookie: adminCookie });
  assert.equal(r.status, 200, r.text);
  const after = order(o.oid);
  assert.equal(after.whole_refund_vat_cents, after.vat_amount_cents - c.vat_reversed_cents);
  assert.equal(after.vat_reversed_cents, after.vat_amount_cents);
  const vat = await ctx.api('GET', '/api/admin/vat-report', { cookie: adminCookie });
  const notes = vat.data.creditNotes.filter((n) => n.order === 'TRV-CX07');
  assert.equal(notes.length, 2);
  assert.equal(notes.reduce((t, n) => t + n.vatCents, 0), after.vat_amount_cents);
});

test('tax invoice + credit notes (VAT registered): sequential numbers, bilingual, the buyer sees only their own', async () => {
  const a = order(multi.oid), b = db.prepare("SELECT * FROM orders WHERE public_id='TRV-CX02'").get();
  assert.match(a.tax_invoice_no, /^INV-\d{6}$/);
  assert.equal(Number(b.tax_invoice_no.slice(4)), Number(a.tax_invoice_no.slice(4)) + 1, 'sequential, in payment order');

  db.prepare('INSERT OR REPLACE INTO site_content (section, value) VALUES (?, ?)').run('site.company', JSON.stringify({ legalName: 'Trove Marketplace LLC', address: 'Dubai, UAE', vatTrn: '100000000000003' }));
  const inv = await ctx.api('GET', '/api/account/orders/TRV-CX01/tax-invoice', { cookie: buyerCookie });
  assert.equal(inv.status, 200);
  assert.match(inv.text, /Tax invoice/);
  assert.match(inv.text, /فاتورة ضريبية/);
  assert.ok(inv.text.includes(a.tax_invoice_no));
  assert.equal((await ctx.api('GET', '/api/account/orders/TRV-CX01/tax-invoice', { cookie: otherCookie })).status, 404, "someone else's order");

  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const docs = data.orders.find((x) => x.id === 'TRV-CX01').documents;
  assert.equal(docs.taxInvoice, a.tax_invoice_no);
  assert.equal(docs.creditNotes.length, 2, 'one per cancellation');
  const cn = await ctx.api('GET', `/api/account/orders/TRV-CX01/credit-notes/${encodeURIComponent(docs.creditNotes[0].ref)}`, { cookie: buyerCookie });
  assert.equal(cn.status, 200);
  assert.match(cn.text, /Tax credit note/);
  assert.ok(cn.text.includes(a.tax_invoice_no), 'the credit note names the invoice it adjusts');
  const adminInv = await ctx.api('GET', '/api/admin/orders/TRV-CX01/tax-invoice', { cookie: adminCookie });
  assert.equal(adminInv.status, 200);
});
