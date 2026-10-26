'use strict';
/**
 * Low + nit round, 12 Oct 2026 — group C: the maker dashboard, the admin and
 * their APIs (seller.routes.js, analytics.js, ai.js, reviews.js, the
 * non-money parts of admin.routes.js).
 */
const { testEnv, startApp } = require('./helpers');
testEnv({
  PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874',
  RATE_LIMIT_DISABLED: '1',
  ANALYTICS_ANON_PER_MINUTE: '5',
  ANALYTICS_VISITOR_PER_DAY: '4',
});

const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BAD = 'data:image/png;base64,AAAA';
const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');

let ctx, db, api, adminCookie, adminId, buyerId;
const sent = [];
let seq = 0;

function mkShop(slug, extra = {}) {
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?, 'seller')")
    .run(`${slug}@test.local`, hashPassword('testpass123'), `${slug} owner`).lastInsertRowid;
  const id = db.prepare(`INSERT INTO shops (user_id,name,slug,status,agreement_version,agreement_accepted_at,pickup_address,pickup_phone,location)
    VALUES (?,?,?, 'approved', 'v5', datetime('now'), 'Studio 1, Al Quoz, Dubai', '+971501234567', 'Al Quoz, Dubai')`).run(uid, slug, slug).lastInsertRowid;
  if (Object.keys(extra).length) db.prepare(`UPDATE shops SET ${Object.keys(extra).map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(extra), id);
  return { id: Number(id), userId: Number(uid), email: `${slug}@test.local` };
}
const cookieOf = (shop) => ctx.loginAs(shop.email, 'testpass123');
const product = (shopId, name, price = 5000, status = 'live') => Number(db.prepare(
  "INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?, 'Ceramics', ?, 5, ?)").run(shopId, name, price, status).lastInsertRowid);
/** A paid order of `qty` × the piece, with its shipment. */
function order(shopId, productId, price, qty = 1, { pi = null, status = 'processing', created = null } = {}) {
  const pub = `TRV-C12${String(++seq).padStart(3, '0')}`;
  const oid = Number(db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,total_cents,status,rail,stripe_payment_intent_id,shipping_json)
    VALUES (?,?, 'shopper@test.local', ?, ?, 'paid', 'consignment', ?, ?)`).run(pub, buyerId, price * qty, price * qty, pi,
    JSON.stringify({ name: 'Sara Ahmed', line: 'Marina Gate 2', city: 'Dubai', emirate: 'Dubai' })).lastInsertRowid);
  if (created) db.prepare(`UPDATE orders SET created_at=${created} WHERE id=?`).run(oid);
  const item = Number(db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,?)')
    .run(oid, productId, shopId, 'Piece', price, qty).lastInsertRowid);
  const sh = Number(db.prepare('INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?,?)').run(oid, shopId, status).lastInsertRowid);
  return { oid, pub, item, sh };
}

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
  const { hashPassword } = require('../src/middleware');
  adminId = Number(db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@test.local',?, 'Owner','admin')").run(hashPassword('adminpass123')).lastInsertRowid);
  buyerId = Number(db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('shopper@test.local',?, 'Shopper','buyer')").run(hashPassword('testpass123')).lastInsertRowid);
  adminCookie = await ctx.loginAs('owner@test.local', 'adminpass123');
});
after(async () => { await ctx.close(); });
const tick = () => new Promise((r) => setTimeout(r, 30));

/* ---------------- analytics: F241, F245, F358, F457 ---------------- */

