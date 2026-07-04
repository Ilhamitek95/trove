'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv(); // no ANTHROPIC_API_KEY → admin suggest-tags must answer 503

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, sellerCookie, productId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?, 'Boss','admin')")
    .run(hashPassword('testpass123'));
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')")
    .run(uid, 'Test Pots', 'test-pots').lastInsertRowid;
  productId = db.prepare(`INSERT INTO products (shop_id,name,category,price_cents,stock,status,tags)
    VALUES (?,?,?,?,?,?,?)`).run(shopId, 'Reeded Vase', 'Ceramics', 12000, 4, 'live', '["bud vase"]').lastInsertRowid;
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('the catalogue view is admin-only and carries shop + tags', async () => {
  let res = await ctx.api('GET', '/api/admin/products', { cookie: sellerCookie });
  assert.equal(res.status, 403);
  res = await ctx.api('GET', '/api/admin/products', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const p = res.data.products.find((x) => x.id === productId);
  assert.equal(p.shop.name, 'Test Pots');
  assert.deepEqual(p.tags, ['bud vase']);
});

test('admin can hide a product (drops off the storefront) and put it live again', async () => {
  let res = await ctx.api('PATCH', `/api/admin/products/${productId}`, { cookie: adminCookie, body: { status: 'hidden' } });
  assert.equal(res.status, 200);
  let pub = await ctx.api('GET', '/api/products');
  assert.ok(!pub.data.products.find((x) => x.id === productId), 'hidden product is not public');

  res = await ctx.api('PATCH', `/api/admin/products/${productId}`, { cookie: adminCookie, body: { status: 'live' } });
  assert.equal(res.data.product.status, 'live');
  pub = await ctx.api('GET', '/api/products');
  assert.ok(pub.data.products.find((x) => x.id === productId), 'back on the storefront');

  res = await ctx.api('PATCH', `/api/admin/products/${productId}`, { cookie: adminCookie, body: { status: 'vanished' } });
  assert.equal(res.status, 400);
});

test('admin tag and category edits validate like seller ones', async () => {
  let res = await ctx.api('PATCH', `/api/admin/products/${productId}`, {
    cookie: adminCookie, body: { tags: ['Flower Vase', 'FLOWER VASE', ' decor '] },
  });
  assert.equal(res.data.product.tags, JSON.stringify(['flower vase', 'decor']));

  res = await ctx.api('PATCH', `/api/admin/products/${productId}`, { cookie: adminCookie, body: { category: 'Skincare' } });
  assert.equal(res.status, 422);

  res = await ctx.api('PATCH', `/api/admin/products/${productId}`, { cookie: adminCookie, body: { category: 'Home' } });
  assert.equal(res.data.product.category, 'Home');
});

test('admin suggest-tags gates on the key like the seller one', async () => {
  const res = await ctx.api('POST', `/api/admin/products/${productId}/suggest-tags`, { cookie: adminCookie, body: {} });
  assert.equal(res.status, 503);
  const signedOut = await ctx.api('POST', `/api/admin/products/${productId}/suggest-tags`, { body: {} });
  assert.equal(signedOut.status, 401);
});
