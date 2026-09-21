'use strict';
/**
 * OTO delivery integration — against a fake OTO API on a local port: the maker
 * becomes a pickup location, the order is created at payment, the courier is
 * booked (cheapest door-to-door with a pickup) when the maker has packed, the
 * label redirects to OTO's hosted AWB, returns go back to the maker, and the
 * signed webhook drives the shipment.
 */
const crypto = require('crypto');
const http = require('http');
const { testEnv, startApp } = require('./helpers');
testEnv({ OTO_REFRESH_TOKEN: 'rt-test', OTO_WEBHOOK_SECRET: 'oto-secret' });

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, fake;
let shopId, productId, sellerEmail = 'oto@test.local';
const calls = [];
const locations = new Set();
const hooks = [];
const byPath = (p) => calls.filter((c) => c.path === p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

/* ---- fake OTO API (paths + shapes from apis.tryoto.com) ---- */
const OPTIONS = [
  { deliveryOptionId: 7252, deliveryOptionName: 'Omni Llama', serviceType: 'lockerDelivery', deliveryType: 'locker', pickupDropoff: 'lockerDropOff', price: 8 },
  { deliveryOptionId: 7144, deliveryOptionName: 'SPL PUDO', serviceType: 'pudo', deliveryType: 'pickupByCustomer', pickupDropoff: 'dropoffOnly', price: 9 },
  { deliveryOptionId: 7300, deliveryOptionName: 'Drop-off Express', serviceType: 'express', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'dropoffOnly', price: 10 },
  { deliveryOptionId: 22, deliveryOptionName: 'Aramex', serviceType: 'express', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 18 },
  { deliveryOptionId: 7147, deliveryOptionName: 'iMile', serviceType: 'express', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 14 },
  { deliveryOptionId: 7109, deliveryOptionName: 'Deliver Now', serviceType: 'sameDay', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 25 },
];
function otoApi(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/rest\/v2/, '');
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path, body, auth: req.headers.authorization || '' });
    const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (path === '/refreshToken') return body.refresh_token === 'rt-test'
      ? send(200, { success: true, access_token: 'at-1', token_type: 'Bearer', expires_in: '3600' })
      : send(401, { success: false, otoErrorMessage: 'bad refresh token' });
    if (req.headers.authorization !== 'Bearer at-1') return send(401, { message: 'Jwt is expired', code: 401 });
    if (path === '/createPickupLocation') {
      if (locations.has(body.code)) return send(400, { success: false, otoErrorCode: 'OTO1010', otoErrorMessage: 'Pickup location code already exists' });
      locations.add(body.code); return send(200, { success: true, pickupLocationCode: body.code, message: 'warehouse has been created' });
    }
    if (path === '/updatePickupLocation') return locations.has(body.code)
      ? send(200, { success: true, message: 'warehouse has been updated' })
      : send(404, { success: false, otoErrorMessage: 'Pickup location not found' });
    if (path === '/createOrder') return send(200, { success: true, otoId: 540789 });
    if (path === '/checkOTODeliveryFee') return send(200, { success: true, deliveryCompany: OPTIONS });
    if (path === '/createShipment') return send(200, { success: true, message: 'create shipment request is received.' });
    if (path.startsWith('/print/')) return send(200, { success: true, printAWBURL: 'https://app.tryoto.com/print/awb?enc=abc', trackingNumber: 'OTO123' });
    if (path === '/createReturnShipment') return send(200, { success: true, returnOrderId: body.orderId + '-R1', message: 'A new return order is created for return shipment' });
    if (path === '/orderStatus') return send(200, { success: true, status: 'pickedUp' });
    if (path === '/accountInfo') return send(200, { packageName: 'freePackage', remainingCredit: 250 });
    if (path === '/webhook' && req.method === 'GET') return send(200, { success: true, webhooks: hooks });
    if (path === '/webhook' && req.method === 'POST') { hooks.push({ id: hooks.length + 1, ...body }); return send(200, { success: true, id: String(hooks.length) }); }
    if (path === '/webhook' && req.method === 'PUT') { Object.assign(hooks.find((h) => h.id === body.id), body); return send(200, { success: true }); }
    send(404, { success: false, otoErrorMessage: 'unknown path ' + path });
  });
}

