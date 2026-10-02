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
  // Consignment order: VAT = 5/105 × 23000 = 1095.
  const o1 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-VAT01','b@test.local',20000,3000,0,23000,'pending','consignment','pi_vat_1')`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)').run(o1, productId, shopId, 'Vase');
  await ctx.postWebhook({ id: 'evt_vat_a', type: 'payment_intent.succeeded', data: { object: { id: 'pi_vat_1', metadata: { order_id: String(o1) } } } });

  // Connect-rail order: VAT = 5/105 × margin (8000) = 381.
  const o2 = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES ('TRV-VAT02','b@test.local',20000,3000,0,23000,'pending','connect','pi_vat_2')`).run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)').run(o2, productId, shopId, 'Vase');
  await ctx.postWebhook({ id: 'evt_vat_b', type: 'payment_intent.succeeded', data: { object: { id: 'pi_vat_2', metadata: { order_id: String(o2) } } } });

  assert.equal(db.prepare('SELECT vat_amount_cents FROM orders WHERE id=?').get(o1).vat_amount_cents, 1095);
  assert.equal(db.prepare('SELECT vat_amount_cents FROM orders WHERE id=?').get(o2).vat_amount_cents, 381);

  const rep = await ctx.api('GET', '/api/admin/vat-report', { cookie: adminCookie });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.vatRegistered, true);
  const consign = rep.data.rows.find((r) => r.rail === 'consignment');
  const connect = rep.data.rows.find((r) => r.rail === 'connect');
  assert.equal(consign.vatCents, 1095);
  assert.equal(connect.vatCents, 381);
  assert.match(consign.quarter, /^\d{4}-Q[1-4]$/);
});

/* Review round 2026-10-02: quarters on the Dubai calendar (F255), refunds
 * and credit notes shown and netted in the quarter the note was issued
 * (F323), and a CSV for the accountant. */
function paidOrder(pub, utcPaidAt, total = 10500) {
  return db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,rail,title_transferred_at,vat_amount_cents)
    VALUES (?, 'b@test.local', ?, ?, 'paid', 'consignment', ?, ?)`).run(pub, total, total, utcPaidAt, Math.round(total * 5 / 105)).lastInsertRowid;
}

test('a sale at 01:30 on 1 January in Dubai is reported in Q1, not the previous Q4', async () => {
  paidOrder('TRV-VATNY', '2025-12-31 21:30:00'); // = 01:30 on 1 Jan 2026, Dubai
  paidOrder('TRV-VATQ4', '2025-12-31 19:59:00'); // = 23:59 on 31 Dec 2025, Dubai
  const rep = await ctx.api('GET', '/api/admin/vat-report', { cookie: adminCookie });
  const q1 = rep.data.rows.find((r) => r.quarter === '2026-Q1' && r.rail === 'consignment');
  const q4 = rep.data.rows.find((r) => r.quarter === '2025-Q4' && r.rail === 'consignment');
  assert.equal(q1.orders, 1);
  assert.equal(q1.vatCents, 500);
  assert.equal(q4.orders, 1);
});

test('credit notes are listed and reduce the quarter they were issued in; net VAT due shown', async () => {
  const oid = paidOrder('TRV-VATCN', '2026-02-10 08:00:00', 21000); // VAT 1000, Q1
  db.prepare(`UPDATE orders SET refunded_at='2026-03-31 21:00:00', vat_reversed_cents=1000, credit_note_ref='CN-TRV-VATCN' WHERE id=?`).run(oid);
  // 01:00 on 1 April in Dubai → the note belongs to Q2
  const rep = await ctx.api('GET', '/api/admin/vat-report', { cookie: adminCookie });
  const note = rep.data.creditNotes.find((n) => n.reference === 'CN-TRV-VATCN');
  assert.deepEqual({ q: note.quarter, rail: note.rail, vat: note.vatCents, order: note.order }, { q: '2026-Q2', rail: 'consignment', vat: 1000, order: 'TRV-VATCN' });
  const q1 = rep.data.rows.find((r) => r.quarter === '2026-Q1' && r.rail === 'consignment');
  assert.equal(q1.vatCents, 1500, 'output VAT in the sale quarter');
  assert.equal(q1.reversedCents, 0);
  const q2 = rep.data.rows.find((r) => r.quarter === '2026-Q2' && r.rail === 'consignment');
  assert.equal(q2.reversedCents, 1000, 'the credit note reduces Q2');
  assert.equal(q2.netVatCents, q2.vatCents - 1000);

  const csv = await ctx.api('GET', '/api/admin/vat-report.csv', { cookie: adminCookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines[0], 'section,quarter,rail,reference,document,count,gross_aed,vat_aed,reversed_vat_aed,net_vat_aed,date');
  assert.ok(lines.includes('"credit_note","2026-Q2","consignment","CN-TRV-VATCN","TRV-VATCN",,210.00,,10.00,,"2026-04-01"'));
  assert.ok(lines.some((l) => l.startsWith('"quarter","2026-Q1","consignment"')));
  const maker = await ctx.loginAs('maker@test.local', 'testpass123');
  assert.equal((await ctx.api('GET', '/api/admin/vat-report.csv', { cookie: maker })).status, 403);
});

test('the admin VAT table shows reversed VAT, net VAT due and the credit notes', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'docs', 'trove-admin.html'), 'utf8');
  assert.match(html, /Reversed/);
  assert.match(html, /Net VAT due/);
  assert.match(html, /credit notes/i);
  assert.match(html, /vat-report\.csv/);
});
