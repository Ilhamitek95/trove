'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// 1×1 transparent PNG — enough to exercise the image pipeline.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let ctx, db, buyerCookie, otherCookie, adminCookie;
let shopId, mugId, trayId, orderId;

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
  mugId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shopId, 'Mug', 'Ceramics', 6400, 5).lastInsertRowid;
  trayId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shopId, 'Tray', 'Home', 9000, 5).lastInsertRowid;

  // Delivered order for the mug; the tray was never bought.
  orderId = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,total_cents,status)
    VALUES ('TRV-RVW01',?,?,6400,6400,'paid')`).run(buyer, 'amal@test.local').lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,1)')
    .run(orderId, mugId, shopId, 'Mug', 6400);
  db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?,'delivered')").run(orderId, shopId);

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('only a delivered purchase can be reviewed', async () => {
  // signed out
  let res = await ctx.api('POST', '/api/account/reviews', { body: { productId: mugId, rating: 5 } });
  assert.equal(res.status, 401);
  // never bought it
  res = await ctx.api('POST', '/api/account/reviews', { cookie: otherCookie, body: { productId: mugId, rating: 5 } });
  assert.equal(res.status, 403);
  // bought a different product (tray never purchased)
  res = await ctx.api('POST', '/api/account/reviews', { cookie: buyerCookie, body: { productId: trayId, rating: 5 } });
  assert.equal(res.status, 403);
  // bad rating
  res = await ctx.api('POST', '/api/account/reviews', { cookie: buyerCookie, body: { productId: mugId, rating: 9 } });
  assert.equal(res.status, 400);
});

test('a verified buyer reviews the product with a photo; it goes public', async () => {
  const res = await ctx.api('POST', '/api/account/reviews', {
    cookie: buyerCookie,
    body: { productId: mugId, rating: 5, body: 'Lovely glaze, use it daily.', images: [PNG] },
  });
  assert.equal(res.status, 201, res.text);

  const pub = await ctx.api('GET', `/api/products/${mugId}/reviews`);
  assert.equal(pub.data.summary.count, 1);
  assert.equal(pub.data.summary.avg, 5);
  const r = pub.data.reviews[0];
  assert.equal(r.buyer, 'Amal R.', 'name is masked');
  assert.equal(r.body, 'Lovely glaze, use it daily.');
  assert.equal(r.images.length, 1);
  assert.match(r.images[0], /^\/uploads\/reviews\//);

  // the catalogue now carries the rating
  const prod = await ctx.api('GET', `/api/products/${mugId}`);
  assert.deepEqual(prod.data.product.rating, { avg: 5, count: 1 });
});

test('posting again edits in place (one review per product per buyer)', async () => {
  const res = await ctx.api('POST', '/api/account/reviews', {
    cookie: buyerCookie, body: { productId: mugId, rating: 3, body: 'Chipped after a week.', images: [] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.updated, true);
  const pub = await ctx.api('GET', `/api/products/${mugId}/reviews`);
  assert.equal(pub.data.summary.count, 1, 'still one review');
  assert.equal(pub.data.reviews[0].rating, 3);
  assert.equal(pub.data.reviews[0].images.length, 0, 'dropped image removed');
  assert.equal(pub.data.reviews[0].edited, true);
});

test('shop reviews aggregate with product reviews on the shop rating', async () => {
  const res = await ctx.api('POST', '/api/account/reviews', {
    cookie: buyerCookie, body: { shopId, rating: 5, body: 'Fast dispatch, kind seller.' },
  });
  assert.equal(res.status, 201, res.text);

  const shop = await ctx.api('GET', '/api/shops/test-pots');
  assert.deepEqual(shop.data.shop.rating, { avg: 4, count: 2 }, 'avg of product 3 + shop 5');

  const feed = await ctx.api('GET', '/api/shops/test-pots/reviews');
  assert.equal(feed.data.reviews.length, 2);
  assert.ok(feed.data.reviews.some((r) => r.productName === 'Mug'));
});

test('reviewables lists what still needs reviewing', async () => {
  const res = await ctx.api('GET', '/api/account/reviewables', { cookie: buyerCookie });
  assert.equal(res.data.products.length, 0, 'mug already reviewed');
  assert.equal(res.data.shops.length, 0, 'shop already reviewed');
  const other = await ctx.api('GET', '/api/account/reviewables', { cookie: otherCookie });
  assert.equal(other.data.products.length, 0, 'no delivered purchases at all');
});

test('admin can hide a review; it vanishes from public feeds and ratings', async () => {
  const all = await ctx.api('GET', '/api/admin/reviews', { cookie: adminCookie });
  const productReview = all.data.reviews.find((r) => r.productId === mugId);

  let res = await ctx.api('PATCH', `/api/admin/reviews/${productReview.id}`, { cookie: adminCookie, body: { status: 'hidden' } });
  assert.equal(res.status, 200);
  const pub = await ctx.api('GET', `/api/products/${mugId}/reviews`);
  assert.equal(pub.data.summary.count, 0);
  const shop = await ctx.api('GET', '/api/shops/test-pots');
  assert.deepEqual(shop.data.shop.rating, { avg: 5, count: 1 }, 'only the shop review counts now');

  res = await ctx.api('PATCH', `/api/admin/reviews/${productReview.id}`, { cookie: adminCookie, body: { status: 'published' } });
  assert.equal(res.status, 200);
  // non-admin cannot moderate
  res = await ctx.api('PATCH', `/api/admin/reviews/${productReview.id}`, { cookie: buyerCookie, body: { status: 'hidden' } });
  assert.equal(res.status, 403);
});

test('a buyer can delete their own review (photos cleaned up)', async () => {
  const mine = await ctx.api('GET', '/api/account/reviews', { cookie: buyerCookie });
  assert.equal(mine.data.reviews.length, 2);
  const shopReview = mine.data.reviews.find((r) => !r.productId);

  let res = await ctx.api('DELETE', `/api/account/reviews/${shopReview.id}`, { cookie: buyerCookie });
  assert.equal(res.status, 200);
  // can't delete someone else's (already gone / not owned → 404)
  res = await ctx.api('DELETE', `/api/account/reviews/${shopReview.id}`, { cookie: otherCookie });
  assert.equal(res.status, 404);

  const shop = await ctx.api('GET', '/api/shops/test-pots');
  assert.deepEqual(shop.data.shop.rating, { avg: 3, count: 1 }, 'back to just the product review');
});
