'use strict';
/**
 * Server-side input rules for what sellers, providers and applicants write:
 * no markup in short display fields, strict colours, capped lengths, bounded
 * money and stock, whitelisted statuses, strong-enough passwords and
 * checksummed IBANs — plus the checkout guard against non-positive lines and
 * the public-id retry.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, cookie, shopId;
const ADDRESS = { name: 'Buyer', line: '1 Marina Walk', city: 'Dubai', emirate: 'Dubai' };
const PHONE = '0501234567';

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('val@test.local',?,'Val','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,location,color) VALUES (?,?,?,'approved','Al Quoz, Dubai','#BD9C8C')")
    .run(uid, 'Val Pots', 'val-pots').lastInsertRowid;
  cookie = await ctx.loginAs('val@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const patchMe = (body) => ctx.api('PATCH', '/api/seller/me', { cookie, body });
const shop = () => db.prepare('SELECT * FROM shops WHERE id=?').get(shopId);

/* ---------------- Shop profile ---------------- */

test('shop colour must be #RRGGBB — CSS injection is refused and nothing is written', async () => {
  for (const color of ['red', '#FFF', "#BD9C8C'),url(x", '#BD9C8C;background:url(javascript:1)', '<svg/onload=alert(1)>']) {
    const r = await patchMe({ color });
    assert.equal(r.status, 400, `colour ${color}`);
    assert.match(r.data.error, /hex code/);
  }
  assert.equal(shop().color, '#BD9C8C');
  const ok = await patchMe({ color: '#a1b2c3' });
  assert.equal(ok.status, 200);
  assert.equal(shop().color, '#a1b2c3');
});

