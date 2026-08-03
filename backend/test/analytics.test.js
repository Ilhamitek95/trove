'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Shop analytics. Two things matter beyond the arithmetic: a beacon may only
 * ever write into the shop the piece actually belongs to (the client never
 * names the shop), and the seller payload stays aggregate — counts, never a
 * row that could point at a shopper.
 */

const V1 = 'visitoraaaa1111';
const V2 = 'visitorbbbb2222';

let ctx, db, sellerCookie, otherCookie, shopId, otherShopId, mugId, bowlId, hiddenId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');

  const buyer = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('shopper@test.local',?, 'Shopper','buyer')").run(pw).lastInsertRowid;
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  const other = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('rival@test.local',?, 'Rival','seller')").run(pw).lastInsertRowid;

  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  otherShopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(other, 'Rival Pots', 'rival-pots').lastInsertRowid;
  const pending = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'pending')").run(other, 'Not Yet', 'not-yet').lastInsertRowid;

  const addProduct = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?, 'Ceramics', ?, 5, ?)");
  mugId = addProduct.run(shopId, 'Speckled Mug', 6400, 'live').lastInsertRowid;
  bowlId = addProduct.run(shopId, 'Ash Bowl', 12000, 'live').lastInsertRowid;
  hiddenId = addProduct.run(shopId, 'Retired Jug', 9000, 'hidden').lastInsertRowid;
  addProduct.run(pending, 'Unapproved Vase', 5000, 'live');

  // One paid order for the mug, so the money columns have something real.
  const orderId = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,total_cents,status)
    VALUES ('TRV-AN0001',?, 'shopper@test.local', 12800, 12800, 'paid')`).run(buyer).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,6400,2)')
    .run(orderId, mugId, shopId, 'Speckled Mug');

  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('rival@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const track = (body, cookie) => ctx.api('POST', '/api/track', cookie ? { body, cookie } : { body });
const load = (days, cookie = sellerCookie) => ctx.api('GET', `/api/seller/analytics${days ? '?days=' + days : ''}`, { cookie });
const events = () => db.prepare('SELECT kind, shop_id, product_id, visitor, source FROM analytics_events ORDER BY id').all();

test('the beacon records the three shopper actions against the right shop', async () => {
  let res = await track({ kind: 'shop_view', shop: 'test-pots', visitor: V1, source: 'home' });
  assert.equal(res.status, 204);
  res = await track({ kind: 'product_view', productId: mugId, visitor: V1, source: 'shop' });
  assert.equal(res.status, 204);
  res = await track({ kind: 'add_to_cart', productId: mugId, visitor: V1, source: 'product' });
  assert.equal(res.status, 204);

  const rows = events();
  assert.equal(rows.length, 3);
  // The client never says which shop — it is resolved from the piece.
  assert.deepEqual(rows.map((r) => r.shop_id), [shopId, shopId, shopId]);
  assert.deepEqual(rows.map((r) => r.kind), ['shop_view', 'product_view', 'add_to_cart']);
  assert.equal(rows[0].product_id, null);
  assert.equal(rows[1].product_id, mugId);
});

test('junk beacons are dropped: unknown kind, unknown piece, unapproved shop', async () => {
  const before = events().length;
  for (const body of [
    { kind: 'wire_transfer', productId: mugId, visitor: V1 },
    { kind: 'product_view', productId: 999999, visitor: V1 },
    { kind: 'shop_view', shop: 'not-yet', visitor: V1 },
    { kind: 'shop_view', shop: 'no-such-shop', visitor: V1 },
    { kind: 'product_view', visitor: V1 },
    {},
  ]) {
    const res = await track(body);
    assert.equal(res.status, 204, 'the beacon always answers 204, whatever it did');
  }
  assert.equal(events().length, before, 'nothing was written');
});

test('a repeat inside a minute is not new interest; a new visitor is', async () => {
  const before = events().length;
  await track({ kind: 'product_view', productId: mugId, visitor: V1, source: 'shop' });
  assert.equal(events().length, before, 'same visitor, same piece, same minute → ignored');

  await track({ kind: 'product_view', productId: bowlId, visitor: V1, source: 'shop' });
  await track({ kind: 'product_view', productId: mugId, visitor: V2, source: 'search' });
  assert.equal(events().length, before + 2, 'a different piece and a different visitor both count');
});

test('a shop owner browsing their own shop is not counted', async () => {
  const before = events().length;
  const res = await track({ kind: 'product_view', productId: bowlId, visitor: 'ownerbrowsing99' }, sellerCookie);
  assert.equal(res.status, 204);
  assert.equal(events().length, before, "the owner's own visit is dropped");

  // …but another seller looking at a rival's piece is an ordinary shopper.
  await track({ kind: 'product_view', productId: bowlId, visitor: 'rivalbrowsing9' }, otherCookie);
  assert.equal(events().length, before + 1);
});

test('the summary counts interest from events and money from orders', async () => {
  const res = await load(30);
  assert.equal(res.status, 200);
  const { summary, days, countingSince } = res.data;
  assert.equal(days, 30);
  assert.ok(countingSince, 'the record has an honest start date');

  // V1 (shop view, mug view, mug add, bowl view), V2 (mug view), rival (bowl view).
  assert.equal(summary.visitors, 3);
  assert.equal(summary.shopViews, 1);
  assert.equal(summary.productViews, 4);
  assert.equal(summary.addToCart, 1);

  assert.equal(summary.orders, 1);
  assert.equal(summary.units, 2);
  assert.equal(summary.sales, 128);          // 2 × AED 64
  assert.equal(summary.earnings, 76.8);      // the maker's 60%
  assert.equal(summary.basketRate, 1 / 4);
  assert.equal(summary.orderRate, 1 / 3);
});

test('rates are null rather than zero when there is nothing to divide by', async () => {
  const res = await load(30, otherCookie);
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.productViews, 0);
  assert.equal(res.data.summary.basketRate, null, '0/0 is not 0%');
  assert.equal(res.data.summary.orderRate, null);
  assert.equal(res.data.countingSince, null, 'no events yet, so no start date is claimed');
});

test('the daily series covers every day in the window, zero-filled and in order', async () => {
  const res = await load(7);
  assert.equal(res.status, 200);
  const daily = res.data.daily;
  assert.equal(daily.length, 7);
  assert.deepEqual([...daily].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => d.date), daily.map((d) => d.date), 'oldest first');
  const today = daily[daily.length - 1];
  assert.equal(today.views, 4);
  assert.equal(today.visitors, 3);
  assert.equal(today.orders, 1);
  assert.equal(daily[0].views, 0, 'a quiet day is a real zero, not a gap');
});

test('per-piece rows carry views, baskets, units and the maker share', async () => {
  const rows = (await load(30)).data.products;
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(rows[0].name, 'Speckled Mug', 'busiest piece first');
  assert.equal(byName['Speckled Mug'].views, 2);
  assert.equal(byName['Speckled Mug'].adds, 1);
  assert.equal(byName['Speckled Mug'].units, 2);
  assert.equal(byName['Speckled Mug'].earnings, 76.8);
  assert.equal(byName['Ash Bowl'].views, 2);
  assert.equal(byName['Ash Bowl'].units, 0);
  assert.equal(byName['Ash Bowl'].earnings, 0);
  assert.equal(byName['Retired Jug'], undefined, 'hidden pieces are not listed');
});

test('a window only counts what happened inside it', async () => {
  db.prepare(`INSERT INTO analytics_events (kind, shop_id, product_id, visitor, source, created_at)
    VALUES ('product_view', ?, ?, 'oldvisitor1234', 'home', datetime('now','-40 days'))`).run(shopId, mugId);

  assert.equal((await load(7)).data.summary.productViews, 4, 'the 40-day-old view is outside a 7-day window');
  assert.equal((await load(90)).data.summary.productViews, 5, 'and inside a 90-day one');
  // A hand-typed range that is not on offer falls back to the default.
  assert.equal((await load(5000)).data.days, 30);
});

test('sources say where the views came from', async () => {
  const sources = (await load(30)).data.sources;
  const total = sources.reduce((t, s) => t + s.n, 0);
  assert.equal(total, 4);
  assert.deepEqual(sources.find((s) => s.source === 'shop'), { source: 'shop', n: 2 });
  assert.ok(sources.some((s) => s.source === 'search'));
});

test('one shop can never see another shop, and analytics needs a seller session', async () => {
  const mine = (await load(30)).data;
  const theirs = (await load(30, otherCookie)).data;
  assert.equal(mine.summary.productViews, 4);
  assert.equal(theirs.summary.productViews, 0, "the rival's own numbers are their own");
  assert.ok(!theirs.products.some((p) => p.name === 'Speckled Mug'), "no sight of another shop's pieces");

  const anon = await ctx.api('GET', '/api/seller/analytics');
  assert.equal(anon.status, 401);
});

test('the seller payload is aggregate — no visitor ids, no buyer identity', async () => {
  const res = await load(30);
  assert.ok(!res.text.includes(V1), 'visitor ids never leave the server');
  assert.ok(!res.text.includes(V2));
  assert.ok(!res.text.includes('shopper@test.local'), 'and neither does the buyer');
});

test('hygiene scrubs visitor ids at 90 days and drops events at a year', () => {
  const analytics = require('../src/analytics');
  db.prepare(`INSERT INTO analytics_events (kind, shop_id, product_id, visitor, source, created_at)
    VALUES ('product_view', ?, ?, 'stalevisitor01', 'home', datetime('now','-120 days'))`).run(shopId, mugId);
  db.prepare(`INSERT INTO analytics_events (kind, shop_id, product_id, visitor, source, created_at)
    VALUES ('product_view', ?, ?, 'ancientvisitor', 'home', datetime('now','-400 days'))`).run(shopId, mugId);

  const { scrubbed, removed } = analytics.hygiene();
  assert.equal(scrubbed, 2, 'both old rows lose their identifier (the 400-day one before it goes)');
  assert.equal(removed, 1, 'only the year-old row is deleted');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM analytics_events WHERE visitor='stalevisitor01'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM analytics_events WHERE created_at < datetime('now','-100 days')").get().c, 1,
    'the count survives the scrub — only the identifier goes');
});
