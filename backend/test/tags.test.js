'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv(); // no ANTHROPIC_API_KEY → the AI endpoint must answer 503, never call out

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, sellerCookie, productId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(uid, 'Test Pots', 'test-pots');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('normalizeTags cleans, dedupes and caps input', () => {
  const { normalizeTags } = require('../src/tags');
  assert.deepEqual(
    normalizeTags(['  Stoneware ', 'STONEWARE', '#coffee mug!!', "maker's choice", '', null, 'a'.repeat(60)]),
    ['stoneware', 'coffee mug', "maker's choice", 'a'.repeat(28)]);
  assert.deepEqual(normalizeTags('not json, but, a, list'), ['not json', 'but', 'a', 'list']);
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_, i) => `tag ${i}`)).length, 12);
  assert.deepEqual(normalizeTags({ nope: true }), []);
});

test('a seller can save tags and shoppers can search by them', async () => {
  const created = await ctx.api('POST', '/api/seller/products', {
    cookie: sellerCookie,
    body: { name: 'Reeded Vase', price: 120, status: 'live', category: 'Ceramics', tags: ['Bud Vase', 'wheel thrown', 'BUD VASE'] },
  });
  assert.equal(created.status, 201, created.text);
  productId = created.data.product.id;
  assert.equal(created.data.product.tags, JSON.stringify(['bud vase', 'wheel thrown']));

  // Public API exposes tags as an array...
  const pub = await ctx.api('GET', `/api/products/${productId}`);
  assert.deepEqual(pub.data.product.tags, ['bud vase', 'wheel thrown']);

  // ...and ?q= matches them (name doesn't contain "bud").
  const hit = await ctx.api('GET', '/api/products?q=bud%20vase');
  assert.equal(hit.data.products.length, 1);
  assert.equal(hit.data.products[0].id, productId);
  const miss = await ctx.api('GET', '/api/products?q=macrame');
  assert.equal(miss.data.products.length, 0);
});

test('PATCH replaces tags; omitting the field leaves them alone', async () => {
  let res = await ctx.api('PATCH', `/api/seller/products/${productId}`, {
    cookie: sellerCookie, body: { tags: ['flower vase'] },
  });
  assert.equal(res.data.product.tags, JSON.stringify(['flower vase']));

  res = await ctx.api('PATCH', `/api/seller/products/${productId}`, {
    cookie: sellerCookie, body: { price: 130 },
  });
  assert.equal(res.data.product.tags, JSON.stringify(['flower vase']), 'tags untouched when not sent');
});

test('suggest-tags: 503 without a key, 400 without a name, 401 signed out', async () => {
  const noKey = await ctx.api('POST', '/api/seller/products/suggest-tags', {
    cookie: sellerCookie, body: { name: 'Reeded Vase' },
  });
  assert.equal(noKey.status, 503);
  assert.match(noKey.data.error, /not switched on/);

  const noName = await ctx.api('POST', '/api/seller/products/suggest-tags', { cookie: sellerCookie, body: {} });
  // Gate order: the feature flag answers first, so without a key this is still 503.
  assert.equal(noName.status, 503);

  const signedOut = await ctx.api('POST', '/api/seller/products/suggest-tags', { body: { name: 'X' } });
  assert.equal(signedOut.status, 401);
});

test('/api/config reports the AI tags flag', async () => {
  const res = await ctx.api('GET', '/api/config');
  assert.equal(res.data.aiTagsEnabled, false);
});
