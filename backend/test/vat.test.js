'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ VAT_REGISTERED: '1', RAIL_B_ENABLED: '1' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, shopId, productId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(pw);
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(uid, 'Test Pots', 'test-pots').lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,50,'live')")
    .run(shopId, 'Vase', 'Ceramics').lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('quarterly VAT report splits by rail with correct 5/105 amounts', async () => {
  // Consignment order: VAT = 5/105 × 23400 = 1114.
  const o1 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-VAT01','b@test.local',20000,2500,900,23400,'pending','consignment','pi_vat_1')`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)').run(o1, productId, shopId, 'Vase');
  await ctx.postWebhook({ id: 'evt_vat_a', type: 'payment_intent.succeeded', data: { object: { id: 'pi_vat_1', metadata: { order_id: String(o1) } } } });

  // Connect-rail order: VAT = 5/105 × margin (4000) = 190.
  const o2 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-VAT02','b@test.local',20000,2500,900,23400,'pending','connect','pi_vat_2')`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)').run(o2, productId, shopId, 'Vase');
  await ctx.postWebhook({ id: 'evt_vat_b', type: 'payment_intent.succeeded', data: { object: { id: 'pi_vat_2', metadata: { order_id: String(o2) } } } });

  assert.equal(db.prepare('SELECT vat_amount_cents FROM orders WHERE id=?').get(o1).vat_amount_cents, 1114);
  assert.equal(db.prepare('SELECT vat_amount_cents FROM orders WHERE id=?').get(o2).vat_amount_cents, 190);

  const rep = await ctx.api('GET', '/api/admin/vat-report', { cookie: adminCookie });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.vatRegistered, true);
  const consign = rep.data.rows.find((r) => r.rail === 'consignment');
  const connect = rep.data.rows.find((r) => r.rail === 'connect');
  assert.equal(consign.vatCents, 1114);
  assert.equal(connect.vatCents, 190);
  assert.match(consign.quarter, /^\d{4}-Q[1-4]$/);
});