function mkPaidOrder(pid, pi, ship) {
  const orderId = db.prepare(`INSERT INTO orders (public_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id,shipping_json)
    VALUES (?,?,?,20000,3000,0,23000,'pending','consignment',?,?)`)
    .run(pid, 'buyer@test.local', '+971501112233', pi, JSON.stringify(ship)).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)')
    .run(orderId, productId, shopId, 'Vase');
  return orderId;
}
const AD_BUYER = { name: 'Buyer B', line: 'Villa 4, Street 12', city: 'Saadiyat, Abu Dhabi', emirate: 'Abu Dhabi', country: 'United Arab Emirates' };
async function paidShipment(pid, pi, ship = AD_BUYER) {
  const oid = mkPaidOrder(pid, pi, ship);
  await ctx.postWebhook({ id: 'evt_' + pi, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(oid) } } } });
  await waitFor(() => (db.prepare('SELECT delivery_ref FROM shipments WHERE order_id=?').get(oid) || {}).delivery_ref);
  return { oid, sh: db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid) };
}
const sign = (orderId, status, ts) => crypto.createHmac('sha256', 'oto-secret').update(`${orderId}:${status}:${ts}`).digest('base64');
const hook = (body, t = 'status', headers = {}) => fetch(`${ctx.baseUrl}/api/delivery/oto-webhook?t=${t}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
let tsN = 1595941360000;
const signedHook = (orderId, status, extra = {}) => {
  const timestamp = String(++tsN);
  return hook({ orderId, status, timestamp, signature: sign(orderId, status, timestamp), ...extra });
};

before(async () => {
  fake = http.createServer(otoApi);
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.OTO_API_URL = `http://127.0.0.1:${fake.address().port}`;
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?, 'Mara Maker','seller')")
    .run(sellerEmail, hashPassword('testpass123')).lastInsertRowid;
  shopId = db.prepare(`INSERT INTO shops (user_id,name,slug,status,location,pickup_address,pickup_phone)
    VALUES (?,?,?, 'approved','Al Quoz, Dubai','Unit 9, Alserkal Avenue, Al Quoz 1, Dubai','+971509998877')`)
    .run(uid, 'Oto Pots', 'oto-pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,50,'live')")
    .run(shopId, 'Vase', 'Ceramics').lastInsertRowid;
});
after(async () => { await ctx.close(); await new Promise((r) => fake.close(r)); });
beforeEach(() => { calls.length = 0; });

test('payload builders: one pre-paid AED order per shop parcel, maker as the pickup location, buyer phone from the order', () => {
  const oto = require('../src/delivery/oto-live');
  const shipment = { id: 7, public_id: 'TRV-ABC123', buyer_phone: '+971501112233', shipping_json: JSON.stringify(AD_BUYER) };
  const shop = { id: 3, name: 'Oto Pots', location: 'Al Quoz, Dubai', pickup_address: 'Unit 9, Alserkal Avenue', pickup_phone: '+971509998877', owner_name: 'Mara Maker', owner_email: 'mara@test.local' };
  const items = [{ id: 41, name_snapshot: 'Vase', price_cents: 12500, qty: 2 }];

  const o = oto._order(shipment, shop, items);
  assert.equal(o.orderId, 'TRV-ABC123-7');
  assert.equal(o.pickupLocationCode, 'trove-shop-3');
  assert.equal(o.payment_method, 'paid');
  assert.equal(o.amount, 250);
  assert.equal(o.amount_due, 0);
  assert.equal(o.currency, 'AED');
  assert.equal(o.customer.name, 'Buyer B');
  assert.equal(o.customer.mobile, '971501112233');
  assert.equal(o.customer.city, 'Abu Dhabi');
  assert.equal(o.customer.district, 'Saadiyat');
  assert.equal(o.customer.country, 'AE');
  assert.equal(o.customer.email, undefined, 'the buyer email never leaves Trove');
  assert.deepEqual(o.items, [{ name: 'Vase', price: 125, rowTotal: 250, quantity: 2, sku: 'OI-41' }]);
  assert.equal(o.senderInformation, undefined, 'pickupLocationCode and senderInformation are exclusive');

  const loc = oto._location(shop);
  assert.equal(loc.code, 'trove-shop-3');
  assert.equal(loc.type, 'warehouse');
  assert.equal(loc.mobile, '971509998877');
  assert.equal(loc.city, 'Dubai');
  assert.equal(loc.address, 'Unit 9, Alserkal Avenue');
  assert.equal(loc.contactName, 'Mara Maker');
  assert.equal(loc.contactEmail, 'mara@test.local');
  assert.equal(oto._location({ id: 4, name: 'AD Shop', location: 'Khalifa City, Abu Dhabi' }).city, 'Abu Dhabi');
});

