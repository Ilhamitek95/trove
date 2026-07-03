'use strict';
/**
 * The spec's worked example, end to end through the public API:
 *
 *   AED 200 item + AED 9 service fee + AED 25 delivery → buyer charged AED 234
 *   on Trove's own Stripe account. Supplier credit = AED 160 (list − 20%).
 *   Delivered → 7-day window closes → Tuesday run → settlement item of 160
 *   with the purchase-order bank reference → CSV → paid → purchase note.
 *   With VAT_REGISTERED, the order captures 5/105 × 23400 = 1114 fils.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874', VAT_REGISTERED: '1' });

const fs = require('fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, sellerCookie;
let shopId, productId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pcrypto = require('../src/crypto');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(pw);
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  shopId = db.prepare(`INSERT INTO shops (user_id,name,slug,status,payout_bank_name,payout_account_name,iban_encrypted,iban_masked,agreement_version,agreement_accepted_at)
    VALUES (?,?,?, 'approved','Mashreq','Maker LLC',?,?, 'v1', datetime('now'))`)
    .run(uid, 'Worked Example Pots', 'we-pots', pcrypto.encrypt('AE070331234567890123456'), pcrypto.maskIban('AE070331234567890123456')).lastInsertRowid;
  productId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,10,'live')")
    .run(shopId, 'Stoneware Vase', 'Ceramics').lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('worked example: pay 234 → credit 160 → deliver → window → run → CSV → paid → note', async () => {
  // 1. Checkout through the public API: server computes 200 + 9 + 25 = 234.
  ctx.stripeMock.reset();
  const co = await ctx.api('POST', '/api/checkout', {
    body: {
      items: [{ productId, qty: 1 }],
      email: 'layla@test.local',
      address: { name: 'Layla', line: 'Apt 1, Marina Gate', city: 'Dubai Marina, Dubai', emirate: 'Dubai' },
    },
  });
  assert.equal(co.status, 200, co.text);
  assert.equal(co.data.amount, 23400);
  const piCall = ctx.stripeMock.calls.find((c) => c.method === 'paymentIntents.create');
  assert.equal(piCall.params.amount, 23400);
  assert.equal(piCall.params.transfer_data, undefined, 'platform charge — no Connect fields');

  // 2. Payment succeeds → title transfers, supplier credited 160, VAT 1114.
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(co.data.orderId);
  await ctx.postWebhook({ id: 'evt_we_1', type: 'payment_intent.succeeded', data: { object: { id: order.stripe_payment_intent_id, metadata: { order_id: String(order.id) } } } });
  await sleep(80); // pickup booking is fire-and-forget
  const paid = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(paid.status, 'paid');
  assert.ok(paid.title_transferred_at);
  assert.equal(paid.vat_amount_cents, 1114);
  const credit = db.prepare("SELECT * FROM seller_balances WHERE order_id=? AND type='credit_sale'").get(order.id);
  assert.equal(credit.amount_cents, 16000);

  // 3. Courier delivers; the 7-day window runs, then closes (backdated).
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(order.id);
  assert.match(sh.delivery_ref, /^QMOCK-/, 'pickup was booked with the mock courier');
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } });
  let mine = await ctx.api('GET', '/api/seller/settlements', { cookie: sellerCookie });
  assert.equal(mine.data.pendingCents, 16000, 'inside the window: pending, not payable');
  db.prepare("UPDATE shipments SET delivered_at=datetime('now','-8 days'), return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(sh.id);

  // 4. Tuesday run → one settlement item of 160 with the PO reference.
  const run = await ctx.api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(run.status, 201, run.text);
  const item = run.data.items.find((i) => i.shopId === shopId);
  assert.equal(item.amountCents, 16000);
  assert.match(item.reference, /^Purchase of handmade goods — PO #\d+$/);

  // 5. Bank CSV: decrypted IBAN + 160.00 + the reference.
  const csv = await ctx.api('GET', `/api/admin/settlements/${run.data.settlementId}/export.csv`, { cookie: adminCookie });
  assert.match(csv.text, /AE070331234567890123456/);
  assert.match(csv.text, /160\.00/);

  // 6. Mark paid → payout ledger row + purchase note with the title-transfer sentence.
  await ctx.api('POST', `/api/admin/settlements/${run.data.settlementId}/paid`, { cookie: adminCookie });
  mine = await ctx.api('GET', '/api/seller/settlements', { cookie: sellerCookie });
  assert.equal(mine.data.payableCents, 0);
  assert.equal(mine.data.settledCents, 16000);
  const noteId = mine.data.history[0].purchaseNoteId;
  assert.ok(noteId);
  const note = await ctx.api('GET', `/api/seller/purchase-notes/${noteId}`, { cookie: sellerCookie });
  assert.match(note.text, /records Trove's purchase of the goods/);
  assert.match(note.text, /Title transferred[\s\S]{0,40}to Trove at order confirmation/);
  assert.match(note.text, /AED 160\.00/);
});

test('prohibited category: listing soap is refused with a clear 422', async () => {
  for (const category of ['soap', 'Food', 'Skincare', 'Beauty', 'Perfume oils']) {
    const res = await ctx.api('POST', '/api/seller/products', {
      cookie: sellerCookie,
      body: { name: 'Test Item', price: 30, category },
    });
    assert.equal(res.status, 422, `${category}: ${res.text}`);
    assert.match(res.data.error, /ingestible or applied to the skin/i);
  }
  // And a made-up category that isn't prohibited is still rejected by the allowlist.
  const other = await ctx.api('POST', '/api/seller/products', {
    cookie: sellerCookie,
    body: { name: 'Test Item', price: 30, category: 'Gadgets' },
  });
  assert.equal(other.status, 422);
  assert.match(other.data.error, /isn't one of Trove's categories/);
});
