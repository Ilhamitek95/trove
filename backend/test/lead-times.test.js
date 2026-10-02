'use strict';
/**
 * Per-piece make/pack time (owner, 2026-09-30: 'handmade things take longer;
 * a knitted scarf 2 days, a sweater longer') — src/lead-times.js.
 *
 *   - products.lead_days: whole days 1–42, default 2 for existing pieces,
 *     validated on create and update, confirmed by the maker
 *   - buyer estimate = lead + courier 1–4 days (2 → 3–6, as before), on the
 *     API, the server-rendered PDP, its JSON-LD and the storefront helpers
 *   - an order's pack-by date is per shop: paid + that shop's slowest piece
 *   - pack-by reminders fire once to the maker, once to the admin 2 days on
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ ADMIN_EMAIL: 'boss@test.local', PUBLIC_URL: 'https://troveathome.com', STRIPE_MOCK: '' }); // demo payments

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', '..', 'docs');
let ctx, db, lt, sent, sellerCookie, seller2Cookie, buyerCookie, shopA, shopB;
const tick = () => new Promise((r) => setImmediate(r));
const mailsTo = (to) => sent.filter((m) => m.to === to);
const create = (cookie, body) => ctx.api('POST', '/api/seller/products', { cookie, body: { category: 'Home & Living', stock: 5, status: 'live', ...body } });

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  lt = require('../src/lead-times');
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?,'Boss','admin')").run(pw);
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?,'Amal Rashid','buyer')").run(pw);
  const s1 = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('knit@test.local',?,'Nora Knit','seller')").run(pw).lastInsertRowid;
  const s2 = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('clay@test.local',?,'Cara Clay','seller')").run(pw).lastInsertRowid;
  shopA = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?, 'Nora Knits', 'nora-knits', 'approved','consignment')").run(s1).lastInsertRowid;
  shopB = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?, 'Cara Clay', 'cara-clay', 'approved','consignment')").run(s2).lastInsertRowid;
  sellerCookie = await ctx.loginAs('knit@test.local', 'testpass123');
  seller2Cookie = await ctx.loginAs('clay@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  sent = [];
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
});
after(async () => { await ctx.close(); });

test('the estimate: make time + courier 1–4 days; a 2-day piece still shows 3–6 days', () => {
  assert.equal(lt.estimate(2).label, '3–6 days');
  assert.deepEqual(lt.estimate(14), { leadDays: 14, transitMinDays: 1, transitMaxDays: 4, minDays: 15, maxDays: 18, label: '15–18 days' });
  assert.equal(lt.estimate(undefined).label, '3–6 days', 'no value = the standard 2 days');
  // Order: each shop's parcel waits for its slowest piece; the order for the slowest shop.
  let e = lt.orderEstimate([{ shopId: 1, leadDays: 2 }, { shopId: 1, leadDays: 7 }]);
  assert.equal(e.label, '8–11 days');
  assert.equal(e.separately, false, 'one shop, one parcel');
  e = lt.orderEstimate([{ shopId: 1, leadDays: 2 }, { shopId: 2, leadDays: 3 }]);
  assert.equal(e.separately, false, 'a day apart is not worth saying');
  e = lt.orderEstimate([{ shopId: 1, leadDays: 2 }, { shopId: 2, leadDays: 14 }]);
  assert.equal(e.separately, true);
  assert.equal(e.label, '15–18 days');
  // Pack-by = the end of the Dubai calendar day, paid day + lead.
  assert.equal(lt.packByAt('2026-10-01 10:00:00', 2), '2026-10-03 19:59:59');
  assert.equal(lt.packByAt('2026-10-01 21:30:00', 2), '2026-10-04 19:59:59', '01:30 on the 2nd in Dubai counts from the 2nd');
  assert.equal(lt.dubaiDay('2026-10-03 19:59:59'), 'Saturday 3 October');
});

test('validation: whole days from 1 to 42 on create and update, with a clear message', async () => {
  for (const bad of [0, 43, 2.5, -1, 'soon', null, '']) {
    const res = await create(sellerCookie, { name: 'Bad scarf', price: 100, leadDays: bad });
    assert.equal(res.status, 400, `leadDays ${JSON.stringify(bad)}`);
    assert.match(res.data.error, /Ready to send in must be a whole number of days from 1 to 42/);
  }
  let res = await create(sellerCookie, { name: 'Quick scarf', price: 100, leadDays: 1 });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.data.product.lead_days, 1);
  assert.equal(res.data.product.lead_days_confirmed, 1, 'a time the maker typed is confirmed');
  const id = res.data.product.id;
  res = await ctx.api('PATCH', `/api/seller/products/${id}`, { cookie: sellerCookie, body: { leadDays: 43 } });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT lead_days FROM products WHERE id=?').get(id).lead_days, 1, 'a rejected save changes nothing');
  res = await ctx.api('PATCH', `/api/seller/products/${id}`, { cookie: sellerCookie, body: { leadDays: '42' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.product.lead_days, 42);
  // Left out (an older client): the standard 2 days, not yet confirmed.
  res = await create(sellerCookie, { name: 'Plain scarf', price: 100 });
  assert.equal(res.status, 201);
  assert.equal(res.data.product.lead_days, 2);
  assert.equal(res.data.product.lead_days_confirmed, 0);
});

test('existing pieces get 2 days; makers confirm them in one tap or by saving a time', async () => {
  // A piece written the old way, without the columns (as every live piece was).
  const id = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,3,'live')").run(shopA, 'Old cowl', 'Home & Living', 9000).lastInsertRowid;
  const row = db.prepare('SELECT lead_days, lead_days_confirmed FROM products WHERE id=?').get(id);
  assert.deepEqual({ ...row }, { lead_days: 2, lead_days_confirmed: 0 });
  const list = (await ctx.api('GET', '/api/seller/products', { cookie: sellerCookie })).data.products;
  assert.ok(list.find((p) => p.id === id).lead_days_confirmed === 0, 'the dashboard can badge it');
  // Another shop's pieces are never touched by this shop's confirm.
  const other = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,3,'live')").run(shopB, 'Old bowl', 'Home & Living', 9000).lastInsertRowid;
  const res = await ctx.api('POST', '/api/seller/products/confirm-lead-times', { cookie: sellerCookie, body: { ids: [id, other] } });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT lead_days_confirmed FROM products WHERE id=?').get(id).lead_days_confirmed, 1);
  assert.equal(db.prepare('SELECT lead_days_confirmed FROM products WHERE id=?').get(other).lead_days_confirmed, 0);
  // The drawer: the field is required there, with the quick picks and the live estimate.
  const html = fs.readFileSync(path.join(DOCS, 'trove-seller.html'), 'utf8');
  assert.match(html, /<label for="dLead">Ready to send in<\/label>/);
  assert.match(html, /How long you need to make or finish and pack this piece after it's ordered\. Made-to-order pieces can take up to 6 weeks\./);
  for (const d of [2, 5, 7, 14, 21]) assert.match(html, new RegExp(`onclick="pickLead\\(${d}\\)">${d} days</button>`));
  assert.match(html, /_t\('Buyers will see: Arrives in \{eta\}',\{eta:etaLabel\(n\)\}\)/);
  assert.match(html, /Confirm make time/);
});

test('the migration: every column added, pack-by backfilled, only parcels still to pack stay open for reminders', () => {
  const mig = require('../src/migrations/020-lead-times');
  const o = db.prepare("INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,title_transferred_at) VALUES ('TRV-MIG1','x@test.local',100,100,'paid','2026-09-20 08:00:00')").run().lastInsertRowid;
  const waiting = db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?,'processing')").run(o, shopA).lastInsertRowid;
  const gone = db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?,'shipped')").run(o, shopB).lastInsertRowid;
  mig.up(db); // idempotent: columns exist already, only the NULL pack-by rows are filled
  const w = db.prepare('SELECT * FROM shipments WHERE id=?').get(waiting);
  const g = db.prepare('SELECT * FROM shipments WHERE id=?').get(gone);
  assert.equal(w.pack_by_at, '2026-09-22 19:59:59', 'paid + the old 2 days');
  assert.equal(w.pack_reminder_at, null);
  assert.ok(g.pack_reminder_at && g.pack_escalated_at, 'already left the maker: never reminded');
  db.prepare('DELETE FROM shipments WHERE order_id=?').run(o);
  db.prepare('DELETE FROM orders WHERE id=?').run(o);
});

test('/api/products exposes leadDays and an estimate object; the PDP renders it server-side with valid shippingDetails', async () => {
  const res = await create(sellerCookie, { name: 'Lopapeysa Sweater', price: 420, leadDays: 14, description: 'Knitted to order in undyed wool.' });
  const id = res.data.product.id;
  const pub = (await ctx.api('GET', `/api/products/${id}`)).data.product;
  assert.equal(pub.leadDays, 14);
  assert.deepEqual(pub.estimate, { leadDays: 14, transitMinDays: 1, transitMaxDays: 4, minDays: 15, maxDays: 18, label: '15–18 days' });
  const scarf = (await ctx.api('GET', '/api/products')).data.products.find((p) => p.name === 'Plain scarf');
  assert.equal(scarf.estimate.label, '3–6 days');

  const seo = require('../src/seo');
  const page = await ctx.api('GET', seo.pieceUrl(pub), { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /<span id="pdpShipLine">Arrives in 15–18 days · made for you, ready to send in 14 days<\/span>/);
  assert.match(page.text, /<dt>Ready to send in<\/dt><dd>14 days after your order<\/dd>/);
  const nodes = [...page.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .flatMap((m) => { const o = JSON.parse(m[1]); return o['@graph'] || [o]; });
  const prod = nodes.find((n) => [].concat(n['@type']).includes('Product'));
  const sd = prod.offers.shippingDetails;
  assert.equal(sd['@type'], 'OfferShippingDetails');
  assert.deepEqual(sd.shippingDestination, { '@type': 'DefinedRegion', addressCountry: 'AE' });
  assert.deepEqual(sd.shippingRate, { '@type': 'MonetaryAmount', currency: 'AED', value: 0 }, 'AED 420 is over the free-delivery threshold');
  assert.equal(sd.deliveryTime['@type'], 'ShippingDeliveryTime');
  assert.deepEqual(sd.deliveryTime.handlingTime, { '@type': 'QuantitativeValue', minValue: 14, maxValue: 14, unitCode: 'DAY' });
  assert.deepEqual(sd.deliveryTime.transitTime, { '@type': 'QuantitativeValue', minValue: 1, maxValue: 4, unitCode: 'DAY' });
  // A cheaper standard piece: AED 30 delivery, 2 days' handling, the old 3–6 line.
  const sp = (await ctx.api('GET', seo.pieceUrl(scarf), { headers: { accept: 'text/html' } })).text;
  assert.match(sp, /<span id="pdpShipLine">Arrives in 3–6 days across Dubai &amp; Abu Dhabi<\/span>/);
  assert.match(sp, /"shippingRate":\{"@type":"MonetaryAmount","currency":"AED","value":30\}/);
  assert.match(sp, /"handlingTime":\{"@type":"QuantitativeValue","minValue":2,"maxValue":2,"unitCode":"DAY"\}/);
});

test('the storefront says exactly what the server renders (PDP line, details row, basket, checkout)', () => {
  const html = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8');
  const grab = (re) => { const m = html.match(re); assert.ok(m, String(re)); return m[0]; };
  const src = [
    // the English side of docs/api.js's _t/_tn/troveIso (the page wraps its strings for the Arabic edition)
    'const fill=(s,v)=>String(s).replace(/\\{(\\w+)\\}/g,(m,k)=>(v&&v[k]!=null?String(v[k]):m));',
    'const _t=(k,v)=>fill(k,v), _tn=(n,one,other,v)=>fill(n===1?one:other,{n,...(v||{})}), troveIso=s=>String(s);',
    'let FEES={courierTransitMinDays:1,courierTransitMaxDays:4,leadDaysDefault:2};',
    grab(/const LEAD_DEFAULT=[^\n]*/), grab(/const leadOfP=[^\n]*/),
    grab(/function estOf\(lead\)\{[\s\S]*?\n\}/), grab(/function leadLine\(lead\)\{[^\n]*/),
    grab(/function shipLine\(p\)\{[\s\S]*?\n\}/), grab(/function orderEst\(groups\)\{[\s\S]*?\n\}/),
    'this.out={estOf,leadLine,shipLine,orderEst};',
  ].join('\n');
  const sandbox = {}; vm.runInNewContext(src, sandbox);
  const { estOf, leadLine, shipLine, orderEst } = sandbox.out;
  const seo = fs.readFileSync(path.join(__dirname, '..', 'src', 'seo.js'), 'utf8');
  assert.ok(seo.includes('`Arrives in ${est.label} · made for you, ready to send in ${est.leadDays} days`'));
  assert.equal(shipLine({ lead: 14 }), 'Arrives in 15–18 days · made for you, ready to send in 14 days');
  assert.equal(shipLine({ lead: 2 }), 'Arrives in 3–6 days across Dubai & Abu Dhabi');
  assert.equal(shipLine({}), 'Arrives in 3–6 days across Dubai & Abu Dhabi');
  assert.equal(leadLine(14), '14 days after your order');
  assert.equal(estOf(7).label, lt.estimate(7).label);
  const oe = orderEst({ a: [{ p: { lead: 2 } }], b: [{ p: { lead: 14 } }, { p: { lead: 3 } }] });
  assert.equal(oe.perShop.a.label, '3–6 days');
  assert.equal(oe.perShop.b.label, '15–18 days');
  assert.equal(oe.separately, true);
  // The basket line, the checkout per-shop rows and the confirmation use them.
  assert.match(html, /<div class="v c-eta">\$\{_t\('Arrives in \{label\}',\{label:esc\(estOf\(leadOfP\(p\)\)\.label\)\}\)\}<\/div>/);
  assert.match(html, /\$\{esc\(coEst\.perShop\[v\]\.label\)\}/);
  assert.match(html, /Pieces arrive separately as each is ready/);
  assert.match(html, /arrives in \{label\}',\{label:esc\(cfEst\.perShop\[v\]\.label\)\}/);
  assert.doesNotMatch(html, /<b>3–6 days<\/b>/, 'no fixed promise left in the checkout');
  assert.doesNotMatch(html, /arrives 3–6 days/);
});

