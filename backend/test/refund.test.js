'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie;
let shopId, productId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paidOrder(pid, pi) {
  const oid = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES (?,?,20000,2500,900,23400,'pending','consignment',?)`).run(pid, 'buyer@test.local', pi).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)')
    .run(oid, productId, shopId, 'Vase');
  await ctx.postWebhook({ id: 'evt_' + pi, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(oid) } } } });
  return oid;
}

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pcrypto = require('../src/crypto');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(pw);
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  shopId = db.prepare(`INSERT INTO shops (user_id,name,slug,status,payout_bank_name,payout_account_name,iban_encrypted,iban_masked,agreement_version,agreement_accepted_at)
    VALUES (?,?,?, 'approved','Test Bank','Maker LLC',?,?, 'v1', datetime('now'))`)
    .run(uid, 'Test Pots', 'test-pots', pcrypto.encrypt('AE070331234567890123456'), pcrypto.maskIban('AE070331234567890123456')).lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,50,'live')")
    .run(shopId, 'Vase', 'Ceramics').lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('refund BEFORE settlement: Stripe refunded, no debit, credit never settles, unshipped parcel cancelled', async () => {
  const oid = await paidOrder('TRV-REF01', 'pi_ref_1');
  ctx.stripeMock.reset();

  const res = await ctx.api('POST', '/api/admin/orders/TRV-REF01/refund', { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);

  const refundCall = ctx.stripeMock.calls.find((c) => c.method === 'refunds.create');
  assert.ok(refundCall, 'Stripe refund issued');
  assert.equal(refundCall.params.payment_intent, 'pi_ref_1');
  assert.equal(refundCall.params.reverse_transfer, undefined, 'consignment rail: plain refund');

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
  assert.ok(order.refunded_at);
  // Unswept credit → NO debit (the supplier was never paid for it).
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seller_balances WHERE order_id=? AND type='debit_refund'").get(oid).n, 0);
  // And the credit can never become payable.
  const preview = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  assert.equal(preview.data.eligible.length + preview.data.excluded.length, 0);
  // Processing shipment was cancelled.
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  assert.equal(sh.status, 'cancelled');
});

test('refund AFTER settlement: debit -16000 drives the balance negative and nets forward', async () => {
  const oid = await paidOrder('TRV-REF02', 'pi_ref_2');
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });
  db.prepare("UPDATE shipments SET delivered_at=datetime('now','-8 days'), return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(sh.id);
  const run = await ctx.api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(run.status, 201);
  await ctx.api('POST', `/api/admin/settlements/${run.data.settlementId}/paid`, { cookie: adminCookie });

  const res = await ctx.api('POST', '/api/admin/orders/TRV-REF02/refund', { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);
  await sleep(80); // reverse pickup is fire-and-forget

  const debit = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='debit_refund'").get(oid);
  assert.ok(debit, 'debit exists for the settled credit');
  assert.equal(debit.amount_cents, -16000);
  assert.equal(debit.settlement_id, null, 'debit is unswept — nets against the NEXT run');

  // Delivered parcel → return pickup event logged.
  const ev = db.prepare("SELECT * FROM shipment_events WHERE shipment_id=? ORDER BY id DESC LIMIT 1").get(sh.id);
  assert.match(ev.note, /Return pickup booked/);

  // Next run: fresh 16000 credit nets to 0 → supplier held back, nothing paid.
  const oid3 = await paidOrder('TRV-REF03', 'pi_ref_3');
  const sh3 = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(oid3);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh3.id } });
  db.prepare("UPDATE shipments SET delivered_at=datetime('now','-8 days'), return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(sh3.id);
  const preview = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  const held = preview.data.excluded.find((x) => x.shopId === shopId);
  assert.ok(held, 'netted to zero → held back');
  assert.equal(held.netCents, 0);
});

test('refund guards: double refund and unpaid orders are 409', async () => {
  const dbl = await ctx.api('POST', '/api/admin/orders/TRV-REF02/refund', { cookie: adminCookie });
  assert.equal(dbl.status, 409);

  db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,rail)
    VALUES ('TRV-REF04','x@test.local',1000,4400,'pending','consignment')`).run();
  const pend = await ctx.api('POST', '/api/admin/orders/TRV-REF04/refund', { cookie: adminCookie });
  assert.equal(pend.status, 409);
});
