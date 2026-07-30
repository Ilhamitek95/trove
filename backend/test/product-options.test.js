'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Seller-defined product options (Colour: Sand / Clay, Size: S / M / L).
 * One stock number and one price cover them all — the buyer's pick is a
 * snapshot on the line item that travels to the maker with the order.
 */

const ADDRESS = { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' };
const PHONE = '050 123 4567';
const OPTIONS = [{ name: 'Colour', values: ['Sand', 'Clay', 'Ink'] }, { name: 'Size', values: ['Small', 'Large'] }];
// Every combination stocked, except Ink/Large which the shop has run out of.
const STOCKED = [{ name: 'Colour', values: ['Sand', 'Clay', 'Ink'] }, { name: 'Size', values: ['Small', 'Large'] }]
  .reduce((rows, g) => rows.flatMap((r) => g.values.map((v) => [...r, `${g.name}:${v}`])), [[]])
  .map((parts) => ({ key: parts.join('|'), stock: parts.join('|') === 'Colour:Ink|Size:Large' ? 0 : 5 }));

let ctx, db, buyerCookie, sellerCookie, mugId, plainId, scratchId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal Rashid','buyer')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  plainId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shopId, 'Plain Bowl', 'Ceramics', 5000, 9).lastInsertRowid;

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');

  const created = await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie, body: {
    name: 'Mug', category: 'Ceramics', price: 64, status: 'live', options: OPTIONS, variants: STOCKED } });
  mugId = created.data.product.id;
  // A throwaway for the destructive edits, so the two above stay pristine.
  scratchId = (await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie, body: {
    name: 'Scratch Vase', category: 'Ceramics', price: 30, stock: 4, status: 'live' } })).data.product.id;
});
after(async () => { await ctx.close(); });

test('a shop lists its variations and shoppers see them on the product', async () => {
  const res = await ctx.api('GET', `/api/products/${mugId}`);
  assert.deepEqual(res.data.product.options, OPTIONS);
  assert.deepEqual((await ctx.api('GET', `/api/products/${plainId}`)).data.product.options, [], 'a piece with no variations says so');
});

test('half-filled and oversized option lists are refused with a useful message', async () => {
  const bad = async (options) => (await ctx.api('PATCH', `/api/seller/products/${mugId}`, { cookie: sellerCookie, body: { options } })).data.error;
  assert.match(await bad([{ name: 'Colour', values: [] }]), /at least one choice/i);
  assert.match(await bad([{ values: ['Sand'] }]), /name/i);
  assert.match(await bad([{ name: 'A', values: ['1'] }, { name: 'B', values: ['1'] }, { name: 'C', values: ['1'] }, { name: 'D', values: ['1'] }]), /3 option groups/i);
  // …and a refused save leaves the product exactly as it was.
  assert.deepEqual((await ctx.api('GET', `/api/products/${mugId}`)).data.product.options, OPTIONS);
});

test('duplicates and stray whitespace are cleaned up rather than stored', async () => {
  const res = await ctx.api('PATCH', `/api/seller/products/${scratchId}`, { cookie: sellerCookie, body: {
    options: [{ name: '  Colour  ', values: ['  Sand ', 'sand', 'Clay', ''] }, { name: 'colour', values: ['Ink'] }],
    variants: [{ key: 'Colour:Sand', stock: 2 }, { key: 'Colour:Clay', stock: 3 }] } });
  assert.equal(res.status, 200);
  const p = (await ctx.api('GET', `/api/products/${scratchId}`)).data.product;
  assert.deepEqual(p.options, [{ name: 'Colour', values: ['Sand', 'Clay'] }], 'trimmed, deduped, no empty group name repeated');
  assert.equal(p.stock, 5, 'the product stock is what the grid adds up to');
});

test('dropping the variations keeps the stock the grid added up to', async () => {
  const res = await ctx.api('PATCH', `/api/seller/products/${scratchId}`, { cookie: sellerCookie, body: { options: [] } });
  assert.equal(res.status, 200);
  const p = (await ctx.api('GET', `/api/products/${scratchId}`)).data.product;
  assert.deepEqual(p.options, []);
  assert.deepEqual(p.variants, []);
  assert.equal(p.stock, 5, 'simplifying a listing must not silently sell it out');
});

test('checkout insists on a choice for every group the shop offers', async () => {
  const buy = (options) => ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: mugId, qty: 1, options }], address: ADDRESS, phone: PHONE } });

  assert.match((await buy(undefined)).data.error, /choose a colour for Mug/i);
  assert.match((await buy([{ name: 'Colour', value: 'Clay' }])).data.error, /choose a size for Mug/i);
  assert.match((await buy([{ name: 'Colour', value: 'Turquoise' }, { name: 'Size', value: 'Large' }])).data.error, /isn't one of the colour choices/i);
});

test('the choice is snapshotted on the line item and reaches both sides of the order', async () => {
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: mugId, qty: 1, options: [{ name: 'colour', value: 'clay' }, { name: 'Size', value: 'Large' }] }],
    address: ADDRESS, phone: PHONE } });
  assert.equal(res.status, 200, res.text);
  await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: res.data.orderId } });

  // Stored in the shop's own spelling, whatever case the buyer's client sent.
  const stored = db.prepare('SELECT oi.options FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.public_id=?').get(res.data.orderId);
  assert.deepEqual(JSON.parse(stored.options), [{ name: 'Colour', value: 'Clay' }, { name: 'Size', value: 'Large' }]);

  const seller = await ctx.api('GET', '/api/seller/orders', { cookie: sellerCookie });
  const line = seller.data.orders.find((o) => o.order.publicId === res.data.orderId).items[0];
  assert.deepEqual(line.options, [{ name: 'Colour', value: 'Clay' }, { name: 'Size', value: 'Large' }], 'the maker knows which one to pack');

  const acct = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  const mine = acct.data.orders.find((o) => o.id === res.data.orderId);
  assert.deepEqual(mine.items[0].options, [{ name: 'Colour', value: 'Clay' }, { name: 'Size', value: 'Large' }]);
  assert.deepEqual(mine.returns.items[0].options, [{ name: 'Colour', value: 'Clay' }, { name: 'Size', value: 'Large' }],
    'the return picker can tell two lines of the same piece apart');
});

