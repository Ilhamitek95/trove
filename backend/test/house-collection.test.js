'use strict';
/**
 * The Trove Collection, the owner's own shop (owner, 2026-09-30): 'where did
 * the trove collection & additional filters go? … re-instate trove
 * collection, it will be my own shop.'
 *
 *  - the boot step re-creates the house shop once, only when missing, only
 *    for the ADMIN_EMAIL admin account;
 *  - with no Collection pieces the Collection is still everywhere, and the
 *    server draws its coming-soon states;
 *  - /makers/trove-collection is the shelf's address, not a maker page;
 *  - the admin runs the shop as themselves (house mode); nobody else can;
 *  - a house sale owes no maker anything, and its return debits no maker.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com', ADMIN_EMAIL: 'Owner@Trove.test' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };

let ctx, db, hs, pw;
let ownerCookie, makerCookie, buyerCookie;
let makerShopId, makerProductId;

const get = (p, cookie) => ctx.api('GET', p, { headers: { accept: 'text/html' }, cookie });
const houseRow = () => db.prepare('SELECT * FROM shops WHERE is_house = 1').get();
const marker = () => db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(hs.MARKER);

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  hs = require('../src/house-shop');
  pw = require('../src/middleware').hashPassword('testpass123');
  // One real maker with one live piece, like the live site today.
  const maker = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('mara@test.local',?, 'Mara','seller')").run(pw).lastInsertRowid;
  makerShopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,location) VALUES (?, 'Kiln Test', 'kiln-test', 'approved', 'Al Quoz, Dubai')").run(maker).lastInsertRowid;
  makerProductId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?, 'Test Mug', 'Ceramics', 12000, 20, 'live')").run(makerShopId).lastInsertRowid;
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal','buyer')").run(pw);
});
after(async () => { await ctx.close(); });

/* ---------------- the boot step ---------------- */
test('boot step: skips (and retries later) while the ADMIN_EMAIL account is missing or not an admin', () => {
  let r = hs.bootOnce(db, { log: quiet });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /no account for ADMIN_EMAIL/);
  assert.equal(houseRow(), undefined);
  assert.equal(marker(), undefined, 'not marked, so the next boot tries again');

  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@trove.test',?, 'The Owner','buyer')").run(pw);
  r = hs.bootOnce(db, { log: quiet });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /not an admin/);
  assert.equal(houseRow(), undefined, 'never for a non-admin account');

  // someone else's shop already on the address: never taken over
  const other = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES ((SELECT id FROM users WHERE email='mara@test.local'), 'Squatter', 'trove-collection', 'pending')").run().lastInsertRowid;
  db.prepare("UPDATE users SET role='admin' WHERE email='owner@trove.test'").run();
  r = hs.bootOnce(db, { log: quiet });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /belongs to another shop/);
  db.prepare('DELETE FROM shops WHERE id=?').run(other);
});

test('boot step: creates the Trove Collection once, for the admin, approved and honest', () => {
  const logs = [];
  const r = hs.bootOnce(db, { log: { ...quiet, log: (m) => logs.push(m) } });
  assert.equal(r.status, 'created');
  const s = houseRow();
  assert.equal(s.name, 'Trove Collection');
  assert.equal(s.slug, 'trove-collection');
  assert.equal(s.is_house, 1);
  assert.equal(s.status, 'approved');
  assert.equal(s.color, '#292727');
  assert.equal(s.location, 'Dubai, UAE');
  assert.match(s.bio, /^Trove’s own line/);
  assert.equal(s.user_id, db.prepare("SELECT id FROM users WHERE email='owner@trove.test'").get().id, 'owned by the ADMIN_EMAIL account');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products WHERE shop_id=?').get(s.id).n, 0, 'no invented pieces');
  assert.ok(marker(), 'marked done');
  assert.match(logs.join('\n'), /created Trove Collection/);

  // a second boot is a no-op, and a removed house shop is not re-created behind the owner's back
  assert.equal(hs.bootOnce(db, { log: quiet }).status, 'done-before');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE is_house = 1').get().n, 1);
});

test('boot step: an existing house shop is left alone (and just marks the step done)', () => {
  db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(hs.MARKER);
  const before = houseRow();
  const r = hs.bootOnce(db, { log: quiet });
  assert.equal(r.status, 'exists');
  assert.deepEqual(houseRow(), before);
  assert.ok(marker());
});