test('checkout snapshots each piece\'s time; pack-by is per shop; the emails carry the concrete dates', async () => {
  const mk = (cookie, name, price, leadDays) => create(cookie, { name, price, leadDays }).then((r) => r.data.product.id);
  const scarf = await mk(sellerCookie, 'Scarf', 60, 2);
  const jumper = await mk(sellerCookie, 'Jumper', 50, 7);
  const bowl = await mk(seller2Cookie, 'Bowl', 40, 14);
  const co = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: scarf, qty: 1 }, { productId: jumper, qty: 1 }, { productId: bowl, qty: 1 }],
    address: { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' }, phone: '050 765 4321' } });
  assert.equal(co.status, 200, co.text);
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(co.data.orderId);
  // The maker changes the time afterwards: this order keeps what the buyer was shown.
  await ctx.api('PATCH', `/api/seller/products/${jumper}`, { cookie: sellerCookie, body: { leadDays: 30 } });
  assert.deepEqual(db.prepare('SELECT lead_days FROM order_items WHERE order_id=? ORDER BY id').all(order.id).map((r) => r.lead_days), [2, 7, 14]);

  sent.length = 0;
  const done = await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: co.data.orderId } });
  assert.equal(done.status, 200, done.text);
  await tick();
  const paid = db.prepare('SELECT title_transferred_at FROM orders WHERE id=?').get(order.id).title_transferred_at;
  const shA = db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shopA);
  const shB = db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shopB);
  assert.equal(shA.pack_by_at, lt.packByAt(paid, 7), 'Nora packs both pieces by the jumper\'s 7 days');
  assert.equal(shB.pack_by_at, lt.packByAt(paid, 14), 'Cara has her bowl\'s 14 days');

  const noraMail = mailsTo('knit@test.local')[0];
  const caraMail = mailsTo('clay@test.local')[0];
  assert.ok(noraMail.html.includes(`Please pack by ${lt.dubaiDay(shA.pack_by_at)}`));
  assert.ok(caraMail.html.includes(`Please pack by ${lt.dubaiDay(shB.pack_by_at)}`));
  assert.doesNotMatch(noraMail.html, /3–6 day delivery promise/);
  const receipt = mailsTo('amal@test.local')[0];
  assert.match(receipt.html, /<b>In 15–18 days<\/b>/);
  assert.match(receipt.html, /Pieces arrive separately as each is ready/);
  assert.match(receipt.html, /arriving in 15–18 days/);

  // The buyer's account and the seller's order card know the dates.
  const acct = (await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie })).data.orders.find((o) => o.id === co.data.orderId);
  const bShip = acct.shipments.find((s) => s.shop.name === 'Cara Clay');
  const day = 86400000;
  assert.equal(new Date(bShip.expected.from).getTime(), lt.fromSql(shB.pack_by_at).getTime() + day);
  assert.equal(new Date(bShip.expected.to).getTime(), lt.fromSql(shB.pack_by_at).getTime() + 4 * day);
  const sellerOrders = (await ctx.api('GET', '/api/seller/orders', { cookie: seller2Cookie })).data.orders;
  const card = sellerOrders.find((o) => o.order.publicId === co.data.orderId);
  assert.equal(card.packBy, shB.pack_by_at);
  assert.equal(card.packOverdue, false);
});

