'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 1×1 transparent PNG — enough to exercise the image pipeline.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let ctx, db, sellerCookie, buyerCookie;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?, 'Buyer','buyer')").run(pw);
  db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(seller, 'Test Pots', 'test-pots');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('buyer@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const onDisk = (url) => path.join(process.env.UPLOADS_DIR, url.replace('/uploads/', ''));

test('photos ride along on create, serve publicly, and swap/remove on edit', async () => {
  let res = await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie,
    body: { name: 'Reeded Mug', price: 64, stock: 3, status: 'live', images: [PNG, PNG] } });
  assert.equal(res.status, 201, res.text);
  const id = res.data.product.id;
  const stored = JSON.parse(res.data.product.images);
  assert.equal(stored.length, 2);
  assert.match(stored[0], /^\/uploads\/products\//);
  assert.ok(fs.existsSync(onDisk(stored[0])), 'file written to disk');

  // Public catalogue exposes them; the storefront uses the first as cover.
  res = await ctx.api('GET', '/api/products');
  const pub = res.data.products.find((p) => p.id === id);
  assert.deepEqual(pub.images, stored);

  // The photo file itself is served.
  const img = await fetch(ctx.baseUrl + stored[0]);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  // Edit: keep the second photo, add a new one, drop the first → old file gone.
  res = await ctx.api('PATCH', `/api/seller/products/${id}`, { cookie: sellerCookie,
    body: { images: [stored[1], PNG] } });
  assert.equal(res.status, 200, res.text);
  const after1 = JSON.parse(res.data.product.images);
  assert.equal(after1.length, 2);
  assert.equal(after1[0], stored[1], 'kept photo stays first (the cover)');
  assert.ok(!fs.existsSync(onDisk(stored[0])), 'dropped file deleted');

  // Clear all photos → back to the motif tile, files cleaned up.
  res = await ctx.api('PATCH', `/api/seller/products/${id}`, { cookie: sellerCookie, body: { images: [] } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.data.product.images).length, 0);
  assert.ok(!fs.existsSync(onDisk(after1[0])), 'cleared files deleted');
});

test('guardrails: max 4 photos, real images only, sellers only', async () => {
  let res = await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie,
    body: { name: 'Too Many', price: 10, images: [PNG, PNG, PNG, PNG, PNG] } });
  assert.equal(res.status, 400, 'five photos rejected');

  res = await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie,
    body: { name: 'Bad File', price: 10, images: ['data:image/png;base64,aGVsbG8='] } });
  assert.equal(res.status, 400, 'not a real image');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM products WHERE name='Bad File'").get().c, 0,
    'no half-created product left behind');

  res = await ctx.api('POST', '/api/seller/products', { cookie: buyerCookie, body: { name: 'Nope', price: 10, images: [PNG] } });
  assert.equal(res.status, 403);

  // A crafted /uploads path that was never this product's is ignored, not kept.
  res = await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie,
    body: { name: 'Sneaky', price: 10, images: ['/uploads/products/not-mine.jpg'] } });
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.data.product.images).length, 0, 'unknown stored URL dropped');
});

test('deleting a product cleans its photo files off the disk', async () => {
  let res = await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie,
    body: { name: 'Short Lived', price: 10, images: [PNG] } });
  const id = res.data.product.id;
  const url = JSON.parse(res.data.product.images)[0];
  assert.ok(fs.existsSync(onDisk(url)));
  res = await ctx.api('DELETE', `/api/seller/products/${id}`, { cookie: sellerCookie });
  assert.equal(res.status, 200);
  assert.ok(!fs.existsSync(onDisk(url)), 'photo removed with the product');
});
