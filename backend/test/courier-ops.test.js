'use strict';
/**
 * Courier health (fix round 2026-10-02): a booking that fails is recorded,
 * flagged for the admin and retried instead of being a log line (F004,
 * F054); 'Packed' and 'collected' are different facts (F056); a refund stops
 * a parcel the courier has not collected (F005); a cancelled parcel is never
 * revived by a late courier event (F051); lost / returning parcels reach a
 * person (F052); a return collection that failed holds the refund (F002).
 * Mock courier throughout, with _failNext to play an empty wallet / refusal.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let ctx, db, mock, adminCookie, makerCookie, buyerCookie, buyerId;
let shopA, shopB, pA, pB;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ship = (id) => db.prepare('SELECT * FROM shipments WHERE id=?').get(id);

async function paidOrder(pid, pi, lines) {
  const sub = lines.reduce((t, l) => t + l.cents, 0);
  const oid = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id,shipping_json)
    VALUES (?,?,?,?,?,0,0,?,'pending','consignment',?,?)`).run(pid, buyerId, 'buyer@test.local', '+971501112233', sub, sub, pi, JSON.stringify({ name: 'Amal', line: '1 Marina Walk', city: 'Dubai' })).lastInsertRowid;
  const ids = lines.map((l) => db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,1)')
    .run(oid, l.product, l.shop, l.name, l.cents).lastInsertRowid);
  await ctx.postWebhook({ id: 'evt_' + pi, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(oid) } } } });
  await sleep(60);
  const sh = (shopId) => db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(oid, shopId);
  return { oid, ids, sh };
}
const A = () => ({ product: pA, shop: shopA, name: 'Vase', cents: 25000 });
const B = () => ({ product: pB, shop: shopB, name: 'Candle', cents: 21000 });

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  mock = require('../src/delivery/quiqup-mock');
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(pw);
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?, 'Amal','buyer')").run(pw).lastInsertRowid;
  const ua = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('kiln@test.local',?, 'Mara','seller')").run(pw).lastInsertRowid;
  const ub = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('ember@test.local',?, 'Eli','seller')").run(pw).lastInsertRowid;
  shopA = db.prepare("INSERT INTO shops (user_id,name,slug,status,pickup_phone) VALUES (?,?,?,'approved','+971500000001')").run(ua, 'Kiln & Clay', 'kiln').lastInsertRowid;
  shopB = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(ub, 'Ember Goods', 'ember').lastInsertRowid;
  pA = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,25000,50,'live')").run(shopA, 'Vase', 'Ceramics').lastInsertRowid;
  pB = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,21000,50,'live')").run(shopB, 'Candle', 'Candles').lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
  makerCookie = await ctx.loginAs('kiln@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('buyer@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('F004: the collection booking fails when the maker taps Packed — stays not-shipped, admin flagged, wallet noted, no pack reminder, the sweep re-books', async () => {
  const o = await paidOrder('TRV-CO01', 'pi_co_1', [A()]);
  const sh = o.sh(shopA);
  assert.ok(sh.delivery_ref);
  mock._failNext.markReady = 'OTO1006 Your credit is not enough';
  const r = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie: makerCookie, body: { status: 'shipped' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.courierBooked, false);
  assert.match(r.data.notice, /Trove has been told/);
  let row = ship(sh.id);
  assert.equal(row.status, 'processing', 'no courier is coming, so it is not shipped');
  assert.ok(row.packed_at);
  assert.match(row.booking_error, /OTO1006/);
  assert.equal(row.attention, 'booking_failed');
  assert.equal(r.data.shipment.statusLabel, 'Packed');
  assert.equal(r.data.shipment.courierPending, true);
  assert.equal(require('../src/courier-ops').walletStatus().empty, true, 'an OTO1006 marks the wallet empty');
  assert.ok(!db.prepare("SELECT 1 FROM shipment_events WHERE shipment_id=? AND note LIKE 'Handed to the courier%'").get(sh.id), 'nobody is told the courier has it');

  // The maker packed it: no 'please pack' reminder.
  db.prepare("UPDATE shipments SET pack_by_at=datetime('now','-3 days') WHERE id=?").run(sh.id);
  await require('../src/order-sweep').sweepPackBy();
  assert.equal(ship(sh.id).pack_reminder_at, null);

  // Admin sees it with a Retry.
  const list = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  const parcel = list.data.orders.find((x) => x.publicId === 'TRV-CO01').parcels[0];
  assert.equal(parcel.attention, 'booking_failed');
  assert.equal(parcel.canRetryCourier, true);
  assert.equal(parcel.shopPhone, '+971500000001');

  // The hourly sweep books it once the wallet is topped up.
  const out = await require('../src/courier-ops').retryBookings();
  assert.ok(out.ok >= 1);
  row = ship(sh.id);
  assert.equal(row.status, 'shipped');
  assert.ok(row.ready_at);
  assert.equal(row.booking_error, null);
  assert.equal(row.attention, '');
  assert.ok(db.prepare("SELECT 1 FROM shipment_events WHERE shipment_id=? AND note='Packed — waiting for the courier to collect it'").get(sh.id));
});

test('F054: the courier order fails at payment — recorded, flagged, and the admin Retry books it', async () => {
  mock._failNext.bookPickup = 'OTO is down';
  const o = await paidOrder('TRV-CO02', 'pi_co_2', [A()]);
  let row = o.sh(shopA);
  assert.ok(!row.delivery_ref);
  assert.match(row.booking_error, /OTO is down/);
  assert.equal(row.attention, 'booking_failed');
  const r = await ctx.api('POST', `/api/admin/shipments/${row.id}/retry-courier`, { cookie: adminCookie });
  assert.equal(r.status, 200, r.text);
  row = ship(row.id);
  assert.ok(row.delivery_ref);
  assert.equal(row.attention, '');
});

test('F054: with a live courier connected, an unbooked parcel is still Trove-managed — the maker cannot mark it delivered', async () => {
  const o = await paidOrder('TRV-CO03', 'pi_co_3', [A()]);
  const sh = o.sh(shopA);
  db.prepare('UPDATE shipments SET delivery_ref=NULL WHERE id=?').run(sh.id);
  process.env.QUIQUP_CLIENT_ID = 'x'; process.env.QUIQUP_CLIENT_SECRET = 'y';
  try {
    const r = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie: makerCookie, body: { status: 'delivered' } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'courier_managed');
  } finally { delete process.env.QUIQUP_CLIENT_ID; delete process.env.QUIQUP_CLIENT_SECRET; }
  assert.equal(ship(sh.id).status, 'processing');
});

test('F056: packed is not collected — Packed until the courier reports the pickup, then Shipped; a parcel left uncollected for a day is flagged once', async () => {
  const o = await paidOrder('TRV-CO04', 'pi_co_4', [A()]);
  const sh = o.sh(shopA);
  await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie: makerCookie, body: { status: 'shipped' } });
  let acct = (await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie })).data.orders.find((x) => x.id === 'TRV-CO04');
  assert.equal(acct.shipments[0].statusLabel, 'Packed');
  assert.equal(acct.shipments[0].collectedAt, null);

  // Not collected after a day → flagged once.
  db.prepare("UPDATE shipments SET ready_at=datetime('now','-30 hours') WHERE id=?").run(sh.id);
  const courier = require('../src/courier-ops');
  assert.equal(courier.flagUncollected(), 1);
  assert.equal(ship(sh.id).attention, 'not_collected');
  assert.equal(courier.flagUncollected(), 0, 'once');

  // The courier collects (Quiqup-shaped webhook from the mock courier).
  const r = await ctx.api('POST', '/api/delivery/webhook', { body: { ref: sh.delivery_ref, event: 'collected' } });
  assert.equal(r.status, 200);
  const row = ship(sh.id);
  assert.ok(row.collected_at);
  assert.equal(row.attention, '', 'the flag clears');
  acct = (await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie })).data.orders.find((x) => x.id === 'TRV-CO04');
  assert.equal(acct.shipments[0].statusLabel, 'Shipped');
  // The buyer reads a friendly step, never the courier's raw note (F090).
  assert.ok(acct.shipments[0].timeline.some((e) => /^Handed to the courier/.test(e.note)));
  assert.ok(!acct.shipments[0].timeline.some((e) => e.note === 'Collected by Quiqup'));
  // Once collected, the maker can't step it back.
  const back = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie: makerCookie, body: { status: 'processing' } });
  assert.equal(back.status, 400);
});

test('F005: refunding an order whose parcel is packed but not collected cancels the courier booking and the parcel; the maker is told', async () => {
  const o = await paidOrder('TRV-CO05', 'pi_co_5', [A()]);
  const sh = o.sh(shopA);
  await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie: makerCookie, body: { status: 'shipped' } });
  assert.equal(ship(sh.id).status, 'shipped');
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CO05/refund', { cookie: adminCookie });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.parcels.map((p) => p.action), ['cancelled']);
  assert.equal(ship(sh.id).status, 'cancelled');
  assert.equal(mock._jobs.get(sh.delivery_ref).status, 'cancelled');
  // No return collection was attempted for a parcel that never left.
  assert.ok(!db.prepare("SELECT 1 FROM shipment_events WHERE shipment_id=? AND note LIKE 'Return pickup booked%'").get(sh.id));
  // The maker's dashboard says cancelled, and a Packed tap can't revive it.
  const again = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie: makerCookie, body: { status: 'shipped' } });
  assert.equal(again.status, 409);
});

test('F005: if the courier refuses the cancel, the parcel is still cancelled in Trove and flagged for a person', async () => {
  const o = await paidOrder('TRV-CO06', 'pi_co_6', [A()]);
  const sh = o.sh(shopA);
  mock._failNext.cancelPickup = 'Shipment already picked';
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CO06/refund', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.parcels[0].action, 'cancel_failed');
  const row = ship(sh.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.attention, 'courier_cancel_failed');
});

test('F005: a parcel already with the courier is flagged on refund, not silently left', async () => {
  const o = await paidOrder('TRV-CO07', 'pi_co_7', [A()]);
  const sh = o.sh(shopA);
  await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie: makerCookie, body: { status: 'shipped' } });
  await ctx.api('POST', '/api/delivery/webhook', { body: { ref: sh.delivery_ref, event: 'collected' } });
  const r = await ctx.api('POST', '/api/admin/orders/TRV-CO07/refund', { cookie: adminCookie });
  assert.equal(r.data.parcels[0].action, 'in_transit');
  assert.equal(ship(sh.id).attention, 'refunded_in_transit');
});

test('F051: a late courier event never revives a cancelled parcel — no delivery, no return window, no fulfilled order; a person is told', async () => {
  const sh = db.prepare("SELECT * FROM shipments WHERE order_id=(SELECT id FROM orders WHERE public_id='TRV-CO05')").get();
  assert.equal(sh.status, 'cancelled');
  await ctx.api('POST', '/api/delivery/webhook', { body: { ref: sh.delivery_ref, event: 'out_for_delivery' } });
  await ctx.api('POST', '/api/delivery/webhook', { body: { ref: sh.delivery_ref, event: 'delivered' } });
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });
  const row = ship(sh.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.delivered_at, null);
  assert.equal(row.return_window_ends_at, null);
  assert.equal(row.attention, 'delivered_after_cancel');
  const o = db.prepare("SELECT * FROM orders WHERE public_id='TRV-CO05'").get();
  assert.equal(o.status, 'paid');
  assert.equal(o.delivered_at, null);
});

test('F052: a parcel going back to the maker after a failed delivery reaches a person', async () => {
  const o = await paidOrder('TRV-CO08', 'pi_co_8', [A()]);
  const sh = o.sh(shopA);
  await ctx.api('POST', '/api/delivery/webhook', { body: { ref: sh.delivery_ref, event: 'return_to_origin' } });
  assert.equal(ship(sh.id).attention, 'returning');
  const list = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  const parcel = list.data.orders.find((x) => x.publicId === 'TRV-CO08').parcels[0];
  assert.match(parcel.attentionLabel, /going back to the maker/);
  // The admin marks it handled.
  assert.equal((await ctx.api('POST', `/api/admin/shipments/${sh.id}/clear-attention`, { cookie: adminCookie })).status, 200);
  assert.equal(ship(sh.id).attention, '');
});

test('F002: a two-maker return where one collection fails is NOT refunded when the other is collected; re-booking then collecting refunds it', async () => {
  const o = await paidOrder('TRV-CO09', 'pi_co_9', [A(), B()]);
  for (const s of [o.sh(shopA), o.sh(shopB)]) await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: s.id } });
  const rq = await ctx.api('POST', '/api/account/orders/TRV-CO09/return-request', { cookie: buyerCookie,
    body: { items: o.ids.map((id) => ({ id, qty: 1 })), reason: 'damaged', details: 'Both arrived broken.', images: [PNG] } });
  assert.equal(rq.status, 201, rq.text);
  const rr = db.prepare('SELECT * FROM return_requests WHERE order_id=?').get(o.oid);
  mock._failNext.bookReversePickup = 'OTO1006 Your credit is not enough';
  assert.equal((await ctx.api('POST', `/api/admin/returns/${rr.id}/approve`, { cookie: adminCookie, body: {} })).status, 200);
  const cols = db.prepare('SELECT * FROM return_collections WHERE request_id=? ORDER BY id').all(rr.id);
  assert.deepEqual(cols.map((c) => c.status).sort(), ['booked', 'failed']);

  ctx.stripeMock.reset();
  const booked = cols.find((c) => c.status === 'booked');
  await require('../src/returns').markCollected({ ref: booked.ref });
  let req = db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr.id);
  assert.equal(req.status, 'approved', 'still waiting for the other parcel');
  assert.equal(ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create').length, 0, 'nobody is refunded for a piece nobody collected');
  const fees = require('../src/fees');
  assert.equal(db.prepare("SELECT amount_cents FROM seller_balances WHERE order_id=? AND shop_id=? AND type='credit_sale'").get(o.oid, shopB).amount_cents,
    fees.split(21000).net, "the maker whose piece was never collected keeps the credit");

  // Book the collection again: same row, now booked; collect it → refunded.
  assert.equal((await ctx.api('POST', `/api/admin/returns/${rr.id}/book-collection`, { cookie: adminCookie })).status, 200);
  const after = db.prepare('SELECT * FROM return_collections WHERE request_id=? ORDER BY id').all(rr.id);
  assert.equal(after.length, 2, 're-booked in place, no stale failed row left behind');
  assert.ok(after.every((c) => ['booked', 'collected'].includes(c.status)));
  await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: rr.id } });
  req = db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr.id);
  assert.equal(req.status, 'refunded');
  assert.equal(ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create').length, 1);
});

test('F002: a parcel that never reached the buyer is not a failed collection and never holds the refund', async () => {
  const returns = require('../src/returns');
  const o = await paidOrder('TRV-CO10', 'pi_co_10', [A(), B()]);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: o.sh(shopA).id } });
  // Shop B's parcel is still at the maker's; a request naming it gets 'not_needed' for that leg.
  const rrId = db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,details,images,status) VALUES (?,?,'damaged','x x x x x','[]','approved')").run(o.oid, buyerId).lastInsertRowid;
  for (const id of o.ids) db.prepare('INSERT INTO return_request_items (request_id,order_item_id,qty) VALUES (?,?,1)').run(rrId, id);
  await returns.bookCollections(db.prepare('SELECT * FROM orders WHERE id=?').get(o.oid), rrId);
  const cols = db.prepare('SELECT * FROM return_collections WHERE request_id=?').all(rrId);
  assert.deepEqual(cols.map((c) => c.status).sort(), ['booked', 'not_needed']);
  await returns.markCollected({ ref: cols.find((c) => c.status === 'booked').ref });
  assert.equal(db.prepare('SELECT status FROM return_requests WHERE id=?').get(rrId).status, 'refunded');
});
