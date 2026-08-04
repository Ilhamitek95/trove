'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Priced extras (gift wrap, a gift box, engraving …) — the seller lists them
 * with their own prices, the buyer ticks any at the product page. The chosen
 * ones are snapshotted on the line item and their cost is folded into the
 * line's unit price, so every money path keeps reading price_cents as usual.
 */

const ADDRESS = { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' };
const PHONE = '050 123 4567';
const EXTRAS = [{ name: 'Gift wrap', priceCents: 1500 }, { name: 'Handwritten card', priceCents: 0 }];

let ctx, db, buyerCookie, sellerCookie, boxId, plainId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal Rashid','buyer')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots');

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');

  boxId = (await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie, body: {
    name: 'Keepsake Box', category: 'Home & Living', price: 120, stock: 20, status: 'live', extras: EXTRAS } })).data.product.id;
  plainId = (await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie, body: {
    name: 'Plain Bowl', category: 'Ceramics', price: 50, stock: 9, status: 'live' } })).data.product.id;
});
after(async () => { await ctx.close(); });

const buy = (items) => ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: { items, address: ADDRESS, phone: PHONE } });
const storedLines = (publicId) => db.prepare('SELECT oi.* FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.public_id=? ORDER BY oi.id').all(publicId);

test('a shop lists its extras and shoppers see them priced in AED', async () => {
  const p = (await ctx.api('GET', `/api/products/${boxId}`)).data.product;
  assert.deepEqual(p.extras, [{ name: 'Gift wrap', price: 15 }, { name: 'Handwritten card', price: 0 }]);
  assert.deepEqual((await ctx.api('GET', `/api/products/${plainId}`)).data.product.extras, [], 'a piece with no extras says so');
});

test('messy seller input is cleaned up: trims, dedupes, drops empty rows', async () => {
  const res = await ctx.api('PATCH', `/api/seller/products/${plainId}`, { cookie: sellerCookie, body: {
    extras: [{ name: '  Gift wrap ', priceCents: 1200 }, { name: 'gift WRAP', priceCents: 900 }, { name: '', priceCents: '' }, { name: 'Gift box', priceCents: 2500.4 }] } });
  assert.equal(res.status, 200, res.text);
  const p = (await ctx.api('GET', `/api/products/${plainId}`)).data.product;
  assert.deepEqual(p.extras, [{ name: 'Gift wrap', price: 12 }, { name: 'Gift box', price: 25 }]);
  await ctx.api('PATCH', `/api/seller/products/${plainId}`, { cookie: sellerCookie, body: { extras: [] } });
});

test('a broken extras list is refused before anything is written', async () => {
  const bad = async (extras, body = {}) => (await ctx.api('PATCH', `/api/seller/products/${boxId}`, { cookie: sellerCookie, body: { ...body, extras } })).data.error;
  assert.match(await bad('gift wrap'), /must be a list/i);
  assert.match(await bad([{ priceCents: 900 }]), /name/i);
  assert.match(await bad([{ name: 'Gift wrap', priceCents: -200 }]), /doesn't look right/i);
  assert.match(await bad(Array.from({ length: 7 }, (_, i) => ({ name: `Extra ${i}`, priceCents: 100 }))), /Up to 6 extras/i);
  // …and a refused save leaves the product exactly as it was — including the
  // name that rode along in the same request.
  await bad([{ name: 'Gift wrap', priceCents: -200 }], { name: 'Renamed Box' });
  const p = (await ctx.api('GET', `/api/products/${boxId}`)).data.product;
  assert.equal(p.name, 'Keepsake Box');
  assert.deepEqual(p.extras, [{ name: 'Gift wrap', price: 15 }, { name: 'Handwritten card', price: 0 }]);
});

test('checkout prices extras from the product row, never from the client', async () => {
  // The buyer's client names the extra (any case) and even lies about the
  // price — the amount must come from the product.
  const res = await buy([{ productId: boxId, qty: 2, extras: [{ name: 'gift wrap', priceCents: 1 }] }]);
  assert.equal(res.status, 200, res.text);
  const line = storedLines(res.data.orderId)[0];
  assert.equal(line.price_cents, 12000 + 1500, 'unit price carries the extra');
  assert.deepEqual(JSON.parse(line.extras), [{ name: 'Gift wrap', priceCents: 1500 }], "the shop's spelling and the shop's price");
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(res.data.orderId);
  assert.equal(order.subtotal_cents, 2 * 13500, 'extras are per unit — both boxes get wrapped');
});

test('a free extra rides along without changing the price', async () => {
  const res = await buy([{ productId: boxId, qty: 1, extras: ['Handwritten card'] }]);
  assert.equal(res.status, 200, res.text);
  const line = storedLines(res.data.orderId)[0];
  assert.equal(line.price_cents, 12000);
  assert.deepEqual(JSON.parse(line.extras), [{ name: 'Handwritten card', priceCents: 0 }]);
});

test('an extra the shop never offered is refused by name', async () => {
  const res = await buy([{ productId: boxId, qty: 1, extras: ['Gold leaf'] }]);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /gold leaf.*isn't one of the extras for Keepsake Box/i);
  assert.equal((await buy([{ productId: plainId, qty: 1, extras: ['Gift wrap'] }])).status, 400, 'a piece with no extras accepts none');
});

test('extras stack on top of a variant price and reach both sides of the order', async () => {
  const mugId = (await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie, body: {
    name: 'Mug', category: 'Ceramics', price: 64, status: 'live', extras: [{ name: 'Gift wrap', priceCents: 1000 }],
    options: [{ name: 'Size', values: ['Small', 'Large'] }],
    variants: [{ key: 'Size:Small', stock: 4 }, { key: 'Size:Large', stock: 4, priceCents: 8000 }] } })).data.product.id;
  const res = await buy([{ productId: mugId, qty: 1, options: [{ name: 'Size', value: 'Large' }], extras: ['Gift wrap'] }]);
  assert.equal(res.status, 200, res.text);
  assert.equal(storedLines(res.data.orderId)[0].price_cents, 8000 + 1000, "the Large's own price plus the wrap");
  await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: res.data.orderId } });

  const seller = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  const item = seller.data.orders.find((o) => o.order.publicId === res.data.orderId).items[0];
  assert.deepEqual(item.extras, [{ name: 'Gift wrap', price: 10 }], 'the maker sees what to add to the parcel');

  const acct = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const mine = acct.data.orders.find((o) => o.id === res.data.orderId);
  assert.deepEqual(mine.items[0].extras, [{ name: 'Gift wrap', price: 10 }]);
  assert.deepEqual(mine.returns.items[0].extras, [{ name: 'Gift wrap', price: 10 }],
    'the return picker shows the wrapped line for what it is');
});

test('the snapshot survives the shop retiring the extra afterwards', async () => {
  const res = await buy([{ productId: boxId, qty: 1, extras: ['Gift wrap'] }]);
  assert.equal(res.status, 200, res.text);
  await ctx.api('PATCH', `/api/seller/products/${boxId}`, { cookie: sellerCookie, body: { extras: [] } });
  const line = storedLines(res.data.orderId)[0];
  assert.equal(line.price_cents, 13500, 'what was agreed at checkout stands');
  assert.deepEqual(JSON.parse(line.extras), [{ name: 'Gift wrap', priceCents: 1500 }]);
  // …but a NEW order can no longer tick it.
  assert.equal((await buy([{ productId: boxId, qty: 1, extras: ['Gift wrap'] }])).status, 400);
  await ctx.api('PATCH', `/api/seller/products/${boxId}`, { cookie: sellerCookie, body: { extras: EXTRAS } });
});