test('F241/F302: Analytics and the Overview agree once refunds happen; refunded orders are not orders', async () => {
  const s = mkShop('agree-pots');
  const cookie = await cookieOf(s);
  const p = product(s.id, 'Agree Mug', 5000);
  const kept = order(s.id, p, 5000, 2);            // one of the two units comes back, refunded
  const whole = order(s.id, p, 7000, 1);           // refunded in full
  db.prepare("UPDATE orders SET refunded_at=datetime('now') WHERE id=?").run(whole.oid);
  const rr = db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,status,refund_cents) VALUES (?,?, 'changed-mind','refunded', 5000)").run(kept.oid, buyerId).lastInsertRowid;
  db.prepare('INSERT INTO return_request_items (request_id,order_item_id,qty) VALUES (?,?,1)').run(rr, kept.item);

  const ov = (await api('GET', '/api/seller/orders', { cookie })).data.summary;
  const an = (await api('GET', '/api/seller/analytics?days=30', { cookie })).data;
  assert.equal(ov.revenueCents, 5000, 'one unit kept');
  assert.equal(an.summary.sales * 100, ov.revenueCents, 'Analytics sales = Overview revenue');
  assert.equal(an.summary.units, 1);
  assert.equal(an.summary.earnings, 30, 'the maker’s 60% of what was kept');
  assert.equal(an.summary.orders, 1, 'the fully refunded order is not counted');
  assert.equal(ov.ordersCount, 1, 'Orders · 30d leaves the refunded order out');
  const row = an.products.find((x) => x.name === 'Agree Mug');
  assert.equal(row.units, 1);
  assert.equal(row.sales, 50);
  assert.equal(an.daily[an.daily.length - 1].orders, 1, 'the chart counts only the order with a piece kept');
});

