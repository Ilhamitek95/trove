'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Trove is the merchant of record, so a shop fulfils an order without ever
 * needing to contact the customer. Keeping the buyer's email out of every
 * seller-facing payload is what keeps the sale on-platform — a maker who has
 * the address can take the next order off it, unmonitored. Admin still sees it.
 */

const BUYER_EMAIL = 'reem@test.local';
let ctx, db, sellerCookie, adminCookie, orderId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');

  const buyer = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?, 'Reem Saleh','buyer')").run(BUYER_EMAIL, pw).lastInsertRowid;
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?, 'Boss','admin')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;

  const ship = JSON.stringify({ name: 'Reem Saleh', line: 'Villa 8, Al Barsha 1', city: 'Al Barsha, Dubai', country: 'United Arab Emirates' });
  orderId = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,service_fee_cents,total_cents,status,shipping_json,delivered_at)
    VALUES ('TRV-PRIV01',?,?,6400,900,9800, 'fulfilled', ?, datetime('now','-1 day'))`).run(buyer, BUYER_EMAIL, ship).lastInsertRowid;
  const itemId = db.prepare("INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?, 'Mug', 6400, 1)").run(orderId, shopId).lastInsertRowid;
  db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?, 'delivered')").run(orderId, shopId);

  // A return touching this shop's item, so the seller returns view has a row.
  const rr = db.prepare(`INSERT INTO return_requests (order_id,buyer_id,reason,details,images,status)
    VALUES (?,?, 'damaged', 'Chipped on the rim.', '[]', 'requested')`).run(orderId, buyer).lastInsertRowid;
  db.prepare('INSERT INTO return_request_items (request_id,order_item_id,qty) VALUES (?,?,1)').run(rr, itemId);

  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('a seller never receives the buyer email — on orders or returns', async () => {
  const orders = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  assert.equal(orders.status, 200);
  assert.equal(orders.data.orders.length, 1, 'the shop sees its order');
  assert.ok(!orders.text.includes(BUYER_EMAIL), 'buyer email absent from the whole orders payload');
  assert.equal(orders.data.orders[0].order.email, undefined, 'no email key on the order object');

  const returns = await ctx.api('GET', '/api/seller/returns', { cookie: sellerCookie });
  assert.equal(returns.status, 200);
  assert.equal(returns.data.returns.length, 1, 'the shop sees the return');
  assert.ok(!returns.text.includes(BUYER_EMAIL), 'buyer email absent from the returns payload');
});

test('the seller still gets everything needed to pack and post the parcel', async () => {
  const res = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  const ship = res.data.orders[0].order.ship;
  assert.equal(ship.name, 'Reem Saleh', 'packing name');
  assert.equal(ship.line, 'Villa 8, Al Barsha 1');
  assert.equal(ship.city, 'Al Barsha, Dubai');
  assert.equal(res.data.orders[0].order.publicId, 'TRV-PRIV01');
});

test('admin keeps the buyer email — the boundary is the seller, not the platform', async () => {
  const res = await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.orders.find((o) => o.publicId === 'TRV-PRIV01');
  assert.equal(row.email, BUYER_EMAIL, 'Trove support can still reach the customer');
});