test('the server owns the grid: every combination exists, none invented', async () => {
  const p = (await ctx.api('GET', `/api/products/${mugId}`)).data.product;
  assert.equal(p.variants.length, 6, '3 colours × 2 sizes');
  assert.deepEqual(p.variants.map((v) => v.key).sort(), [
    'Colour:Clay|Size:Large', 'Colour:Clay|Size:Small', 'Colour:Ink|Size:Large',
    'Colour:Ink|Size:Small', 'Colour:Sand|Size:Large', 'Colour:Sand|Size:Small'].sort());
  // The invariant, not a fixed number — earlier tests in this file buy some.
  assert.equal(p.stock, p.variants.reduce((t, v) => t + v.stock, 0), 'product stock is the sum of the grid');
  assert.equal(p.variants.find((v) => v.key === 'Colour:Ink|Size:Large').stock, 0, 'the one the shop ran out of');
  assert.ok(p.variants.filter((v) => v.stock > 0).length >= 4, 'the rest are still stocked');
});

test('a sold-out combination cannot be bought while the others still can', async () => {
  const buy = (colour) => ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: mugId, qty: 1, options: [{ name: 'Colour', value: colour }, { name: 'Size', value: 'Large' }] }],
    address: ADDRESS, phone: PHONE } });

  const sold = await buy('Ink');
  assert.equal(sold.status, 409);
  assert.match(sold.data.error, /out of stock/i);
  assert.match(sold.data.error, /Colour: Ink/, 'says which one, not just the product');
  assert.equal((await buy('Sand')).status, 200, 'the other glazes are unaffected');
});

test('stock is counted across the whole basket, not line by line', async () => {
  // Two lines of the same variant (different personalisation) used to pass
  // one stock check each and oversell between them.
  const line = (perso) => ({ productId: mugId, qty: 3, personalization: perso, options: [{ name: 'Colour', value: 'Clay' }, { name: 'Size', value: 'Small' }] });
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [line('AB'), line('CD')], address: ADDRESS, phone: PHONE } });
  assert.equal(res.status, 409, 'six wanted, five in stock');
  assert.match(res.data.error, /Only 5 left/);
});

test('paying takes the stock off that combination alone', async () => {
  const before = (await ctx.api('GET', `/api/products/${mugId}`)).data.product;
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: mugId, qty: 2, options: [{ name: 'Colour', value: 'Sand' }, { name: 'Size', value: 'Small' }] }],
    address: ADDRESS, phone: PHONE } });
  await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: res.data.orderId } });

  const after = (await ctx.api('GET', `/api/products/${mugId}`)).data.product;
  const stockOf = (p, key) => p.variants.find((v) => v.key === key).stock;
  assert.equal(stockOf(after, 'Colour:Sand|Size:Small'), stockOf(before, 'Colour:Sand|Size:Small') - 2, 'the one they bought');
  assert.equal(stockOf(after, 'Colour:Clay|Size:Small'), stockOf(before, 'Colour:Clay|Size:Small'), 'every other combination untouched');
  assert.equal(after.stock, before.stock - 2, 'the product total stays the sum of the grid');
});

test('a variant can carry its own price, and the server charges that one', async () => {
  await ctx.api('PATCH', `/api/seller/products/${mugId}`, { cookie: sellerCookie, body: {
    variants: STOCKED.map((v) => (v.key === 'Colour:Clay|Size:Large' ? { ...v, priceCents: 9900 } : v)) } });
  const pub = (await ctx.api('GET', `/api/products/${mugId}`)).data.product;
  assert.equal(pub.variants.find((v) => v.key === 'Colour:Clay|Size:Large').price, 99, 'shown in AED');
  assert.equal(pub.variants.find((v) => v.key === 'Colour:Sand|Size:Large').price, null, 'the rest fall back to the product price');

  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: mugId, qty: 1, options: [{ name: 'Colour', value: 'Clay' }, { name: 'Size', value: 'Large' }] }],
    address: ADDRESS, phone: PHONE } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.amount, 9900 + 900 + 2500, 'the variant price, not the product price');
  const item = db.prepare('SELECT price_cents FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.public_id=?').get(res.data.orderId);
  assert.equal(item.price_cents, 9900, 'snapshotted on the line item');
});

test('a combination the shop never listed is refused', async () => {
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: mugId, qty: 1, options: [{ name: 'Colour', value: 'Sand' }, { name: 'Size', value: 'Enormous' }] }],
    address: ADDRESS, phone: PHONE } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /isn't one of the size choices/i);
});

test('a piece with no options is bought exactly as before', async () => {
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: plainId, qty: 1 }], address: ADDRESS, phone: PHONE } });
  assert.equal(res.status, 200, res.text);
  const stored = db.prepare('SELECT oi.options FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.public_id=?').get(res.data.orderId);
  assert.deepEqual(JSON.parse(stored.options), []);
});