test('F245: drafts are not counted, and one source can only add so much', async () => {
  const s = mkShop('beacon-pots');
  const live = product(s.id, 'Live Jug');
  const live2 = product(s.id, 'Live Cup');
  const draft = product(s.id, 'Draft Jug', 5000, 'draft');
  const count = () => db.prepare('SELECT COUNT(*) AS c FROM analytics_events WHERE shop_id=?').get(s.id).c;
  await api('POST', '/api/track', { body: { kind: 'product_view', productId: draft, visitor: 'visitordraft01' } });
  assert.equal(count(), 0, 'a draft piece’s view is dropped');
  for (let i = 0; i < 12; i += 1) await api('POST', '/api/track', { body: { kind: 'product_view', productId: live } });
  assert.equal(count(), 5, 'beacons without an id are capped per shop per minute (ANALYTICS_ANON_PER_MINUTE=5)');
  // Six different actions (so the 60-second repeat rule doesn't hide anything)
  // from one browser id: only the first four count (ANALYTICS_VISITOR_PER_DAY=4).
  const V = 'capvisitor0001';
  for (const body of [
    { kind: 'shop_view', shop: 'beacon-pots' }, { kind: 'product_view', productId: live }, { kind: 'add_to_cart', productId: live },
    { kind: 'product_view', productId: live2 }, { kind: 'add_to_cart', productId: live2 }, { kind: 'product_view', productId: live, source: 'search' },
  ]) await api('POST', '/api/track', { body: { ...body, visitor: V } });
  const vis = db.prepare('SELECT COUNT(*) AS c FROM analytics_events WHERE shop_id=? AND visitor=?').get(s.id, V).c;
  assert.equal(vis, 4, 'one browser id adds at most 4 events a day here');
  // Nothing about the shopper is stored beyond the anonymous id (privacy design unchanged).
  const cols = db.prepare('PRAGMA table_info(analytics_events)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => /ip|user|agent|email/i.test(c)));
});

test('F457/F358: the chart follows Dubai days, from two grouped queries', async () => {
  const s = mkShop('dubai-day-pots');
  const cookie = await cookieOf(s);
  const p = product(s.id, 'Night Vase');
  // 00:30 in Dubai two days ago = 20:30 UTC the day before that.
  const d = db.prepare("SELECT date('now','+4 hours','-2 days') AS d").get().d;
  db.prepare(`INSERT INTO analytics_events (kind, shop_id, product_id, visitor, source, created_at)
    VALUES ('product_view', ?, ?, '', 'home', datetime(?, '-4 hours', '+30 minutes'))`).run(s.id, p, d);
  const daily = (await api('GET', '/api/seller/analytics?days=7', { cookie })).data.daily;
  assert.equal(daily.length, 7);
  const i = daily.findIndex((x) => x.date === d);
  assert.ok(i > 0, 'the Dubai day is on the chart');
  assert.equal(daily[i].views, 1, 'counted on its Dubai day');
  assert.equal(daily[i - 1].views, 0, 'not on the UTC day before');
  assert.equal(daily[daily.length - 1].date, db.prepare("SELECT date('now','+4 hours') AS d").get().d, 'the last bar is today in Dubai');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_items_product'").get(), 'order lines are indexed by piece');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'analytics.js'), 'utf8');
  assert.doesNotMatch(src, /date\(e\.created_at\) = span\.d/, 'no sub-query per day any more');
});

/* ---------------- seller API ---------------- */

test('F242: a parcel’s tracking link is https only, and the fields are short plain text', async () => {
  const s = mkShop('track-pots');
  const cookie = await cookieOf(s);
  const o = order(s.id, product(s.id, 'Track Bowl'), 4000);
  const patch = (body) => api('PATCH', `/api/seller/shipments/${o.sh}`, { cookie, body });
  for (const trackingUrl of ['javascript:alert(document.domain)', 'http://track.example/1', 'data:text/html,hi', 'https://x" onclick="y']) {
    assert.equal((await patch({ trackingUrl })).status, 400, trackingUrl);
  }
  assert.equal((await patch({ carrier: 'x'.repeat(81) })).status, 400);
  assert.equal((await patch({ trackingNumber: '1'.repeat(61) })).status, 400);
  assert.equal((await patch({ note: '<b>hi</b>' })).status, 400);
  const ok = await patch({ carrier: 'Aramex', trackingNumber: 'AR123', trackingUrl: 'https://track.example/AR123' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.shipment.trackingUrl, 'https://track.example/AR123');
  // An older row that holds a script link is never handed to a page.
  db.prepare("UPDATE shipments SET tracking_url='javascript:alert(1)' WHERE id=?").run(o.sh);
  const row = (await api('GET', '/api/seller/orders', { cookie })).data.orders.find((x) => x.id === o.sh);
  assert.equal(row.trackingUrl, '');
  const acct = await api('GET', '/api/account/orders', { cookie: await ctx.loginAs('shopper@test.local', 'testpass123') });
  assert.ok(!acct.text.includes('javascript:'), 'the buyer’s account never gets it');
});

test('F244: a corrupt photo refuses the whole save — nothing changes, nothing is left on disk', async () => {
  const s = mkShop('atomic-pots');
  const cookie = await cookieOf(s);
  const p = product(s.id, 'Before Name', 5000);
  const r = await api('PATCH', `/api/seller/products/${p}`, { cookie, body: { name: 'RENAMED BEFORE FAIL', price: 999, images: [BAD] } });
  assert.equal(r.status, 400);
  const row = db.prepare('SELECT name, price_cents FROM products WHERE id=?').get(p);
  assert.deepEqual([row.name, row.price_cents], ['Before Name', 5000], 'the name and price are untouched');

  const dir = path.join(process.env.UPLOADS_DIR, 'products');
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  const before = files();
  const c = await api('POST', '/api/seller/products', { cookie, body: { name: 'Half Made', price: 50, stock: 1, status: 'draft', images: [PNG, BAD], leadDays: 2 } });
  assert.equal(c.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM products WHERE name='Half Made'").get().c, 0, 'no half-created piece');
  assert.equal(files(), before, 'and no orphaned first photo');
  const good = await api('PATCH', `/api/seller/products/${p}`, { cookie, body: { name: 'After Name', images: [PNG] } });
  assert.equal(good.status, 200, good.text);
  assert.equal(JSON.parse(good.data.product.images).length, 1);
});

test('F456: an edit saves the motif seed it checks; F455: a runaway id list is a 400', async () => {
  const s = mkShop('seed-pots');
  const cookie = await cookieOf(s);
  const p = product(s.id, 'Seed Mug');
  assert.equal((await api('PATCH', `/api/seller/products/${p}`, { cookie, body: { imageSeed: 'motif-7' } })).status, 200);
  assert.equal(db.prepare('SELECT image_seed FROM products WHERE id=?').get(p).image_seed, 'motif-7');
  const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
  assert.equal((await api('POST', '/api/seller/products/confirm-lead-times', { cookie, body: { ids } })).status, 400);
  assert.equal((await api('POST', '/api/seller/products/confirm-lead-times', { cookie, body: { ids: [p, p, p] } })).status, 200, 'duplicates are fine');
});

test('F246: the shop record is an allow-list — no file paths, hashes, Stripe ids or owner notes', async () => {
  const s = mkShop('private-pots', { license_image: '/var/data/private/licenses/license-9.png', agreement_hash: 'abc123', stripe_account_id: 'acct_secret', review_note: 'watching for counterfeits' });
  const cookie = await cookieOf(s);
  const me = (await api('GET', '/api/seller/me', { cookie })).data.shop;
  for (const k of ['license_image', 'agreement_hash', 'stripe_account_id', 'user_id', 'iban_encrypted', 'payout_iban', 'identity_checked_by', 'eid_front_file']) {
    assert.equal(me[k], undefined, `${k} never leaves the server`);
  }
  assert.equal(me.licenseImageProvided, true);
  assert.equal(me.review_note, '', 'an approved shop never sees the owner’s note');
  assert.equal(me.graduationThresholdCents, 1200000, 'the banner reads the real threshold (F483)');
  for (const k of ['name', 'slug', 'status', 'pickup_address', 'agreement_version', 'connect_queue']) assert.ok(k in me, `${k} is still sent`);
  db.prepare("UPDATE shops SET status='rejected' WHERE id=?").run(s.id);
  const rej = (await api('GET', '/api/seller/me', { cookie })).data.shop;
  assert.equal(rej.review_note, 'watching for counterfeits', 'a rejected application sees why');
  assert.ok(!JSON.stringify(rej).includes('/var/data/private'));
});

test('F247: the courier pickup must be in Dubai, Abu Dhabi or Sharjah', async () => {
  const s = mkShop('pickup-pots');
  const cookie = await cookieOf(s);
  const patch = (pickupAddress) => api('PATCH', '/api/seller/me', { cookie, body: { pickupAddress } });
  let r = await patch('Villa 3, Al Rashidiya, Ajman');
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'pickup_area');
  assert.match(r.data.error, /Dubai, Abu Dhabi and Sharjah only/);
  assert.equal((await patch('Villa 3, Al Nahda, Dubai, near Ajman border')).status, 400, 'naming another emirate is refused');
  assert.equal((await patch('Villa 3, Al Nahda, Sharjah')).status, 200, 'Sharjah makers since 2026-10-26');
  assert.equal((await patch('Unit 5, Alserkal Avenue, Al Quoz 1')).status, 400, 'no emirate named');
  assert.equal((await patch('Unit 5, Alserkal Avenue, Al Quoz 1, Dubai')).status, 200);
  assert.equal((await patch('فيلا 3، القوز، دبي')).status, 200, 'typed in Arabic');
});

test('F248: a maker can’t take the Trove name, and a live shop’s rename is flagged to the owner', async () => {
  const s = mkShop('rename-pots');
  const cookie = await cookieOf(s);
  for (const name of ['Trove Official', 'TROVE collection', 'Tr-ove Studio', 'TroveCraft']) {
    const r = await api('PATCH', '/api/seller/me', { cookie, body: { name } });
    assert.equal(r.status, 400, name);
    assert.equal(r.data.code, 'reserved_name');
  }
  sent.length = 0;
  const ok = await api('PATCH', '/api/seller/me', { cookie, body: { name: 'Totally Different Brand' } });
  assert.equal(ok.status, 200);
  await tick();
  assert.ok(sent.some((m) => m.to === 'owner@test.local' && /renamed itself/.test(m.subject)), 'the owner is emailed');
  const act = db.prepare("SELECT * FROM admin_actions WHERE action='Live shop renamed by the maker' AND target_id=?").get(String(s.id));
  assert.ok(act && /rename-pots/.test(act.before_json) && /Totally Different Brand/.test(act.after_json), 'and it is in Activity');
  sent.length = 0;
  assert.equal((await api('PATCH', '/api/seller/me', { cookie, body: { name: 'Totally Different Brand', bio: 'Same name, new story' } })).status, 200);
  await tick();
  assert.equal(sent.length, 0, 'saving without a new name flags nothing');
});

test('F362: the first load carries open parcels and the last 90 days; older ones page in', async () => {
  const s = mkShop('history-pots');
  const cookie = await cookieOf(s);
  const p = product(s.id, 'History Plate');
  const recent = order(s.id, p, 3000, 1, { status: 'delivered' });
  const oldDone = order(s.id, p, 3000, 1, { status: 'delivered', created: "datetime('now','-120 days')" });
  const oldOpen = order(s.id, p, 3000, 1, { status: 'processing', created: "datetime('now','-130 days')" });
  const first = (await api('GET', '/api/seller/orders', { cookie })).data;
  const ids = first.orders.map((o) => o.id);
  assert.ok(ids.includes(recent.sh));
  assert.ok(ids.includes(oldOpen.sh), 'a parcel still to pack shows whatever its age');
  assert.ok(!ids.includes(oldDone.sh), 'an old delivered parcel waits for "Show older orders"');
  assert.ok(first.older, 'and the page says there is more');
  const next = (await api('GET', `/api/seller/orders?before=${encodeURIComponent(first.older)}`, { cookie })).data;
  assert.deepEqual(next.orders.map((o) => o.id), [oldDone.sh]);
  assert.equal(next.older, null);
  // The latest return touching the shop rides along without a lookup per row.
  db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,status) VALUES (?,?, 'damaged','requested')").run(recent.oid, buyerId);
  const rr = db.prepare('SELECT id FROM return_requests WHERE order_id=?').get(recent.oid).id;
  db.prepare('INSERT INTO return_request_items (request_id,order_item_id,qty) VALUES (?,?,1)').run(rr, recent.item);
  const again = (await api('GET', '/api/seller/orders', { cookie })).data.orders.find((o) => o.id === recent.sh);
  assert.equal(again.returnRequest.id, rr);
});

test('F318: a maker asks for a photo session; the owner sees it until it is arranged', async () => {
  const s = mkShop('photo-pots');
  const cookie = await cookieOf(s);
  sent.length = 0;
  const r = await api('POST', '/api/seller/photo-session', { cookie, body: { note: 'Mornings are best' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.data.shop.photo_session_requested_at);
  await tick();
  assert.ok(sent.some((m) => m.to === 'owner@test.local' && /photo session/.test(m.subject)));
  const needs = (await api('GET', '/api/admin/needs-you', { cookie: adminCookie })).data.items;
  assert.ok(needs.some((i) => i.key === 'photo_sessions' && i.view === 'shops'));
  sent.length = 0;
  const again = await api('POST', '/api/seller/photo-session', { cookie, body: {} });
  assert.equal(again.data.already, true);
  await tick();
  assert.equal(sent.length, 0, 'asking twice emails once');
  assert.equal((await api('POST', `/api/admin/shops/${s.id}/photo-session`, { cookie: adminCookie, body: { arranged: true } })).status, 200);
  const shop = (await api('GET', '/api/admin/shops', { cookie: adminCookie })).data.shops.find((x) => x.id === s.id);
  assert.ok(shop.photoSessionArrangedAt);
  const after = (await api('GET', '/api/admin/needs-you', { cookie: adminCookie })).data.items;
  assert.ok(!after.some((i) => i.key === 'photo_sessions'), 'arranged: off the to-do list');
  assert.equal((await api('POST', `/api/admin/shops/${s.id}/photo-session`, { cookie: adminCookie, body: { arranged: true } })).status, 409);
});

/* ---------------- admin ---------------- */

test('F251: the Trove Collection can’t be rejected, suspended or sent back to review', async () => {
  const house = Number(db.prepare(`INSERT INTO shops (user_id,name,slug,status,is_house) VALUES (?, 'Trove Collection', 'trove-collection', 'approved', 1)`).run(adminId).lastInsertRowid);
  sent.length = 0;
  for (const status of ['rejected', 'suspended', 'pending']) {
    const r = await api('PATCH', `/api/admin/shops/${house}`, { cookie: adminCookie, body: { status } });
    assert.equal(r.status, 409, status);
    assert.equal(r.data.code, 'house_shop');
  }
  assert.equal(db.prepare('SELECT status FROM shops WHERE id=?').get(house).status, 'approved');
  assert.equal((await api('PATCH', `/api/admin/shops/${house}`, { cookie: adminCookie, body: { status: 'approved' } })).status, 200);
  await tick();
  assert.equal(sent.length, 0, 'the owner is never emailed about their own Collection');
  assert.equal((await api('POST', '/api/seller/photo-session', { cookie: adminCookie, body: {} })).status, 409, 'no photo-session request for the house line');
});

test('F327: Trove lifts only its own hide; a maker’s draft stays the maker’s', async () => {
  const s = mkShop('moderate-pots');
  const draft = product(s.id, 'Unfinished Bowl', 5000, 'draft');
  const r = await api('PATCH', `/api/admin/products/${draft}`, { cookie: adminCookie, body: { status: 'live' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'maker_choice');
  assert.equal(db.prepare('SELECT status FROM products WHERE id=?').get(draft).status, 'draft');
  const live = product(s.id, 'Finished Bowl');
  assert.equal((await api('PATCH', `/api/admin/products/${live}`, { cookie: adminCookie, body: { status: 'hidden' } })).status, 200);
  assert.equal((await api('PATCH', `/api/admin/products/${live}`, { cookie: adminCookie, body: { status: 'live' } })).status, 200, 'undoing a Trove hide');
});

test('F329: the orders list says when a whole-order refund would be refused', async () => {
  const s = mkShop('refundable-pots');
  const p = product(s.id, 'Refund Cup');
  const card = order(s.id, p, 4000, 1, { pi: 'pi_c12_card' });
  const noCard = order(s.id, p, 4000, 1);
  const inReturn = order(s.id, p, 4000, 1, { pi: 'pi_c12_ret' });
  db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,status) VALUES (?,?, 'damaged','approved')").run(inReturn.oid, buyerId);
  const list = (await api('GET', '/api/admin/orders', { cookie: adminCookie })).data.orders;
  const by = Object.fromEntries(list.map((o) => [o.publicId, o]));
  assert.equal(by[card.pub].refundBlocked, null);
  assert.equal(by[noCard.pub].refundBlocked, 'no_card_payment');
  assert.equal(by[inReturn.pub].refundBlocked, 'return_in_progress');
});

test('F386: the overview reports Trove’s share of the last 30 days and whether direct payouts are on', async () => {
  const s = mkShop('share-pots');
  const before = (await api('GET', '/api/admin/stats', { cookie: adminCookie })).data;
  const o = order(s.id, product(s.id, 'Share Vase'), 20000);
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', 12000)").run(s.id, o.oid);
  const st = (await api('GET', '/api/admin/stats', { cookie: adminCookie })).data;
  assert.equal(st.troveShare30Cents - before.troveShare30Cents, 8000, 'AED 200 paid, AED 120 owed to the maker');
  assert.equal(st.railBEnabled, false);
  // Typed licence numbers to check are on the to-do list.
  mkShop('licence-pots', { license_number: 'CN-1234567' });
  const needs = (await api('GET', '/api/admin/needs-you', { cookie: adminCookie })).data.items;
  assert.ok(needs.some((i) => i.key === 'licences' && i.view === 'shops'));
});

test('F259: licence scans are encrypted at rest, decrypted only for the admin, never cached', async () => {
  // A new application with a licence: stored encrypted (a relative .enc path).
  const reg = await api('POST', '/api/auth/register', { body: {
    role: 'seller', name: 'Licensed Layla', email: 'layla-lic@test.local', password: 'testpass123',
    shopName: 'Layla Looms', location: 'Al Quoz, Dubai', about: 'Weaving heavyweight throws on a wooden loom in Al Quoz since 2019.',
    instagram: '@laylalooms', phone: '+971501112299', licenseNumber: 'ET-2026-0001', licenseImage: PNG,
  } });
  assert.ok([200, 201].includes(reg.status), reg.text);
  const shop = db.prepare("SELECT id, license_image FROM shops WHERE name='Layla Looms'").get();
  assert.ok(!path.isAbsolute(shop.license_image) && shop.license_image.endsWith('.enc'), shop.license_image);
  const raw = fs.readFileSync(path.join(process.env.PRIVATE_DIR, shop.license_image));
  assert.notEqual(raw.slice(1, 4).toString('ascii'), 'PNG', 'not a plain image on disk');
  const img = await fetch(`${ctx.baseUrl}/api/admin/shops/${shop.id}/license-image`, { headers: { cookie: adminCookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control') || '', /no-store/);
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.equal(bytes.slice(1, 4).toString('ascii'), 'PNG');

  // An older plain file: served (no-store) until the sweep encrypts it.
  const legacy = mkShop('legacy-licence');
  const dir = path.join(process.env.PRIVATE_DIR, 'licenses');
  fs.mkdirSync(dir, { recursive: true });
  const plain = path.join(dir, `license-${legacy.id}-1.png`);
  fs.writeFileSync(plain, Buffer.from(PNG.split(',')[1], 'base64'));
  db.prepare('UPDATE shops SET license_image=? WHERE id=?').run(plain, legacy.id);
  const old = await fetch(`${ctx.baseUrl}/api/admin/shops/${legacy.id}/license-image`, { headers: { cookie: adminCookie } });
  assert.equal(old.status, 200);
  assert.match(old.headers.get('cache-control') || '', /no-store/);
  require('../src/migrations/026-C-licence-encryption').up(db);
  const moved = db.prepare('SELECT license_image FROM shops WHERE id=?').get(legacy.id).license_image;
  assert.ok(moved.endsWith('.enc') && !path.isAbsolute(moved), 'the column is rewritten to the encrypted copy');
  assert.equal(fs.existsSync(plain), false, 'the plain file is gone');
  const swept = await fetch(`${ctx.baseUrl}/api/admin/shops/${legacy.id}/license-image`, { headers: { cookie: adminCookie } });
  assert.equal(Buffer.from(await swept.arrayBuffer()).slice(1, 4).toString('ascii'), 'PNG');
  const maker = await ctx.loginAs('layla-lic@test.local', 'testpass123');
  assert.equal((await api('GET', `/api/admin/shops/${shop.id}/license-image`, { cookie: maker })).status, 403);
});

/* ---------------- small things ---------------- */

test('F249: trending searches reach the tag prompt only if they find pieces and pass the copy rules', () => {
  const s = mkShop('trend-pots');
  product(s.id, 'Sand Vase');
  product(s.id, 'Replica Bowl');
  const { logSearch } = require('../src/trends');
  for (let i = 0; i < 5; i += 1) { logSearch('vase', 3); logSearch('zzjunk competitor', 4); logSearch('replica', 2); }
  const terms = require('../src/ai').trendTerms();
  assert.ok(terms.includes('vase'));
  assert.ok(!terms.includes('zzjunk competitor'), 'a term that finds nothing is dropped');
  assert.ok(!terms.includes('replica'), 'counterfeit wording is never a tag');
});

test('F458: an unnamed reviewer is "A Trove buyer"', () => {
  assert.equal(require('../src/reviews').displayName(''), 'A Trove buyer');
  assert.match(read('trove.html'), /\/\^A trove buyer\$\/i\.test\(r\.buyer\)/, 'the storefront translates both spellings');
});

test('pages: maker dashboard and admin wiring for this round', () => {
  const seller = read('trove-seller.html');
  assert.doesNotMatch(seller, /a\.phone\?/, 'F485: no buyer phone branch on the order card');
  assert.doesNotMatch(seller, /function pillClass/, 'F509: dead code removed');
  assert.match(seller, /<select class="pill-st st-pick/, 'F309: visibility is a menu, not a one-tap cycle');
  assert.doesNotMatch(seller, /cycleStatus/);
  assert.match(seller, /confirm\(_tn\(todo\.length,'Confirm that this piece is ready/, 'F310: the pieces are named before confirming');
  assert.doesNotMatch(seller, /buyer fees/, 'F311');
  assert.match(seller, /ORDER_SUMMARY\.ordersCount/, 'F302: Orders · 30d from the server');
  assert.doesNotMatch(seller, /_t\('all time'\)/);
  assert.match(seller, /s\.deliveredAt\|\|s\.updatedAt/, 'F411');
  assert.match(seller, /Return window closes \{date\}/);
  assert.match(seller, /filter\(r=>\['approved','collected'\]\.includes\(r\.status\)\)/, 'F481: the badge counts only returns coming back to the maker');
  assert.match(seller, /if\(!confirm\(_t\('Remove your shop photo\?/, 'F484');
  assert.doesNotMatch(seller, /SETTLE\.payoutSetupComplete\|\|\(SHOP\.bank/, 'F519: the server’s rule only');
  assert.match(seller, /Your payouts over the last 30 days passed \{amount\}/, 'F483');
  assert.match(seller, /font-variant-numeric:lining-nums/, 'F383: lining figures');
  assert.match(seller, /class="first" style="inset-inline-start:0"/, 'F384: five placed labels');
  assert.match(seller, /The courier is already booked/, 'F308');
  assert.match(seller, /loadOlderOrders/, 'F362');
  assert.match(seller, /requestPhotoSession/, 'F318');

  const admin = read('trove-admin.html');
  assert.doesNotMatch(admin, /VAT_REGISTERED|RAIL_B_ENABLED|Rail B is OFF|trailing-30-day/, 'F387: no setting names');
  assert.match(admin, /<h2 class="pay-sec">Makers · every other Tuesday<\/h2>/, 'F324: one Payments tab');
  assert.ok(admin.indexOf('id="svcCreditsWrap"') > admin.indexOf('id="view-payouts"'), 'F324: provider payouts on the Payments tab');
  assert.match(admin, /Not active yet/);
  assert.match(admin, /window\.addEventListener\('beforeunload'/, 'F420');
  assert.match(admin, /class="cmserr"/, 'F420: save errors stay on the section');
  assert.match(admin, /CMS_EDIT\[key\]=cmsClone\(\{\.\.\.CMS\.defaults\[key\],\.\.\.saved\}\)/, 'F494');
  assert.doesNotMatch(admin, /\/\?shop=|'\/\?view=sell'/, 'F493');
  assert.match(admin, /--sage-tint:#E9EFEA/, 'F492');
  assert.match(admin, /\.btn-sm\{/, 'F492');
  assert.match(admin, /Undo Trove hide/, 'F327');
  assert.match(admin, /refundBlocked==='return_in_progress'/, 'F329');
  assert.match(admin, /function markLegacyPaid\(id\)\{\s*const b=BATCHES/, 'F330');
  assert.match(admin, /async function approveGraduation\(shopId\)\{\s*const g=/, 'F330');
  assert.match(admin, /const aedx=/, 'F326');
  assert.match(admin, /How returns work/, 'F521');
  assert.match(admin, /openOrder\('/, 'F521');
  assert.match(admin, /hidden until approved/, 'F491');
  assert.match(admin, /Trove’s share · 30 days/, 'F386');
});
