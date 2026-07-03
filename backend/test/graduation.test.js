'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie;
let capShopId; // consignment shop pushed over the cap

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(pw);
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('busy@test.local',?, 'Busy','seller')").run(pw).lastInsertRowid;
  capShopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(uid, 'Busy Shop', 'busy-shop').lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });
afterEach(() => { delete process.env.RAIL_B_ENABLED; });

test('cap monitor: >= AED 12k of paid settlements in 30 days flags the shop', async () => {
  // Two paid settlements totalling 1,250,000 fils (AED 12,500) inside 30 days.
  const st1 = db.prepare("INSERT INTO settlements (run_date,status,total_cents,paid_at) VALUES (date('now','-20 days'),'paid',650000,datetime('now','-20 days'))").run().lastInsertRowid;
  db.prepare("INSERT INTO settlement_items (settlement_id,shop_id,amount_cents,bank_reference) VALUES (?,?,650000,'Purchase of handmade goods — PO #t1')").run(st1, capShopId);
  const st2 = db.prepare("INSERT INTO settlements (run_date,status,total_cents,paid_at) VALUES (date('now','-6 days'),'paid',600000,datetime('now','-6 days'))").run().lastInsertRowid;
  db.prepare("INSERT INTO settlement_items (settlement_id,shop_id,amount_cents,bank_reference) VALUES (?,?,600000,'Purchase of handmade goods — PO #t2')").run(st2, capShopId);

  const flagged = require('../src/graduation').scanCaps();
  assert.equal(flagged, 1);
  assert.ok(db.prepare('SELECT graduation_flagged_at FROM shops WHERE id=?').get(capShopId).graduation_flagged_at);

  const q = await ctx.api('GET', '/api/admin/graduation', { cookie: adminCookie });
  const entry = q.data.queue.find((g) => g.shopId === capShopId);
  assert.ok(entry, 'flagged shop is in the queue');
  assert.equal(entry.paid30Cents, 1250000);

  // Scanning again does not re-flag.
  assert.equal(require('../src/graduation').scanCaps(), 0);
});

test('direct entry with Rail B OFF: queued, approval refused with 409', async () => {
  await ctx.api('POST', '/api/auth/register', { body: {
    role: 'seller', name: 'Licensed Lena', email: 'lena@test.local', password: 'testpass123',
    shopName: 'Lena Looms', location: 'Al Quoz, Dubai', about: 'Weaving heavyweight throws on a wooden loom in Al Quoz since 2019.',
    instagram: '@lenalooms', phone: '+971501112233', licenseNumber: 'ET-2024-9911',
  } });
  const shop = db.prepare("SELECT * FROM shops WHERE name='Lena Looms'").get();
  assert.equal(shop.connect_queue, 1);
  assert.equal(shop.tier, 'consignment');

  const verify = await ctx.api('POST', `/api/admin/graduation/${shop.id}/verify-license`, { cookie: adminCookie });
  assert.equal(verify.status, 200);

  const approve = await ctx.api('POST', `/api/admin/graduation/${shop.id}/approve`, { cookie: adminCookie });
  assert.equal(approve.status, 409);
  assert.match(approve.data.error, /Rail B/);
});

test('Rail B ON: approve creates a CUSTOM account; payouts-enabled webhook flips the tier', async () => {
  process.env.RAIL_B_ENABLED = '1';
  const shop = db.prepare("SELECT * FROM shops WHERE name='Lena Looms'").get();
  ctx.stripeMock.reset();

  const approve = await ctx.api('POST', `/api/admin/graduation/${shop.id}/approve`, { cookie: adminCookie });
  assert.equal(approve.status, 200, approve.text);
  assert.ok(approve.data.onboardingUrl);
  const acctCall = ctx.stripeMock.calls.find((c) => c.method === 'accounts.create');
  assert.equal(acctCall.params.type, 'custom');
  assert.equal(acctCall.params.country, 'AE');
  assert.equal(acctCall.params.company.registration_number, 'ET-2024-9911');
  assert.equal(acctCall.params.on_behalf_of, undefined);

  const acctId = approve.data.accountId;
  await ctx.postWebhook({ id: 'evt_acct_1', type: 'account.updated', data: { object: { id: acctId, charges_enabled: true, payouts_enabled: true } } });
  const after1 = db.prepare('SELECT * FROM shops WHERE id=?').get(shop.id);
  assert.equal(after1.tier, 'connect');
  assert.equal(after1.connect_queue, 0);
  assert.equal(after1.charges_enabled, 1);
});

test('single-connect-shop order routes as a destination charge and skips the ledger', async () => {
  process.env.RAIL_B_ENABLED = '1';
  const shop = db.prepare("SELECT * FROM shops WHERE name='Lena Looms'").get();
  db.prepare("UPDATE shops SET status='approved' WHERE id=?").run(shop.id);
  const pid = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,10,'live')")
    .run(shop.id, 'Wool Throw', 'Textiles').lastInsertRowid;

  ctx.stripeMock.reset();
  const co = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: pid, qty: 1 }], email: 'buyer@test.local' } });
  assert.equal(co.status, 200, co.text);

  const piCall = ctx.stripeMock.calls.find((c) => c.method === 'paymentIntents.create');
  assert.equal(piCall.params.amount, 23400); // 200 + 9 + 25
  assert.equal(piCall.params.transfer_data.destination, shop.stripe_account_id);
  assert.equal(piCall.params.application_fee_amount, 4000 + 900 + 2500); // margin + buyer fees
  assert.equal(piCall.params.on_behalf_of, undefined);

  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(co.data.orderId);
  assert.equal(order.rail, 'connect');

  // Payment succeeds → no consignment credit, no per-sale transfer needed.
  await ctx.postWebhook({ id: 'evt_dest_1', type: 'payment_intent.succeeded', data: { object: { id: order.stripe_payment_intent_id, metadata: { order_id: String(order.id) } } } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seller_balances WHERE order_id=?").get(order.id).n, 0);
  assert.equal(ctx.stripeMock.calls.filter((c) => c.method === 'transfers.create').length, 0);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'paid');
});

test('mixed cart stays on the consignment rail with a plain platform charge', async () => {
  process.env.RAIL_B_ENABLED = '1';
  const lena = db.prepare("SELECT * FROM shops WHERE name='Lena Looms'").get();
  const lenaProduct = db.prepare("SELECT id FROM products WHERE shop_id=?").get(lena.id).id;
  // A consignment shop's product in the same cart.
  db.prepare("UPDATE shops SET status='approved' WHERE id=?").run(capShopId);
  const busyProduct = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,10000,10,'live')")
    .run(capShopId, 'Clay Bowl', 'Ceramics').lastInsertRowid;

  ctx.stripeMock.reset();
  const co = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: lenaProduct, qty: 1 }, { productId: busyProduct, qty: 1 }], email: 'buyer@test.local' } });
  assert.equal(co.status, 200, co.text);
  const piCall = ctx.stripeMock.calls.find((c) => c.method === 'paymentIntents.create');
  assert.equal(piCall.params.transfer_data, undefined);
  assert.equal(piCall.params.application_fee_amount, undefined);
  assert.equal(db.prepare('SELECT rail FROM orders WHERE public_id=?').get(co.data.orderId).rail, 'consignment');
});