test('pack-by reminders: the maker once when the day passes, the admin once two days on, never for packed or refunded parcels', async () => {
  const sweep = require('../src/order-sweep');
  const mkOrder = (pid, packBy, { status = 'processing', refunded = false } = {}) => {
    const o = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,title_transferred_at,refunded_at)
      VALUES (?, 'buyer@test.local', 5000, 8000, 'paid', datetime('now','-5 days'), ?)`).run(pid, refunded ? '2026-09-29 10:00:00' : null).lastInsertRowid;
    db.prepare("INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?, 'Late cowl', 5000, 1)").run(o, shopA);
    return db.prepare('INSERT INTO shipments (order_id,shop_id,status,pack_by_at) VALUES (?,?,?,?)').run(o, shopA, status, packBy).lastInsertRowid;
  };
  const late = mkOrder('TRV-LATE1', '2026-10-01 19:59:59');
  const packed = mkOrder('TRV-LATE2', '2026-10-01 19:59:59', { status: 'shipped' });
  const refunded = mkOrder('TRV-LATE3', '2026-10-01 19:59:59', { refunded: true });
  const notYet = mkOrder('TRV-LATE4', db.prepare("SELECT datetime('now','+30 days') AS t").get().t); // still to come, whenever this runs

  sent.length = 0;
  // An hour after the pack-by day ended: maker reminded, admin not yet.
  let r = await sweep.sweepPackBy({ now: '2026-10-01 21:00:00' });
  assert.equal(r.reminded, 1);
  assert.equal(r.escalated, 0);
  const toMaker = mailsTo('knit@test.local');
  assert.equal(toMaker.length, 1);
  assert.match(toMaker[0].subject, /Reminder: order TRV-LATE1 is due to be packed/);
  assert.match(toMaker[0].html, /Thursday 1 October/);
  assert.equal(mailsTo('boss@test.local').length, 0);
  // The next hour: nothing new.
  r = await sweep.sweepPackBy({ now: '2026-10-01 22:00:00' });
  assert.equal(mailsTo('knit@test.local').length, 1, 'the maker reminder fires once');
  // Two days on: the admin hears, once.
  await sweep.sweepPackBy({ now: '2026-10-03 21:00:00' });
  await sweep.sweepPackBy({ now: '2026-10-03 22:00:00' });
  const toAdmin = mailsTo('boss@test.local');
  assert.equal(toAdmin.length, 1, 'the admin alert fires once');
  assert.match(toAdmin[0].subject, /Overdue: Nora Knits has not packed order TRV-LATE1/);
  assert.equal(mailsTo('knit@test.local').length, 1);
  for (const id of [packed, refunded, notYet]) {
    const s = db.prepare('SELECT pack_reminder_at, pack_escalated_at FROM shipments WHERE id=?').get(id);
    assert.equal(s.pack_reminder_at, null, `shipment ${id} was not reminded`);
  }
  assert.ok(db.prepare('SELECT pack_escalated_at FROM shipments WHERE id=?').get(late).pack_escalated_at);
  // Admin orders and the seller's card show a parcel whose day has really gone as overdue.
  db.prepare("UPDATE shipments SET pack_by_at=datetime('now','-1 day') WHERE id=?").run(late);
  const adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
  const ord = (await ctx.api('GET', '/api/admin/orders', { cookie: adminCookie })).data.orders.find((o) => o.publicId === 'TRV-LATE1');
  assert.equal(ord.parcels[0].packOverdue, true);
  assert.equal(ord.parcels[0].packed, false);
  const card = (await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie })).data.orders.find((o) => o.order.publicId === 'TRV-LATE1');
  assert.equal(card.packOverdue, true);
  const notYetCard = (await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie })).data.orders.find((o) => o.order.publicId === 'TRV-LATE4');
  assert.equal(notYetCard.packOverdue, false);
});