/* ---------------- visible with no pieces, coming-soon states ---------------- */
test('no Collection pieces: the Collection is everywhere and the server draws its coming-soon states', async () => {
  const home = (await get('/')).text;
  assert.match(home, /<html lang="en" class="house-soon[^"]*">/);
  assert.doesNotMatch(home, /no-house/);
  assert.match(home, /<button class="btn btn-dark live-only" id="heroShopBtn"[^>]*>Shop the Collection<\/button>/, 'the two-CTA hero stays in the page for when the pieces land');
  assert.match(home, /<a class="txt-link live-only" id="heroMarketLink"[^>]*>Explore the Marketplace<\/a>/);
  // F154 (owner 2026-10-02): meanwhile the main hero button opens the Marketplace, and the tag says the line is coming
  assert.match(home, /<a class="btn btn-dark soon-only" id="heroMarketBtn" href="\/shop">Shop the Marketplace<\/a>/);
  assert.match(home, /<span class="l soon-only">Our own line · coming soon<\/span>/);
  const store = read('trove.html');
  assert.match(store, /html\.house-soon \.hero \.live-only\{display:none\}/);
  assert.match(store, /\.hero \.soon-only\{display:none\}/, 'with Collection pieces the Collection button is back on its own');
  assert.match(home, /<a class="hero-tag" href="\/shop\/trove-collection"/);
  assert.match(home, /<section class="band house-section"[^>]*>/, 'the Our own band is back');
  assert.match(home, /<div class="copy soon-copy">[\s\S]*?The Trove Collection — our own line — is on its way\./);
  assert.match(home, /header class="top"[\s\S]*?<a href="\/shop\/trove-collection"[^>]*>Trove Collection<\/a>/, 'header link');
  assert.match(home, /<li class="fhouse"><a href="\/shop\/trove-collection">Trove Collection<\/a><\/li>/, 'footer link');
  const css = read('trove.html');
  assert.match(css, /html\.house-soon \.house \.soon-copy\{display:block\}/);
  assert.doesNotMatch(css, /no-house/);

  // the shelf: a real page, with the coming-soon state already in the markup
  const res = await get('/shop/trove-collection');
  assert.equal(res.status, 200);
  assert.match(res.text, /<div class="big">Our own line lands soon<\/div>/);
  assert.doesNotMatch(res.text, /<meta name="robots" content="noindex/, 'indexable before its first piece');
  assert.match(res.text, /<meta name="description" content="The Trove Collection, Trove’s own line of homeware, is on its way\./);
  assert.match(res.text, /id="fltHouse"/, 'the filter rail is there on the Collection shelf too');

  // the other pages share the header and footer, Collection link and all
  for (const p of ['/services', '/about']) {
    const html = (await get(p)).text;
    assert.doesNotMatch(html, /no-house/, p);
    assert.match(html, /href="\/shop\/trove-collection"/, p);
  }
  assert.doesNotMatch(read('trove-services.html'), /no-house|markNoHouse/);
  assert.doesNotMatch(read('site-chrome.js'), /no-house|markNoHouse/);
});

test('/makers/trove-collection is the shelf: 301 to /shop/trove-collection, never a maker page', async () => {
  let res = await get('/makers/trove-collection');
  assert.equal(res.status, 301);
  assert.equal(new URL(res.headers.get('location'), 'https://troveathome.com').pathname, '/shop/trove-collection');
  res = await get('/shop/trove-collection');
  assert.equal(res.status, 200, 'the category URL is not taken by the shop slug');
  const sm = (await ctx.api('GET', '/sitemap.xml')).text;
  assert.match(sm, /<loc>https:\/\/troveathome\.com\/shop\/trove-collection<\/loc>/, 'listed before its first piece');
  assert.doesNotMatch(sm, /\/makers\/trove-collection/);
});

/* ---------------- house mode ---------------- */
test('house mode: the admin runs the Collection as themselves; a maker cannot touch it', async () => {
  ownerCookie = await ctx.loginAs('owner@trove.test', 'testpass123');
  makerCookie = await ctx.loginAs('mara@test.local', 'testpass123');
  const house = houseRow();

  const me = await ctx.api('GET', '/api/auth/me', { cookie: ownerCookie });
  assert.equal(me.data.user.role, 'admin', 'still the admin');
  assert.deepEqual(me.data.shop, { id: house.id, name: 'Trove Collection', slug: 'trove-collection', isHouse: true });
  assert.equal(me.data.impersonating, false, 'no shop view, no swapped session');
  const sm = await ctx.api('GET', '/api/seller/me', { cookie: ownerCookie });
  assert.equal(sm.data.shop.isHouse, true);
  assert.equal(sm.data.shop.needsIdVerification, false, 'no Emirates ID for the house line');
  // admin endpoints still work in the same session
  assert.equal((await ctx.api('GET', '/api/admin/house-shop', { cookie: ownerCookie })).data.shop.slug, 'trove-collection');

  // a piece, in the house category list only
  let res = await ctx.api('POST', '/api/seller/products', { cookie: ownerCookie, body: { name: 'Linen Runner', description: 'Stonewashed linen.', category: 'Ceramics', price: 180, stock: 5, status: 'live' } });
  assert.equal(res.status, 422, 'marketplace categories are not the house list');
  res = await ctx.api('POST', '/api/seller/products', { cookie: ownerCookie, body: { name: 'Linen Runner', description: 'Stonewashed linen.', category: 'Textiles', price: 180, stock: 5, status: 'live' } });
  assert.equal(res.status, 201, res.text);
  const pid = res.data.product.id;
  assert.equal(res.data.product.shop_id, house.id);
  res = await ctx.api('PATCH', `/api/seller/products/${pid}`, { cookie: ownerCookie, body: { price: 195 } });
  assert.equal(res.status, 200, res.text);
  assert.equal(db.prepare('SELECT price_cents FROM products WHERE id=?').get(pid).price_cents, 19500);

  // maker-only steps do not apply
  for (const [p, body] of [['/api/seller/payout-setup', {}], ['/api/seller/agreement', { accept: true }], ['/api/seller/me/license', { licenseNumber: '12345' }], ['/api/seller/enable-services', {}]]) {
    res = await ctx.api('POST', p, { cookie: ownerCookie, body });
    assert.equal(res.status, 409, p);
    assert.equal(res.data.code, 'house_shop', p);
  }

  // a maker works on their own shop only
  res = await ctx.api('PATCH', `/api/seller/products/${pid}`, { cookie: makerCookie, body: { price: 1 } });
  assert.equal(res.status, 404, 'a maker cannot edit a house piece');
  res = await ctx.api('POST', '/api/seller/products', { cookie: makerCookie, body: { name: 'Sneaky', description: '', category: 'Textiles', price: 10, stock: 1 } });
  assert.equal(res.status, 422, 'and a house category is refused for a marketplace shop');
  const mine = await ctx.api('GET', '/api/seller/products', { cookie: makerCookie });
  assert.ok(mine.data.products.every((p) => p.shop_id === makerShopId));
  // a signed-out visitor or a buyer gets no shop at all
  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  assert.equal((await ctx.api('POST', '/api/seller/products', { cookie: buyerCookie, body: { name: 'X', category: 'Textiles', price: 10 } })).status, 403);

  // the storefront now has a Collection piece: no more coming-soon
  const home = (await get('/')).text;
  assert.doesNotMatch(home, /<html lang="en" class="[^"]*house-soon/);
  const piece = db.prepare('SELECT id, name FROM products WHERE id=?').get(pid);
  const pdp = (await get(require('../src/seo').pieceUrl(piece))).text;
  const ld = JSON.parse(pdp.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const product = (ld['@graph'] || [ld]).find((n) => n['@type'] === 'Product');
  assert.deepEqual(product.brand, { '@type': 'Brand', name: 'Trove' }, 'a Collection piece is Trove’s brand');
  assert.match(pdp, /id="pdpVendorLink" href="\/shop\/trove-collection"/);
});

test('admin: the house row and the Manage Trove Collection button', async () => {
  const shops = (await ctx.api('GET', '/api/admin/shops', { cookie: ownerCookie })).data.shops;
  assert.ok(shops.find((s) => s.slug === 'trove-collection').isHouse);
  const r = await ctx.api('POST', `/api/admin/impersonate/${houseRow().id}`, { cookie: ownerCookie });
  assert.equal(r.data.house, true, 'no shop view for your own shop');
  assert.equal((await ctx.api('GET', '/api/auth/me', { cookie: ownerCookie })).data.impersonating, false);
  assert.equal((await ctx.api('GET', '/api/admin/house-shop', { cookie: makerCookie })).status, 403);
  const admin = read('trove-admin.html');
  assert.match(admin, /<a class="btn btn-dark" href="\/sell">Manage Trove Collection<\/a>/);
  assert.equal((admin.match(/<div class="house-slot"><\/div>/g) || []).length, 2, 'on Overview and on Shops');
  const seller = read('trove-seller.html');
  assert.match(seller, /body\.house-mode \.maker-only,body\.house-mode #dFee,body:not\(\.house-mode\) \.house-only\{display:none!important\}/);
  assert.match(seller, /<a class="mitem maker-only" data-v="payments"/);
  assert.match(seller, /document\.body\.classList\.toggle\('house-mode',SHOP\.house\)/);
});

/* ---------------- money ---------------- */
test('a house sale owes no maker anything; its return refunds the buyer and debits no maker', async () => {
  const house = houseRow();
  db.prepare("UPDATE shops SET pickup_address='Unit 4, Al Serkal Avenue, Al Quoz', pickup_phone='+971501112233' WHERE id=?").run(house.id);
  const hp = db.prepare("SELECT id FROM products WHERE shop_id=? AND status='live'").get(house.id).id;
  const buyer = db.prepare("SELECT id FROM users WHERE email='amal@test.local'").get().id;
  // One order, both pillars: the house runner (195) and a maker's mug (120).
  const orderId = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-HOUSE1',?, 'amal@test.local', '+971501234567', 31500, 0, 0, 31500, 'pending', 'consignment', 'pi_house_1')`).run(buyer).lastInsertRowid;
  const addItem = db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,1)');
  const houseItem = addItem.run(orderId, hp, house.id, 'Linen Runner', 19500).lastInsertRowid;
  addItem.run(orderId, makerProductId, makerShopId, 'Test Mug', 12000);
  const wh = await ctx.postWebhook({ id: 'evt_house_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_house_1', metadata: { order_id: String(orderId) } } } });
  assert.equal(wh.status, 200, wh.text);

  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, 'paid');
  const credits = db.prepare("SELECT shop_id, amount_cents FROM seller_balances WHERE order_id=? AND type='credit_sale'").all(orderId);
  assert.deepEqual(credits, [{ shop_id: makerShopId, amount_cents: 7200 }], 'the maker is owed 60%; the Collection nothing (Trove keeps 100%)');
  // the courier still collects the house parcel from the house pickup address
  const ships = db.prepare('SELECT id, shop_id FROM shipments WHERE order_id=? ORDER BY shop_id').all(orderId);
  assert.deepEqual(ships.map((s) => s.shop_id).sort(), [house.id, makerShopId].sort());

  // the house line's own numbers: earnings are the whole sale
  const an = await ctx.api('GET', '/api/seller/analytics?days=30', { cookie: ownerCookie });
  assert.equal(an.status, 200, an.text);
  assert.equal(an.data.summary.earnings, 195);
  const set = await ctx.api('GET', '/api/seller/settlements', { cookie: ownerCookie });
  assert.equal(set.data.pendingCents, 0);

  // delivered, then the buyer sends the runner back
  for (const s of ships) await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: s.id } });
  let res = await ctx.api('POST', '/api/account/orders/TRV-HOUSE1/return-request', { cookie: buyerCookie, body: { reason: 'damaged', details: 'The hem came apart on arrival.', images: [PNG], itemIds: [houseItem] } });
  assert.equal(res.status, 201, res.text);
  const rrId = res.data.id;
  const seen = await ctx.api('GET', '/api/seller/returns', { cookie: ownerCookie });
  assert.equal(seen.status, 200, seen.text);
  const mineRr = (seen.data.returns || []).find((r) => r.id === rrId);
  assert.ok(mineRr, 'the house dashboard sees the return');
  assert.equal(mineRr.creditImpact, 0, 'no maker credit to reverse');

  res = await ctx.api('POST', `/api/admin/returns/${rrId}/approve`, { cookie: ownerCookie, body: {} });
  assert.equal(res.status, 200, res.text);
  res = await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: rrId } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.status, 'refunded');
  assert.equal(res.data.request.refund, 195, 'the buyer gets the runner back in full');
  const refunds = ctx.stripeMock.calls.filter((c) => c.method === 'refunds.create');
  assert.equal(refunds[refunds.length - 1].params.amount, 19500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seller_balances WHERE order_id=? AND type='debit_refund'").get(orderId).n, 0, 'no maker debit');
  assert.deepEqual(db.prepare("SELECT shop_id, amount_cents FROM seller_balances WHERE order_id=?").all(orderId),
    [{ shop_id: makerShopId, amount_cents: 7200 }], "the maker's credit for the mug is untouched");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seller_balances WHERE shop_id=?').get(house.id).n, 0, 'the Collection never enters the ledger');
});