test('courier choice: cheapest door-to-door WITH a courier pickup — never lockers, counters or drop-off-only', () => {
  const oto = require('../src/delivery/oto-live');
  assert.equal(oto._chooseOption(OPTIONS, '').deliveryOptionName, 'iMile');
  assert.equal(oto._chooseOption(OPTIONS, 'sameDay').deliveryOptionName, 'Deliver Now');
  assert.equal(oto._chooseOption(OPTIONS, 'nonexistent').deliveryOptionName, 'iMile', 'unknown preference falls back to cheapest');
  assert.equal(oto._chooseOption(OPTIONS.slice(0, 3), ''), null);
  assert.equal(oto._chooseOption([], ''), null);

  // Real Dubai → Abu Dhabi quote (2026-09-21): Aramex PUDO is drop-off only,
  // cold chain is a specialist lane, and the AED 17 tie goes to the AED 17 return.
  const live = [
    { deliveryOptionId: 10063, deliveryOptionName: 'Aramex PUDO', serviceType: 'pudo', deliveryType: 'pickupByCustomer', pickupDropoff: 'dropoffOnly', price: 13, returnFee: 13 },
    { deliveryOptionId: 9939, deliveryOptionName: 'AJEX Logistics Next Day Delivery', serviceType: 'express', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 17, returnFee: 34 },
    { deliveryOptionId: 5446, deliveryOptionName: 'Aramex', serviceType: 'express', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 17, returnFee: 17 },
    { deliveryOptionId: 5451, deliveryOptionName: 'Transcorp Cold', serviceType: 'coldDelivery', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 16, returnFee: 16 },
    { deliveryOptionId: 5443, deliveryOptionName: 'Quiqup', serviceType: 'express', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 26, returnFee: 26 },
  ];
  assert.equal(oto._chooseOption(live, '').deliveryOptionName, 'Aramex');
  assert.equal(oto._chooseOption(live, 'coldDelivery').deliveryOptionName, 'Transcorp Cold', 'a specialist lane only when asked for');
});

test('payment books it: pickup location for the maker, then the order in OTO — no courier yet', async () => {
  const health = await ctx.api('GET', '/api/health');
  assert.equal(health.data.delivery, 'oto');

  const { sh } = await paidShipment('TRV-OT01', 'pi_ot_1');
  assert.equal(sh.delivery_ref, `TRV-OT01-${sh.id}`);
  assert.equal(sh.carrier, 'OTO');
  assert.equal(byPath('/refreshToken').length <= 1, true);

  const [loc] = byPath('/createPickupLocation');
  assert.equal(loc.body.code, `trove-shop-${shopId}`);
  assert.equal(loc.body.mobile, '971509998877');
  assert.equal(loc.body.contactEmail, sellerEmail);
  assert.equal(loc.auth, 'Bearer at-1');

  const [ord] = byPath('/createOrder');
  assert.equal(ord.body.orderId, sh.delivery_ref);
  assert.equal(ord.body.pickupLocationCode, `trove-shop-${shopId}`);
  assert.equal(ord.body.customer.city, 'Abu Dhabi');
  assert.equal(ord.body.amount, 200);
  assert.equal(ord.body.items[0].sku.startsWith('OI-'), true);
  assert.equal(ord.body.createShipment, undefined, 'the courier is only booked once the maker has packed');
  assert.equal(byPath('/createShipment').length, 0);

  // A second order for the same shop reuses the location (no second create).
  calls.length = 0;
  await paidShipment('TRV-OT02', 'pi_ot_2');
  assert.equal(byPath('/createPickupLocation').length + byPath('/updatePickupLocation').length, 0);
  assert.equal(byPath('/createOrder').length, 1);
});

