'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?, 'Boss','admin')")
    .run(hashPassword('testpass123'));
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('shopper@test.local',?, 'Shopper','buyer')")
    .run(hashPassword('testpass123'));
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('the search beacon normalises and stores queries; junk is dropped', async () => {
  let res = await ctx.api('POST', '/api/search-log', { body: { q: '  Coffee MUG!! ', results: 3 } });
  assert.equal(res.status, 204);
  res = await ctx.api('POST', '/api/search-log', { body: { q: '   ', results: 9 } });
  assert.equal(res.status, 204);
  res = await ctx.api('POST', '/api/search-log', { body: {} });
  assert.equal(res.status, 204);

  const rows = db.prepare('SELECT q, results FROM search_log').all();
  assert.deepEqual(rows, [{ q: 'coffee mug', results: 3 }]);
});

test('server-side ?q= searches are logged with their hit count', async () => {
  await ctx.api('GET', '/api/products?q=lantern');
  const row = db.prepare("SELECT q, results FROM search_log WHERE q='lantern'").get();
  assert.deepEqual(row, { q: 'lantern', results: 0 });
});

test('topSearchTerms ranks by frequency inside the window', () => {
  const { logSearch, topSearchTerms } = require('../src/trends');
  for (let i = 0; i < 5; i++) logSearch('eid gift', 2);
  for (let i = 0; i < 2; i++) logSearch('brass tray', 4);
  // an old search outside the window must not count
  db.prepare("INSERT INTO search_log (q, results, created_at) VALUES ('fossil', 0, datetime('now','-45 days'))").run();

  const terms = topSearchTerms(30, 10);
  assert.equal(terms[0].q, 'eid gift');
  assert.equal(terms[0].n, 5);
  assert.ok(!terms.find((t) => t.q === 'fossil'), 'out-of-window term excluded');
});

test('purgeOld trims entries older than 90 days', () => {
  const { purgeOld } = require('../src/trends');
  db.prepare("INSERT INTO search_log (q, results, created_at) VALUES ('ancient', 0, datetime('now','-120 days'))").run();
  assert.ok(purgeOld() >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM search_log WHERE q='ancient'").get().c, 0);
});

test('popular searches are public and only recommend terms that still find pieces', async () => {
  const { logSearch } = require('../src/trends');
  const { hashPassword } = require('../src/middleware');
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('potter@test.local',?, 'Potter','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')")
    .run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,6400,5,'live')")
    .run(shopId, 'Speckled Mug', 'Ceramics');
  // "mug" finds a live piece; log it as a frequent search.
  for (let i = 0; i < 4; i++) logSearch('mug', 1);
  // Poison attempt: junk term with a fabricated hit count must never surface,
  // because the serve-time catalogue check finds nothing for it.
  for (let i = 0; i < 3; i++) logSearch('unicorn saddle', 50);
  // Too short to recommend even if it found things.
  logSearch('ox', 5);

  const res = await ctx.api('GET', '/api/search/popular');
  assert.equal(res.status, 200);
  assert.ok(res.data.terms.includes('mug'), 'catalogue-matching term recommended');
  assert.ok(!res.data.terms.includes('unicorn saddle'), 'fabricated counts cannot surface junk');
  assert.ok(!res.data.terms.includes('ox'), 'too-short term excluded');
  assert.ok(!res.data.terms.includes('lantern'), 'zero-result term excluded');
  assert.ok(res.data.terms.length <= 6);
});

test('search trends are admin-only', async () => {
  let res = await ctx.api('GET', '/api/admin/search-trends');
  assert.equal(res.status, 401);
  const buyerCookie = await ctx.loginAs('shopper@test.local', 'testpass123');
  res = await ctx.api('GET', '/api/admin/search-trends', { cookie: buyerCookie });
  assert.equal(res.status, 403);
  res = await ctx.api('GET', '/api/admin/search-trends', { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.days, 30);
  assert.equal(res.data.terms[0].q, 'eid gift');
});