test('shop name and location refuse markup and overlong values; the substring area test no longer lets markup through', async () => {
  let r = await patchMe({ name: '<img src=x onerror=alert(1)>' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /< or >/);
  r = await patchMe({ name: 'x'.repeat(81) });
  assert.equal(r.status, 400);
  r = await patchMe({ location: 'Dubai<script>alert(1)</script>' });
  assert.equal(r.status, 400);
  r = await patchMe({ location: 'Dubai ' + 'x'.repeat(80) });
  assert.equal(r.status, 400);
  r = await patchMe({ bio: 'y'.repeat(2001) });
  assert.equal(r.status, 400);
  assert.equal(shop().name, 'Val Pots');

  r = await patchMe({ name: '  Val & Co Pots  ', location: 'Jumeirah, Dubai', bio: 'Thrown by hand, fired in Al Quoz.' });
  assert.equal(r.status, 200, r.text);
  assert.equal(shop().name, 'Val & Co Pots', 'trimmed');
  assert.equal(shop().location, 'Jumeirah, Dubai');

  const { isServiceable } = require('../src/service-area');
  assert.equal(isServiceable('Dubai'), true);
  assert.equal(isServiceable('Dubai"><img src=x>'), false);
});

test('pickup address refuses markup', async () => {
  const r = await patchMe({ pickupAddress: 'Warehouse 4, Al Quoz <b>Dubai</b>' });
  assert.equal(r.status, 400);
});

/* ---------------- Products ---------------- */

const base = { name: 'Speckled mug', price: 45, stock: 3, status: 'live', category: 'Ceramics' };
const create = (over) => ctx.api('POST', '/api/seller/products', { cookie, body: { ...base, ...over } });

test('product price: negative, zero, under AED 1, over AED 100,000 and non-numeric are all 400 (never 500)', async () => {
  for (const price of [-500, 0, 0.5, 100001, 'abc', 'NaN', true, 'Infinity']) {
    const r = await create({ price });
    assert.equal(r.status, 400, `price ${JSON.stringify(price)} → ${r.status} ${r.text}`);
  }
  const r = await create({ price: undefined });
  assert.equal(r.status, 400);
  const ok = await create({ price: '1' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.data.product.price_cents, 100);
});

test('compare-at, stock, status, image seed and names are validated on create', async () => {
  assert.equal((await create({ compareAt: -10 })).status, 400);
  assert.equal((await create({ compareAt: 'x' })).status, 400);
  assert.equal((await create({ stock: -1 })).status, 400);
  assert.equal((await create({ stock: 1.5 })).status, 400);
  assert.equal((await create({ stock: 'lots' })).status, 400);
  assert.equal((await create({ status: 'whatever' })).status, 400);
  assert.equal((await create({ imageSeed: '"><svg onload=1>' })).status, 400);
  assert.equal((await create({ name: '<b>Mug</b>' })).status, 400);
  assert.equal((await create({ name: 'm'.repeat(121) })).status, 400);
  assert.equal((await create({ description: 'd'.repeat(5001) })).status, 400);
  const ok = await create({ compareAt: 60, stock: '4', status: 'draft' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.data.product.compare_at_cents, 6000);
  assert.equal(ok.data.product.stock, 4);
});

test('variants, extras and options are bounded and markup-free', async () => {
  const options = [{ name: 'Glaze', values: ['Ash', 'Clay'] }];
  let r = await create({ options, variants: [{ key: 'Glaze:Ash', stock: -2 }] });
  assert.equal(r.status, 400);
  r = await create({ options, variants: [{ key: 'Glaze:Ash', stock: 1, priceCents: -500 }] });
  assert.equal(r.status, 400);
  r = await create({ options, variants: [{ key: 'Glaze:Ash', stock: 1, priceCents: 50 }] });
  assert.equal(r.status, 400, 'a variant price under AED 1');
  r = await create({ options: [{ name: '<i>Glaze</i>', values: ['Ash'] }] });
  assert.equal(r.status, 400);
  r = await create({ options: [{ name: 'Glaze', values: ['<img src=x>'] }] });
  assert.equal(r.status, 400);
  r = await create({ extras: [{ name: 'Gift wrap<script>', priceCents: 1500 }] });
  assert.equal(r.status, 400);
  r = await create({ extras: [{ name: 'Gift wrap', priceCents: 100000 * 100 + 1 }] });
  assert.equal(r.status, 400);
  r = await create({ options, variants: [{ key: 'Glaze:Ash', stock: 2, priceCents: 5500 }, { key: 'Glaze:Clay', stock: 1 }], extras: [{ name: 'Gift wrap', priceCents: 1500 }] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.product.stock, 3);
});

test('PATCH applies the same rules and a rejected save changes nothing', async () => {
  const made = await create({});
  const id = made.data.product.id;
  const patch = (body) => ctx.api('PATCH', `/api/seller/products/${id}`, { cookie, body });
  for (const body of [{ price: -1 }, { price: 0 }, { price: 'x' }, { stock: -3 }, { status: 'pwned' }, { name: '<x>' }, { compareAt: -5 }]) {
    const r = await patch(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const row = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  assert.equal(row.price_cents, 4500);
  assert.equal(row.stock, 3);
  assert.equal(row.status, 'live');
  const ok = await patch({ price: 50, stock: 7, status: 'hidden', compareAt: null });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.product.price_cents, 5000);
  assert.equal(ok.data.product.stock, 7);
  assert.equal(ok.data.product.status, 'hidden');
  assert.equal(ok.data.product.compare_at_cents, null);
});

/* ---------------- Checkout ---------------- */

test('checkout refuses a line whose unit price is not positive (legacy bad rows)', async () => {
  const good = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,60000,5,'live')")
    .run(shopId, 'Honest vase', 'Ceramics').lastInsertRowid;
  const bad = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,-50000,5,'live')")
    .run(shopId, 'Negative vase', 'Ceramics').lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const r = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: good, qty: 1 }, { productId: bad, qty: 1 }], email: 'b@test.local', address: ADDRESS, phone: PHONE } });
  assert.equal(r.status, 400, r.text);
  assert.match(r.data.error, /Negative vase/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before, 'no order row');
});

