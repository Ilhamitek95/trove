'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '' }); // demo-payments mode: everything arrives in one call

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * The buyer's contact number: required so the courier can call on the day,
 * stored on its own orders column, and never handed to a shop. Trove books
 * the pickup and is the merchant of record, so the number belongs on Trove's
 * courier booking — not in the maker's dashboard, where it would be the same
 * off-platform channel the buyer email was closed off from.
 */

const ADDRESS = { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' };
let ctx, db, buyerCookie, sellerCookie, adminCookie, mugId;

const checkout = (body, cookie) => ctx.api('POST', '/api/checkout', { cookie: cookie || buyerCookie, body: { items: [{ productId: mugId, qty: 1 }], address: ADDRESS, ...body } });

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal Rashid','buyer')").run(pw);
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?, 'Boss','admin')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  mugId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shopId, 'Mug', 'Ceramics', 6400, 9).lastInsertRowid;

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('an order cannot be placed without a reachable UAE mobile', async () => {
  const missing = await checkout({});
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /mobile/i);

  for (const bad of ['04 555 1234', '+44 7700 900123', '12345', '971 4 555 1234']) {
    const res = await checkout({ phone: bad });
    assert.equal(res.status, 400, `${bad} is not a UAE mobile`);
    assert.match(res.data.error, /mobile/i);
  }
});

test('however it is typed, the number is stored in one canonical shape', async () => {
  for (const typed of ['050 123 4567', '+971 50 123 4567', '971501234567', '50-123-4567']) {
    const res = await checkout({ phone: typed });
    assert.equal(res.status, 200, res.text);
    const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(res.data.orderId);
    assert.equal(order.phone, '+971501234567', `${typed} normalised`);
  }
});

test('the number never lands inside the shipping snapshot, even if the client puts it there', async () => {
  // The seller payload hands over the parsed shipping_json — anything in
  // there reaches every shop in the order.
  const res = await checkout({ phone: '050 123 4567', address: { ...ADDRESS, phone: '0509999999' } });
  assert.equal(res.status, 200, res.text);
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(res.data.orderId);
  assert.ok(!order.shipping_json.includes('9999999'), 'smuggled number stripped from the snapshot');
  assert.ok(!order.shipping_json.includes('phone'), 'no phone key at all in the snapshot');
  assert.equal(order.phone, '+971501234567', 'the real field still captured it');
});

test('the shop sees the address it must post to — and no way to ring the buyer', async () => {
  const res = await checkout({ phone: '050 123 4567' });
  await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: res.data.orderId } });

  const seller = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  assert.equal(seller.status, 200);
  assert.ok(!seller.text.includes('501234567'), 'buyer number absent from the whole seller payload');
  assert.ok(!seller.text.includes('phone'), 'not even an empty phone key to fill in later');
  const mine = seller.data.orders.find((o) => o.order.publicId === res.data.orderId);
  assert.equal(mine.order.ship.line, ADDRESS.line, 'the packing address is still complete');

  const admin = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  const row = admin.data.orders.find((o) => o.publicId === res.data.orderId);
  assert.equal(row.phone, '+971501234567', 'Trove support and the courier desk can still reach them');
});

test('the courier booking carries the number Trove holds', async () => {
  const quiqup = require('../src/delivery/quiqup-live');
  const job = quiqup._job('pickup', {
    id: 7, order_id: 3, public_id: 'TRV-TEST01',
    shipping_json: JSON.stringify(ADDRESS),   // no phone in here, by design
    buyer_phone: '+971501234567',
  }, { name: 'Test Pots', location: 'Al Quoz, Dubai' });
  assert.equal(job.dropoff.phone, '+971501234567', 'the driver can call ahead');
  assert.equal(job.pickup.name, 'Test Pots');
});
