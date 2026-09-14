'use strict';
/**
 * Quiqup delivery integration — payload shape against the public API docs,
 * the signed order webhook, the maker's hand-over step, and the courier-only
 * pickup details on the shop.
 */
const crypto = require('crypto');
const { testEnv, startApp } = require('./helpers');
testEnv({ QUIQUP_WEBHOOK_SECRET: 'quiq-hmac-token' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db;
let shopId, productId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkPaidWebhookOrder(pid, pi) {
  const orderId = db.prepare(`INSERT INTO orders (public_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id,shipping_json)
    VALUES (?,?,?,20000,3000,0,23000,'pending','consignment',?,?)`)
    .run(pid, 'buyer@test.local', '+971501112233', pi, JSON.stringify({ name: 'Buyer B', line: 'Villa 4, Street 12, Jumeirah', city: 'Dubai', country: 'UAE' })).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)')
    .run(orderId, productId, shopId, 'Vase');
  return orderId;
}
async function paidShipment(pid, pi) {
  const oid = mkPaidWebhookOrder(pid, pi);
  await ctx.postWebhook({ id: 'evt_' + pi, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(oid) } } } });
  await sleep(80);
  return { oid, sh: db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid) };
}
const signed = (body) => {
  const raw = JSON.stringify(body);
  const sig = 'sha1=' + crypto.createHmac('sha1', 'quiq-hmac-token').update(raw).digest('hex');
  return fetch(ctx.baseUrl + '/api/delivery/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body: raw });
};

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('quiq@test.local',?, 'Maker','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,location) VALUES (?,?,?, 'approved','Al Quoz, Dubai')")
    .run(uid, 'Quiq Pots', 'quiq-pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,50,'live')")
    .run(shopId, 'Vase', 'Ceramics').lastInsertRowid;
});
after(async () => { await ctx.close(); });

test('live adapter builds the documented /orders payload (pre-paid, next-day, one parcel, pickup from the shop)', () => {
  const live = require('../src/delivery/quiqup-live');
  const shipment = { id: 7, order_id: 3, public_id: 'TRV-ABC123', buyer_phone: '+971501112233',
    shipping_json: JSON.stringify({ name: 'Buyer B', line: 'Villa 4, Street 12, Jumeirah', city: 'Dubai' }) };
  const shop = { name: 'Quiq Pots', location: 'Al Quoz, Dubai', pickup_address: 'Unit 9, Alserkal Avenue, Al Quoz 1', pickup_phone: '+971509998877' };

  const fwd = live._order('pickup', shipment, shop);
  assert.equal(fwd.kind, 'partner_next_day');
  assert.equal(fwd.payment_mode, 'pre_paid');
  assert.equal(fwd.payment_amount, 0);
  assert.equal(fwd.partner_order_id, 'TRV-ABC123-7');
  assert.equal(fwd.origin.contact_name, 'Quiq Pots');
  assert.equal(fwd.origin.contact_phone, '+971509998877');
  assert.equal(fwd.origin.address.address1, 'Unit 9, Alserkal Avenue, Al Quoz 1');
  assert.equal(fwd.origin.address.town, 'Dubai');
  assert.equal(fwd.origin.address.country, 'UAE');
  assert.equal(fwd.destination.contact_name, 'Buyer B');
  assert.equal(fwd.destination.contact_phone, '+971501112233'); // from orders.phone, not the snapshot
  assert.equal(fwd.destination.share_tracking, true);
  assert.equal(fwd.items.length, 1);
  assert.equal(fwd.items[0].quantity, 1);

  // Return leg: partner_return, points swapped, its own reference.
  const rev = live._order('reverse', shipment, shop);
  assert.equal(rev.kind, 'partner_return');
  assert.equal(rev.partner_order_id, 'TRV-ABC123-7-R');
  assert.equal(rev.origin.contact_name, 'Buyer B');
  assert.equal(rev.destination.contact_name, 'Quiq Pots');

  // Abu Dhabi is recognised from the address; no pickup address falls back to the area.
  const ad = live._order('pickup', shipment, { name: 'AD Shop', location: 'Saadiyat, Abu Dhabi' });
  assert.equal(ad.origin.address.town, 'Abu Dhabi');
  assert.equal(ad.origin.address.address1, 'Saadiyat, Abu Dhabi');
});

test('facade is mock until both Quiqup credentials are set', () => {
  const delivery = require('../src/delivery');
  assert.equal(delivery.isLive(), false);
  process.env.QUIQUP_CLIENT_ID = 'x';
  assert.equal(delivery.isLive(), false);
  process.env.QUIQUP_CLIENT_SECRET = 'y';
  assert.equal(delivery.isLive(), true);
  delete process.env.QUIQUP_CLIENT_ID; delete process.env.QUIQUP_CLIENT_SECRET;
  assert.equal(delivery.isLive(), false);
});

test('"Mark as shipped" hands a booked parcel to the courier once (ready_at + timeline)', async () => {
  const { sh } = await paidShipment('TRV-QQ01', 'pi_qq_1');
  assert.match(sh.delivery_ref, /^QMOCK-/);
  const mock = require('../src/delivery/quiqup-mock');
  assert.equal(mock._jobs.get(sh.delivery_ref).status, 'pending');

  const cookie = await ctx.loginAs('quiq@test.local', 'testpass123');
  const r = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'shipped' } });
  assert.equal(r.status, 200, r.text);
  await sleep(60);
  const after = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(after.status, 'shipped');
  assert.ok(after.ready_at, 'ready_at stamped');
  assert.equal(mock._jobs.get(sh.delivery_ref).status, 'ready_for_collection');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Ready for collection%'").get(sh.id).n, 1);
  assert.equal(r.data.shipment.deliveryRef, sh.delivery_ref);

  // Undo + re-ship must not hand over twice.
  await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'processing' } });
  await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'shipped' } });
  await sleep(60);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Ready for collection%'").get(sh.id).n, 1);
});