test('pickup location upsert: an edited address is pushed with update; a forgotten location is re-created', async () => {
  const oto = require('../src/delivery/oto-live');
  db.prepare("UPDATE shops SET pickup_address='Warehouse 4, Street 8, Al Quoz 3, Dubai' WHERE id=?").run(shopId);
  await paidShipment('TRV-OT03', 'pi_ot_3');
  const [upd] = byPath('/updatePickupLocation');
  assert.equal(upd.body.address, 'Warehouse 4, Street 8, Al Quoz 3, Dubai');
  assert.equal(byPath('/createPickupLocation').length, 0);

  // After a restart the cache is empty: create says "exists" → update wins.
  oto._synced.clear();
  calls.length = 0;
  await paidShipment('TRV-OT04', 'pi_ot_4');
  assert.equal(byPath('/createPickupLocation').length, 1);
  assert.equal(byPath('/updatePickupLocation').length, 1);
  assert.equal(byPath('/createOrder').length, 1);
});

test('"Packed · ready for collection" books the cheapest pickup courier once; label redirects to OTO', async () => {
  const { sh } = await paidShipment('TRV-OT05', 'pi_ot_5');
  const cookie = await ctx.loginAs(sellerEmail, 'testpass123');
  calls.length = 0;

  const r = await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'shipped' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(await waitFor(() => db.prepare('SELECT ready_at FROM shipments WHERE id=?').get(sh.id).ready_at));

  const [fee] = byPath('/checkOTODeliveryFee');
  assert.equal(fee.body.originCity, 'Dubai');
  assert.equal(fee.body.destinationCity, 'Abu Dhabi');
  const [ship] = byPath('/createShipment');
  assert.deepEqual(ship.body, { orderId: sh.delivery_ref, deliveryOptionId: 7147, pickingType: 'PICKUP_BY_DC' });
  const row = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(row.carrier, 'iMile');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Ready for collection · iMile%'").get(sh.id).n, 1);

  // Undo + re-ship does not book a second courier.
  await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'processing' } });
  await ctx.api('PATCH', `/api/seller/shipments/${sh.id}`, { cookie, body: { status: 'shipped' } });
  await sleep(80);
  assert.equal(byPath('/createShipment').length, 1);

  const lab = await ctx.api('GET', `/api/seller/shipments/${sh.id}/label`, { cookie });
  assert.equal(lab.status, 302);
  assert.equal(lab.headers.get('location'), 'https://app.tryoto.com/print/awb?enc=abc');
});

test('a pinned courier (OTO_DELIVERY_OPTION_ID) skips the price check', async () => {
  const { sh } = await paidShipment('TRV-OT06', 'pi_ot_6');
  process.env.OTO_DELIVERY_OPTION_ID = '22';
  try {
    calls.length = 0;
    await require('../src/delivery').markReady(sh.id);
    assert.equal(byPath('/checkOTODeliveryFee').length, 0);
    assert.equal(byPath('/createShipment')[0].body.deliveryOptionId, 22);
  } finally { delete process.env.OTO_DELIVERY_OPTION_ID; }
});

test('OTO webhook: signed statuses drive the shipment, pick up courier + tracking; bad signature refused; replays deduped', async () => {
  const { oid, sh } = await paidShipment('TRV-OT07', 'pi_ot_7');
  const ref = sh.delivery_ref;

  let r = await hook({ orderId: ref, status: 'pickedUp', timestamp: '1', signature: 'nope' });
  assert.equal(r.status, 401);
  r = await hook({ orderId: ref, status: 'pickedUp' });
  assert.equal(r.status, 401, 'unsigned is refused when the secret is set');

  r = await signedHook(ref, 'searchingDriver');
  assert.deepEqual(await r.json(), { received: true, matched: true });
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'processing');

  const ts = String(++tsN);
  const body = { orderId: ref, status: 'pickedUp', timestamp: ts, signature: sign(ref, 'pickedUp', ts),
    deliveryCompany: 'aramex', dcTrackingNumber: 'AR-99887', brandedTrackingURL: 'https://app.tryoto.com/sms/order-tracking?key=abc' };
  r = await hook(body);
  let row = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(row.status, 'shipped');
  assert.equal(row.carrier, 'Aramex');
  assert.equal(row.tracking_number, 'AR-99887');
  assert.equal(row.tracking_url, 'https://app.tryoto.com/sms/order-tracking?key=abc');
  r = await hook(body); // redelivery
  assert.deepEqual(await r.json(), { received: true, duplicate: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND status='shipped'").get(sh.id).n, 1);

  r = await signedHook(ref, 'undeliveredAttempt', { attemptFailureReason: 'Customer was not in the house' });
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'shipped');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Delivery attempt failed%not in the house%'").get(sh.id).n, 1);

  // The authorization key header is accepted too.
  r = await hook({ orderId: ref, status: 'outForDelivery', timestamp: String(++tsN) }, 'status', { Authorization: 'oto-secret' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'out_for_delivery');

  r = await signedHook(ref, 'delivered');
  row = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
  assert.equal(row.status, 'delivered');
  assert.ok(row.delivered_at && row.return_window_ends_at);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(oid).status, 'fulfilled');

  // A late transit event never pulls a delivered parcel back.
  await signedHook(ref, 'inTransit');
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'delivered');

  r = await signedHook('TRV-NOPE-1', 'pickedUp');
  assert.deepEqual(await r.json(), { received: true, matched: false });
});

