'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const fs = require('fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, sellerCookie;
let shopId, productId, orderId;

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

  // Paid order via the webhook (writes the 16000 credit + shipment).
  orderId = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-SET01','buyer@test.local',20000,2500,900,23400,'pending','consignment','pi_set_1')`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)')
    .run(orderId, productId, shopId, 'Vase');
  await ctx.postWebhook({ id: 'evt_set_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_set_1', metadata: { order_id: String(orderId) } } } });

  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('inside the return window the credit is pending, not payable', async () => {
  const sh = db.prepare('SELECT * FROM shipments WHERE order_id=?').get(orderId);
  await ctx.api('POST', '/api/delivery/mock/deliver', { body: { shipmentId: sh.id } }); // delivered NOW → window open 7 days

  const mine = await ctx.api('GET', '/api/seller/settlements', { cookie: sellerCookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.pendingCents, 16000);
  assert.equal(mine.data.payableCents, 0);

  const preview = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  assert.equal(preview.data.eligible.length, 0);
});

test('window closed → run drafts a settlement with the right item + reference', async () => {
  db.prepare("UPDATE shipments SET delivered_at=datetime('now','-8 days'), return_window_ends_at=datetime('now','-1 day') WHERE order_id=?").run(orderId);

  const preview = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  assert.equal(preview.data.eligible.length, 1);
  assert.equal(preview.data.eligible[0].netCents, 16000);

  const run = await ctx.api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(run.status, 201, run.text);
  assert.equal(run.data.items.length, 1);
  assert.equal(run.data.totalCents, 16000);
  assert.match(run.data.items[0].reference, /^Purchase of handmade goods — PO #\d+$/);

  // Credit is swept; a second run has nothing.
  const again = await ctx.api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(again.data.created, false);
});

test('CSV export decrypts the IBAN (only here) and flips status to exported', async () => {
  const st = db.prepare('SELECT * FROM settlements ORDER BY id DESC').get();
  const csv = await ctx.api('GET', `/api/admin/settlements/${st.id}/export.csv`, { cookie: adminCookie });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /AE070331234567890123456/); // decrypted, full IBAN
  assert.match(csv.text, /160\.00/);
  assert.match(csv.text, /Purchase of handmade goods/);
  assert.equal(db.prepare('SELECT status FROM settlements WHERE id=?').get(st.id).status, 'exported');
  // The database never holds the plaintext IBAN.
  assert.equal(db.prepare('SELECT payout_iban FROM shops WHERE id=?').get(shopId).payout_iban, '');
});

test('mark paid: payout ledger row, purchase note file with the required sentence', async () => {
  const st = db.prepare('SELECT * FROM settlements ORDER BY id DESC').get();
  const paid = await ctx.api('POST', `/api/admin/settlements/${st.id}/paid`, { cookie: adminCookie });
  assert.equal(paid.status, 200, paid.text);

  const payout = db.prepare("SELECT * FROM seller_balances WHERE type='payout' AND shop_id=?").get(shopId);
  assert.equal(payout.amount_cents, -16000);
  assert.equal(payout.settlement_id, st.id);

  const note = db.prepare('SELECT * FROM purchase_notes WHERE shop_id=?').get(shopId);
  assert.ok(note, 'purchase note row exists');
  assert.ok(fs.existsSync(note.html_path), 'purchase note file exists');
  const html = fs.readFileSync(note.html_path, 'utf8');
  assert.match(html, /records Trove's purchase of the goods/);
  assert.match(html, /Title transferred\nto Trove at order confirmation|Title transferred[\s\S]{0,40}to Trove at order confirmation/);
  assert.match(html, /AED 160\.00/);

  // Supplier balance settles to zero; history + note visible to the seller.
  const mine = await ctx.api('GET', '/api/seller/settlements', { cookie: sellerCookie });
  assert.equal(mine.data.payableCents, 0);
  assert.equal(mine.data.settledCents, 16000);
  assert.equal(mine.data.history.length, 1);
  assert.equal(mine.data.history[0].status, 'paid');
  assert.ok(mine.data.history[0].purchaseNoteId);
  const dl = await ctx.api('GET', `/api/seller/purchase-notes/${mine.data.history[0].purchaseNoteId}`, { cookie: sellerCookie });
  assert.equal(dl.status, 200);
  assert.match(dl.text, /self-billed purchase note/);
});

test('a supplier without payout setup is excluded with a reason', async () => {
  const { hashPassword } = require('../src/middleware');
  const uid2 = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('bare@test.local',?, 'Bare','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  const shop2 = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(uid2, 'Bare Shop', 'bare-shop').lastInsertRowid;
  const oid2 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,rail,title_transferred_at)
    VALUES ('TRV-SET02','b@test.local',10000,13400,'paid','consignment',datetime('now','-10 days'))`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,10000,1)').run(oid2, shop2, 'Bowl');
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', 8000)").run(shop2, oid2);
  db.prepare(`INSERT INTO shipments (order_id,shop_id,status,delivered_at,return_window_ends_at)
    VALUES (?,?, 'delivered', datetime('now','-9 days'), datetime('now','-2 days'))`).run(oid2, shop2);

  const preview = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  const held = preview.data.excluded.find((x) => x.shopId === shop2);
  assert.ok(held, 'bare shop is excluded');
  assert.equal(held.reason, 'payout_setup_incomplete');
  assert.equal(held.netCents, 8000);
});

test('refund debits net against credits; negative carries forward unswept', async () => {
  // Give the main shop a fresh eligible credit of 16000 and a debit of −20000.
  const oid3 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,rail,title_transferred_at)
    VALUES ('TRV-SET03','b@test.local',20000,23400,'paid','consignment',datetime('now','-10 days'))`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,20000,1)').run(oid3, shopId, 'Vase');
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', 16000)").run(shopId, oid3);
  db.prepare(`INSERT INTO shipments (order_id,shop_id,status,delivered_at,return_window_ends_at)
    VALUES (?,?, 'delivered', datetime('now','-9 days'), datetime('now','-2 days'))`).run(oid3, shopId);
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'debit_refund', -20000)").run(shopId, orderId);

  // −20000 + 16000 = −4000 → netted negative, held back, rows stay unswept.
  let preview = await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie });
  let held = preview.data.excluded.find((x) => x.shopId === shopId);
  assert.ok(held);
  assert.equal(held.reason, 'netted_negative');
  assert.equal(held.netCents, -4000);
  const run = await ctx.api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(run.data.created, false);

  // Another 16000 credit arrives → 32000 − 20000 = 12000 payable.
  const oid4 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,rail,title_transferred_at)
    VALUES ('TRV-SET04','b@test.local',20000,23400,'paid','consignment',datetime('now','-10 days'))`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,20000,1)').run(oid4, shopId, 'Vase');
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', 16000)").run(shopId, oid4);
  db.prepare(`INSERT INTO shipments (order_id,shop_id,status,delivered_at,return_window_ends_at)
    VALUES (?,?, 'delivered', datetime('now','-9 days'), datetime('now','-2 days'))`).run(oid4, shopId);

  const run2 = await ctx.api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(run2.status, 201);
  const item = run2.data.items.find((i) => i.shopId === shopId);
  assert.equal(item.amountCents, 12000);
  // The debit is now swept and cannot double-count next run.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seller_balances WHERE shop_id=? AND settlement_id IS NULL AND type IN ('credit_sale','debit_refund')").get(shopId).n, 0);
});