test('Quiqup order webhook: HMAC-signed state changes drive the shipment; bad signature is refused', async () => {
  const { oid, sh } = await paidShipment('TRV-QQ02', 'pi_qq_2');
  // The live adapter stores Quiqup's numeric order id as the reference.
  db.prepare('UPDATE shipments SET delivery_ref=? WHERE id=?').run('275530', sh.id);

  const bad = await fetch(ctx.baseUrl + '/api/delivery/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'sha1=deadbeef' },
    body: JSON.stringify({ type: 'order', payload: { id: 275530, state: 'collected' } }) });
  assert.equal(bad.status, 401);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'processing');

  let r = await signed({ action: 'update', type: 'order', payload: { id: 275530, state: 'collected', tracking_url: 'https://track-parcel.quiqup.com/abc' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { received: true, matched: true });
  let row = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(row.status, 'shipped');
  assert.equal(row.tracking_url, 'https://track-parcel.quiqup.com/abc');

  r = await signed({ action: 'update', type: 'order', payload: { id: 275530, state: 'delivery_failed' } });
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'shipped'); // note only
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Delivery attempt failed%'").get(sh.id).n, 1);

  r = await signed({ action: 'update', type: 'order', payload: { id: 275530, state: 'out_for_delivery' } });
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'out_for_delivery');

  r = await signed({ action: 'update', type: 'order', payload: { id: 275530, state: 'delivery_complete' } });
  row = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(row.status, 'delivered');
  assert.ok(row.delivered_at && row.return_window_ends_at);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(oid).status, 'fulfilled');

  // Unknown reference is acknowledged, never an error (Quiqup would retry otherwise).
  r = await signed({ type: 'order', payload: { id: 999999, state: 'collected' } });
  assert.deepEqual(await r.json(), { received: true, matched: false });
});

test('shop pickup address + phone: validated, saved, courier-only', async () => {
  const cookie = await ctx.loginAs('quiq@test.local', 'testpass123');
  let r = await ctx.api('PATCH', '/api/seller/me', { cookie, body: { pickupPhone: '12345' } });
  assert.equal(r.status, 400);
  r = await ctx.api('PATCH', '/api/seller/me', { cookie, body: { pickupAddress: 'short' } });
  assert.equal(r.status, 400);

  r = await ctx.api('PATCH', '/api/seller/me', { cookie, body: { pickupAddress: 'Unit 9, Alserkal Avenue, Al Quoz 1', pickupPhone: '050 999 8877' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.shop.pickup_address, 'Unit 9, Alserkal Avenue, Al Quoz 1');
  assert.equal(r.data.shop.pickup_phone, '+971509998877');

  const pub = await ctx.api('GET', '/api/shops/quiq-pots');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.shop.pickup_phone, undefined);
  assert.equal(pub.data.shop.pickup_address, undefined);
  assert.equal(JSON.stringify(pub.data).includes('+971509998877'), false);

  // Label endpoint: 409 without a booking, 404 in mock mode (no PDF).
  const { sh } = await paidShipment('TRV-QQ03', 'pi_qq_3');
  const lab = await ctx.api('GET', `/api/seller/shipments/${sh.id}/label`, { cookie });
  assert.equal(lab.status, 404);
  db.prepare("UPDATE shipments SET delivery_ref='' WHERE id=?").run(sh.id);
  const none = await ctx.api('GET', `/api/seller/shipments/${sh.id}/label`, { cookie });
  assert.equal(none.status, 409);
});