test('a public order id clash is retried instead of failing the checkout', async () => {
  const pid = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,5,'live')")
    .run(shopId, 'Retry bowl', 'Ceramics').lastInsertRowid;
  db.prepare("INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status) VALUES ('TRV-CLASH1','x@test.local',1,0,0,1,'paid')").run();
  const ids = ['TRV-CLASH1', 'TRV-CLASH1', 'TRV-FRESH1'];
  const checkout = require('../src/routes/checkout.routes');
  checkout.setPublicIdGenerator(() => ids.shift());
  try {
    const r = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: pid, qty: 1 }], email: 'b@test.local', address: ADDRESS, phone: PHONE } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.orderId, 'TRV-FRESH1');
  } finally { checkout.setPublicIdGenerator(null); }
});

/* ---------------- Accounts ---------------- */

test('sign-up needs a password of at least 8 characters and a markup-free name', async () => {
  let r = await ctx.api('POST', '/api/auth/register', { body: { email: 'short@test.local', name: 'Short', password: 'abc' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /at least 8 characters/);
  r = await ctx.api('POST', '/api/auth/register', { body: { email: 'short@test.local', name: 'Short', password: '1234567' } });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/auth/register', { body: { email: 'mark@test.local', name: '<img src=x onerror=1>', password: 'longenough1' } });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/auth/register', { body: { email: 'short@test.local', name: 'Short', password: '12345678' } });
  assert.equal(r.status, 201, r.text);
});

test('a shop application refuses a shop name with markup', async () => {
  const r = await ctx.api('POST', '/api/auth/register', { body: {
    role: 'seller', email: 'shopx@test.local', name: 'Shop X', password: 'longenough1',
    shopName: 'Pots<script>alert(1)</script>', instagram: '@x', phone: '0501234567', location: 'Dubai',
  } });
  assert.equal(r.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email='shopx@test.local'").get().c, 0);
});

test('provider profile and service fields refuse markup', async () => {
  const uid = db.prepare("SELECT id FROM users WHERE email='val@test.local'").get().id;
  db.prepare("INSERT INTO service_providers (user_id,name,slug,status,categories) VALUES (?,?,?,'approved','[]')").run(uid, 'Val Studio', 'val-studio');
  let r = await ctx.api('PATCH', '/api/provider/me', { cookie, body: { name: 'Val <b>Studio</b>' } });
  assert.equal(r.status, 400);
  r = await ctx.api('PATCH', '/api/provider/me', { cookie, body: { bio: 'b'.repeat(2001) } });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/provider/services', { cookie, body: { title: '<img src=x>', category: 'workshops', priceCents: 10000 } });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/provider/services', { cookie, body: { title: 'Wheel class', category: 'workshops', priceCents: 10000, duration: '2h<script>' } });
  assert.equal(r.status, 400);
});

/* ---------------- Payouts ---------------- */

test('IBAN: the mod-97 checksum and the UAE shape are both enforced', () => {
  const { ibanError } = require('../src/validate');
  assert.equal(ibanError('AE070331234567890123456'), null);
  assert.equal(ibanError('ae07 0331 2345 6789 0123 456'), null, 'spaces and case are forgiven');
  assert.match(ibanError('AE123456789012345678901'), /doesn't add up/);
  assert.match(ibanError('AE07033123456789012345'), /UAE IBAN/, 'too short');
  assert.match(ibanError('GB82WEST12345698765432'), /UAE IBAN/, 'not a UAE IBAN');
});

test('payout setup refuses an IBAN with a bad checksum (400) before anything is stored', async () => {
  process.env.PAYOUT_ENC_KEY = process.env.PAYOUT_ENC_KEY || 'a'.repeat(64);
  const r = await ctx.api('POST', '/api/seller/payout-setup', { cookie, body: {
    emiratesIdLast4: '1234', emiratesIdExpiry: '2099-01-01', iban: 'AE123456789012345678901',
    accountName: 'Val', bankName: 'ENBD', acceptAgreement: true,
  } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /IBAN/);
  assert.equal(shop().iban_encrypted, null);
});
