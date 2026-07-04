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
