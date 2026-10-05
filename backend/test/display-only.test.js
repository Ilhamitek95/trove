'use strict';
/**
 * Display-only demo listings (owner 2026-10-05, src/display-only.js): on the
 * live site a demo login's pieces and services stay visible, but they can't
 * be bought or booked.
 *   - the public payloads say forSale / bookable false for demo owners only
 *     (never for a real maker, a real provider or the Trove Collection);
 *   - checkout refuses a basket holding a demo piece, bookings refuse a demo
 *     provider (409 display_only), whatever the page sends;
 *   - a demo piece's page carries no schema.org Offer;
 *   - DEMO_DISPLAY_ONLY=off lets them through again; the default is on in
 *     production only.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();
process.env.DEMO_DISPLAY_ONLY = 'on';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, demoPiece, realPiece, housePiece, demoService, realService;

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async () => ({ id: 'test' });
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  const user = (email, role) => db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)').run(email, pw, email.split('@')[0], role).lastInsertRowid;
  const shop = (uid, name, slug, house) => db.prepare("INSERT INTO shops (user_id,name,slug,status,is_house,pickup_address,pickup_phone) VALUES (?,?,?,'approved',?,'Al Quoz 3, Dubai','+971500000001')").run(uid, name, slug, house ? 1 : 0).lastInsertRowid;
  const piece = (shopId, name) => db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,50,'live')").run(shopId, name, 'Ceramics', 6400).lastInsertRowid;
  // The demo maker keeps its real demo email (seed-guard DEMO_EMAILS).
  demoPiece = piece(shop(user('mara@kilnandclay.com', 'seller'), 'Kiln & Clay', 'kiln-and-clay'), 'Speckled Mug');
  realPiece = piece(shop(user('real.maker@test.local', 'seller'), 'Real Studio', 'real-studio'), 'Real Bowl');
  // The house shop is never display-only, even when a demo login owns it locally.
  housePiece = piece(shop(user('hello@trove.com', 'seller'), 'Trove Collection', 'trove-collection', true), 'House Vase');
  const provider = (email, name, slug) => db.prepare("INSERT INTO service_providers (user_id,name,slug,status,categories) VALUES (?,?,?,'approved','[\"photography\"]')").run(user(email, 'seller'), name, slug).lastInsertRowid;
  const service = (pid, title) => db.prepare('INSERT INTO services (provider_id,title,category,price_cents) VALUES (?,?,?,?)').run(pid, title, 'photography', 30000).lastInsertRowid;
  demoService = service(provider('noor@noorletters.ae', 'Noor Letters', 'noor-letters'), 'Calligraphy class');
  realService = service(provider('real.provider@test.local', 'Real Frames', 'real-frames'), 'Home shoot');
});
after(async () => { delete process.env.DEMO_DISPLAY_ONLY; await ctx.close(); });

const checkout = (ids) => api('POST', '/api/checkout', {
  body: {
    items: ids.map((productId) => ({ productId, qty: 1 })), email: 'buyer@test.local', phone: '0501234567',
    address: { name: 'Layla', line: 'Marina Gate 2, apt 2104', city: 'Dubai', emirate: 'Dubai' },
  },
});
const book = (id) => api('POST', `/api/services/${id}/book`, {
  body: { name: 'Layla', email: 'buyer@test.local', phone: '0501234567', area: 'Dubai', agreeTerms: true, paymentMethod: 'direct' },
});
const forSale = async () => Object.fromEntries((await api('GET', '/api/products')).data.products.map((p) => [p.id, p.forSale]));

test('only the demo shop’s piece is marked not for sale', async () => {
  const sale = await forSale();
  assert.equal(sale[demoPiece], false);
  assert.equal(sale[realPiece], true);
  assert.equal(sale[housePiece], true);
  assert.equal((await api('GET', `/api/products/${demoPiece}`)).data.product.forSale, false);
});

test('checkout refuses any basket holding a demo piece and takes the rest', async () => {
  for (const basket of [[demoPiece], [realPiece, demoPiece]]) {
    const r = await checkout(basket);
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'display_only');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0, 'no order is opened for a refused basket');
  assert.equal((await checkout([realPiece, housePiece])).status, 200);
});

test('a demo provider’s services are not bookable; a real provider’s are', async () => {
  const list = (await api('GET', '/api/services')).data.services;
  assert.equal(list.find((s) => s.id === demoService).bookable, false);
  assert.equal(list.find((s) => s.id === realService).bookable, true);
  const page = (await api('GET', '/api/services/providers/noor-letters')).data;
  assert.equal(page.services[0].bookable, false);
  const r = await book(demoService);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'display_only');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_bookings').get().n, 0);
  assert.equal((await book(realService)).status, 201);
});

test('a demo piece’s page offers nothing for sale to search engines', async () => {
  const demo = await api('GET', `/pieces/${demoPiece}-speckled-mug`);
  assert.equal(demo.status, 200);
  assert.doesNotMatch(demo.text, /"@type":\s*"Offer"/);
  const real = await api('GET', `/pieces/${realPiece}-real-bowl`);
  assert.match(real.text, /"@type":\s*"Offer"/);
});

test('DEMO_DISPLAY_ONLY=off lets demo pieces and services through again', async () => {
  process.env.DEMO_DISPLAY_ONLY = 'off';
  try {
    assert.equal((await forSale())[demoPiece], true);
    assert.equal((await checkout([demoPiece])).status, 200);
    assert.equal((await book(demoService)).status, 201);
  } finally { process.env.DEMO_DISPLAY_ONLY = 'on'; }
});

test('the default is on in production and off elsewhere', () => {
  const { enabled } = require('../src/display-only');
  const saved = { flag: process.env.DEMO_DISPLAY_ONLY, env: process.env.NODE_ENV };
  try {
    delete process.env.DEMO_DISPLAY_ONLY;
    process.env.NODE_ENV = 'production'; assert.equal(enabled(), true);
    process.env.NODE_ENV = 'test'; assert.equal(enabled(), false);
    process.env.DEMO_DISPLAY_ONLY = 'off'; process.env.NODE_ENV = 'production'; assert.equal(enabled(), false);
  } finally { process.env.DEMO_DISPLAY_ONLY = saved.flag; process.env.NODE_ENV = saved.env; }
});
