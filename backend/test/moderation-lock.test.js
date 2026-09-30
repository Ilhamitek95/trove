'use strict';
/**
 * Moderation lock: a piece an admin hid can't be put back on sale by its
 * seller (the seller sees 'Hidden by Trove — contact us'); only an admin
 * status change lifts it. A seller hiding their own piece is not a lock.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, seller, productId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?,'Boss','admin')").run(pw);
  const owner = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('pots.owner@test.local',?,'Pia Potter','seller')").run(pw).lastInsertRowid;
  const shop = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?,'approved','consignment')").run(owner, 'Pia Pots', 'pia-pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,'Speckled Mug','Home & Living',6400,5,'live')").run(shop).lastInsertRowid;
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
  seller = await ctx.loginAs('pots.owner@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const call = (method, path, opts) => ctx.api(method, path, opts);

test('an admin-hidden piece stays hidden: the seller sees it but cannot put it back on sale', async () => {
  const p = { id: productId };
  assert.equal((await call('PATCH', `/api/admin/products/${p.id}`, { cookie: adminCookie, body: { status: 'hidden' } })).status, 200);
  const mine = (await call('GET', '/api/seller/products', { cookie: seller })).data.products.find((x) => x.id === p.id);
  assert.ok(mine.admin_hidden_at, 'the seller payload says Trove hid it');
  assert.ok((await call('GET', '/api/admin/products', { cookie: adminCookie })).data.products.find((x) => x.id === p.id).adminHidden);

  for (const status of ['live', 'draft']) {
    const r = await call('PATCH', `/api/seller/products/${p.id}`, { cookie: seller, body: { status } });
    assert.equal(r.status, 409, status);
    assert.equal(r.data.code, 'admin_hidden');
    assert.match(r.data.error, /Hidden by Trove — contact us/);
  }
  assert.equal(db.prepare('SELECT status FROM products WHERE id=?').get(p.id).status, 'hidden');
  const edit = await call('PATCH', `/api/seller/products/${p.id}`, { cookie: seller, body: { description: 'Now with a better photo.' } });
  assert.equal(edit.status, 200, 'other edits still save');
  assert.equal(edit.data.product.status, 'hidden');
  const pub = await call('GET', '/api/products');
  assert.ok(!JSON.stringify(pub.data).includes('Speckled Mug'), 'not on the storefront');

  // Only an admin lifts it.
  await call('PATCH', `/api/admin/products/${p.id}`, { cookie: adminCookie, body: { status: 'live' } });
  assert.equal(db.prepare('SELECT admin_hidden_at FROM products WHERE id=?').get(p.id).admin_hidden_at, null);
  assert.equal((await call('PATCH', `/api/seller/products/${p.id}`, { cookie: seller, body: { status: 'draft' } })).status, 200);

  // The seller hiding its own piece is not a lock.
  await call('PATCH', `/api/seller/products/${p.id}`, { cookie: seller, body: { status: 'hidden' } });
  assert.equal((await call('PATCH', `/api/seller/products/${p.id}`, { cookie: seller, body: { status: 'live' } })).status, 200);
});