test('shipmentError webhook: timeline note + hand-over cleared so re-marking packed retries', async () => {
  const { sh } = await paidShipment('TRV-OT08', 'pi_ot_8');
  await require('../src/delivery').markReady(sh.id);
  assert.ok(db.prepare('SELECT ready_at FROM shipments WHERE id=?').get(sh.id).ready_at);
  const ts = String(++tsN);
  const r = await hook({ orderId: sh.delivery_ref, errorCode: 'deliveryCompanyError', errorMessage: 'delivery company not allow to create shipment',
    deliveryCompany: 'aramex', timestamp: ts, signature: sign(sh.delivery_ref, 'deliveryCompanyError', ts) }, 'error');
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT ready_at FROM shipments WHERE id=?').get(sh.id).ready_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Courier booking failed (aramex)%'").get(sh.id).n, 1);
});

test('returns: the courier collects the named pieces from the buyer and brings them to the maker', async () => {
  const { sh } = await paidShipment('TRV-OT09', 'pi_ot_9');
  const item = db.prepare('SELECT * FROM order_items WHERE order_id=?').get(sh.order_id);
  calls.length = 0;
  const res = await require('../src/delivery').bookReversePickup(sh.id, [{ order_item_id: item.id, qty: 1 }]);
  assert.equal(res.ref, `${sh.delivery_ref}-R1`);
  const [fee] = byPath('/checkOTODeliveryFee');
  assert.equal(fee.body.forReverseShipment, true);
  assert.equal(fee.body.originCity, 'Abu Dhabi');
  assert.equal(fee.body.destinationCity, 'Dubai');
  const [ret] = byPath('/createReturnShipment');
  assert.equal(ret.body.orderId, sh.delivery_ref);
  assert.equal(ret.body.pickupLocationCode, `trove-shop-${shopId}`);
  assert.equal(ret.body.pickingType, 'PICKUP_BY_DC');
  assert.deepEqual(ret.body.items, [{ sku: `OI-${item.id}`, quantity: '1' }]);

  // Return-leg webhook events land on the timeline without touching the forward status.
  db.prepare("UPDATE shipments SET status='delivered' WHERE id=?").run(sh.id);
  const ts = String(++tsN);
  await hook({ orderId: sh.delivery_ref, returnOrderId: res.ref, status: 'delivered', returnStatus: 'reversePickedUp', timestamp: ts, signature: sign(sh.delivery_ref, 'delivered', ts) });
  assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'delivered');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Return collected from the buyer%'").get(sh.id).n, 1);
});

test('ensureWebhooks registers status + error subscriptions once, and refreshes a changed secret in place', async () => {
  const oto = require('../src/delivery/oto-live');
  const done = await oto.ensureWebhooks('https://troveathome.com/', 'oto-secret');
  assert.deepEqual(done, ['orderStatus', 'shipmentError']);
  assert.deepEqual(hooks.map((h) => [h.url, h.webhookType, h.secretKey, h.authorizationKey]), [
    ['https://troveathome.com/api/delivery/oto-webhook?t=status', 'orderStatus', 'oto-secret', 'oto-secret'],
    ['https://troveathome.com/api/delivery/oto-webhook?t=error', 'shipmentError', 'oto-secret', 'oto-secret'],
  ]);
  calls.length = 0;
  await oto.ensureWebhooks('https://troveathome.com', 'oto-secret');
  assert.equal(calls.filter((c) => c.path === '/webhook' && c.method !== 'GET').length, 0, 'idempotent');
  await oto.ensureWebhooks('https://troveathome.com', 'rotated');
  assert.equal(calls.filter((c) => c.path === '/webhook' && c.method === 'PUT').length, 2);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].secretKey, 'rotated');
});
