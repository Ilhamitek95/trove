'use strict';
/**
 * Medium-findings round 2 Oct 2026, group F3 — the admin panel, settlement
 * admin, the activity log and the owner's tools.
 *
 *   F065  admin_actions keeps who did what, when, in which shop view, and
 *         what it was before; no secrets or contact details in it
 *   F106  the 'Next settlement run' card and Run settlement use one cut-off;
 *         a future runDate is refused
 *   F107  the shops payload names what stops a maker being paid
 *   F110  Sales / Orders and each shop's Sales are net of refunds
 *   F111  one 'Needs you' list gathers everything waiting on the owner
 *   F112  orders: search, filters, paging, a full detail view
 *   F145  a failed scheduled job is recorded and emails the owner once a day
 *   F185  Mark paid only after the bank file; cancel a draft; undo paid
 *         within 48 hours; makers get a payment email
 *   F187  the owner lands in /admin after signing in
 *   F199  the admin corrects a delivery address / mobile until packing
 *   F144  one money format on every dashboard
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, adminCookie, buyerId;
const sent = [];
let n = 0;

function mkShop(slug, extra = {}) {
  const { hashPassword } = require('../src/middleware');
  const pcrypto = require('../src/crypto');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?, 'seller')")
    .run(`${slug}@test.local`, hashPassword('testpass123'), `${slug} owner`).lastInsertRowid;
  const id = db.prepare(`INSERT INTO shops (user_id,name,slug,status,payout_bank_name,payout_account_name,iban_encrypted,iban_masked,
      agreement_version,agreement_accepted_at,license_verified_at,emirates_id_last4,pickup_address,pickup_phone)
    VALUES (?,?,?, 'approved','Emirates NBD',?,?,?, 'v5', datetime('now'), datetime('now'), '1234','Studio 1, Al Quoz','+971501234567')`)
    .run(uid, slug, slug, `${slug} owner`, pcrypto.encrypt('AE070331234567890123456'), 'AE07 ···· 3456').lastInsertRowid;
  if (Object.keys(extra).length) db.prepare(`UPDATE shops SET ${Object.keys(extra).map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(extra), id);
  return { id: Number(id), email: `${slug}@test.local` };
}

/** A paid order; `windowClosed` = the SQL time its return window closed (null = still delivering). */
function sale(shopId, price, { windowClosed = "datetime('now','-2 days')", credit = Math.round(price * 0.6), status = 'delivered', email = 'b@test.local', phone = '+971509998877', ship = { name: 'Sara Ahmed', line: 'Marina Gate 2, apt 1204', city: 'Dubai', emirate: 'Dubai' } } = {}) {
  const pub = `TRV-F3${String(++n).padStart(3, '0')}`;
  const oid = db.prepare(`INSERT INTO orders (public_id,email,phone,subtotal_cents,total_cents,status,rail,title_transferred_at,buyer_id,shipping_json)
    VALUES (?,?,?,?,?, 'paid', 'consignment', datetime('now','-20 days'), ?, ?)`).run(pub, email, phone, price, price, buyerId, JSON.stringify(ship)).lastInsertRowid;
  const item = db.prepare("INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty,options) VALUES (?,?, 'Sand Vase', ?, 1, ?)")
    .run(oid, shopId, price, JSON.stringify([{ name: 'Colour', value: 'Sand' }])).lastInsertRowid;
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', ?)").run(shopId, oid, credit);
  const sh = db.prepare(`INSERT INTO shipments (order_id,shop_id,status,delivered_at,return_window_ends_at,pack_by_at)
    VALUES (?,?,?, ${status === 'delivered' ? "datetime('now','-18 days')" : 'NULL'}, ${status === 'delivered' ? windowClosed : 'NULL'}, datetime('now','+1 day'))`)
    .run(oid, shopId, status).lastInsertRowid;
  return { orderId: Number(oid), publicId: pub, itemId: Number(item), shipmentId: Number(sh) };
}

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('admin@test.local',?, 'Admin','admin')").run(hashPassword('adminpass123'));
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?, 'Buyer','buyer')").run(hashPassword('testpass123')).lastInsertRowid;
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
});
after(async () => { await ctx.close(); });

const tick = () => new Promise((r) => setTimeout(r, 25));

/* ---------------- F106 ---------------- */

test('F106: a purchase cleared earlier today is on the card AND in the run', async () => {
  const s = mkShop('today-shop');
  // Return window closed one minute ago — 'earlier today' in any timezone.
  const o = sale(s.id, 20000, { windowClosed: "datetime('now','-1 minute')" });
  db.prepare("UPDATE orders SET return_window_ends_at=datetime('now','-1 minute') WHERE id=?").run(o.orderId);
  const pv = (await api('GET', '/api/admin/settlements/preview', { cookie: adminCookie })).data;
  assert.ok(pv.eligible.some((r) => r.shopId === s.id), 'the card shows it');
  assert.ok(pv.cutoffAt, 'the card says which cut-off it used');
  const run = await api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(run.status, 201, run.text);
  assert.ok(run.data.items.some((i) => i.shopId === s.id), 'and the run pays it');
  // tidy: cancel so later tests start clean
  assert.equal((await api('POST', `/api/admin/settlements/${run.data.settlementId}/cancel`, { cookie: adminCookie, body: {} })).status, 200);
});

test('F106/F185: a run dated in the future is refused', async () => {
  const r = await api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: { runDate: '2099-01-06' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /future/);
  assert.equal((await api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: { runDate: 'soon' } })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM settlements').get().c, 0);
});

/* ---------------- F185 ---------------- */

test('F185: Mark paid waits for the bank file; a draft can be cancelled; paid can be undone within 48 hours', async () => {
  const s = mkShop('pay-shop');
  sale(s.id, 30000, { credit: 18000 });
  const run = (await api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} })).data;
  const id = run.settlementId;

  const early = await api('POST', `/api/admin/settlements/${id}/paid`, { cookie: adminCookie });
  assert.equal(early.status, 409, 'not before the bank file was downloaded');
  assert.match(early.data.error, /Download the bank file/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seller_balances WHERE type='payout'").get().c, 0);

  // Cancel the draft: the money waits for the next run, nothing paid.
  const cx = await api('POST', `/api/admin/settlements/${id}/cancel`, { cookie: adminCookie, body: {} });
  assert.equal(cx.status, 200, cx.text);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM settlements WHERE id=?').get(id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seller_balances WHERE shop_id=? AND settlement_id IS NOT NULL").get(s.id).c, 0, 'un-stamped');

  // Run again → download → paid → the maker is emailed a payment note.
  const again = (await api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} })).data;
  assert.ok(again.items.some((i) => i.shopId === s.id), 'swept into the next run');
  await api('GET', `/api/admin/settlements/${again.settlementId}/export.csv`, { cookie: adminCookie });
  sent.length = 0;
  const paid = await api('POST', `/api/admin/settlements/${again.settlementId}/paid`, { cookie: adminCookie });
  assert.equal(paid.status, 200, paid.text);
  await tick();
  const mail = sent.find((m) => m.to === 'pay-shop@test.local');
  assert.ok(mail, 'the maker gets a payment note');
  assert.match(mail.subject, /payment is on its way — AED 180/);
  assert.ok(mail.html.includes('Purchase of handmade goods'), 'with the bank reference');
  assert.ok(!mail.html.includes('3456') && !mail.html.includes('AE07'), 'no bank number');
  const list = (await api('GET', '/api/admin/settlements', { cookie: adminCookie })).data.settlements;
  assert.equal(list.find((x) => x.id === again.settlementId).canUndoPaid, true);

  // A paid run can't be cancelled; it can be undone within 48 hours.
  assert.equal((await api('POST', `/api/admin/settlements/${again.settlementId}/cancel`, { cookie: adminCookie, body: {} })).status, 409);
  const undo = await api('POST', `/api/admin/settlements/${again.settlementId}/undo-paid`, { cookie: adminCookie, body: {} });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(undo.data.settlement.status, 'exported');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seller_balances WHERE settlement_id=? AND type='payout'").get(again.settlementId).c, 0, 'payout rows reversed');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM purchase_notes WHERE shop_id=?').get(s.id).c, 0, 'purchase note withdrawn');

  // Paid again, then more than 48 hours pass: final.
  assert.equal((await api('POST', `/api/admin/settlements/${again.settlementId}/paid`, { cookie: adminCookie })).status, 200);
  db.prepare("UPDATE settlements SET paid_at=datetime('now','-49 hours') WHERE id=?").run(again.settlementId);
  const late = await api('POST', `/api/admin/settlements/${again.settlementId}/undo-paid`, { cookie: adminCookie, body: {} });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /48 hours/);
});

test('F185: the admin page shows the three steps and only offers Mark paid once the file is downloaded', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-admin.html'), 'utf8');
  assert.match(html, /settleSteps\(/);
  assert.match(html, /st\.status==='exported'\?`<button class="btn btn-coral" onclick="markSettlementPaid/);
  assert.match(html, /cancelSettlement\(/);
  assert.match(html, /undoSettlementPaid\(/);
});

/* ---------------- F110 ---------------- */

test('F110: Sales, Orders and each shop’s Sales leave refunds out', async () => {
  const s = mkShop('refund-shop');
  const before = (await api('GET', '/api/admin/stats', { cookie: adminCookie })).data;
  const kept = sale(s.id, 50000);
  const whole = sale(s.id, 90000);
  db.prepare("UPDATE orders SET refunded_at=datetime('now') WHERE id=?").run(whole.orderId);
  // a partial return refunded: AED 100 back on the kept order
  const rr = db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,status,refund_cents) VALUES (?,?, 'changed-mind','refunded', 10000)").run(kept.orderId, buyerId).lastInsertRowid;
  db.prepare('INSERT INTO return_request_items (request_id,order_item_id,qty) VALUES (?,?,1)').run(rr, kept.itemId);
  const st = (await api('GET', '/api/admin/stats', { cookie: adminCookie })).data;
  assert.equal(st.orders - before.orders, 1, 'a fully refunded order is not counted');
  assert.equal(st.gmvCents - before.gmvCents, 50000 - 10000, 'net of the whole refund and the return');
  assert.equal(st.refundedCents - before.refundedCents, 90000 + 10000);
  const shops = (await api('GET', '/api/admin/shops', { cookie: adminCookie })).data.shops;
  assert.equal(shops.find((x) => x.id === s.id).salesCents, 0, 'refunded order out; the returned unit out');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-admin.html'), 'utf8');
  assert.doesNotMatch(html, /gross, incl\. fees/);
  assert.match(html, /after refunds · incl\. delivery/);
});

/* ---------------- F107 ---------------- */

test('F107: the shops payload names what stops a maker being paid', async () => {
  const ok = mkShop('ready-shop');
  const noBank = mkShop('nobank-shop', { iban_encrypted: null, license_verified_at: null });
  const shops = (await api('GET', '/api/admin/shops', { cookie: adminCookie })).data.shops;
  assert.deepEqual(shops.find((x) => x.id === ok.id).payoutMissing, []);
  assert.deepEqual(shops.find((x) => x.id === noBank.id).payoutMissing, ['bank details', 'identity check']);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-admin.html'), 'utf8');
  assert.doesNotMatch(html, /s\.payoutType/, 'the field the API never sent is gone');
  assert.match(html, /Payout not set up/);
});

/* ---------------- F111 + F145 ---------------- */

test('F111: one Needs-you list gathers what waits on the owner, from every tab', async () => {
  const s = mkShop('needs-shop');
  const o = sale(s.id, 12000);
  db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,status) VALUES (?,?, 'damaged','requested')").run(o.orderId, buyerId);
  const late = sale(s.id, 8000, { status: 'processing' });
  db.prepare("UPDATE shipments SET pack_by_at=datetime('now','-1 day') WHERE id=?").run(late.shipmentId);
  db.prepare("UPDATE orders SET attention='refund_failed' WHERE id=?").run(late.orderId);
  db.prepare("INSERT INTO contact_messages (name,email,topic,message) VALUES ('Ali','ali@test.local','order','Where is my vase?')").run();
  require('../src/job-runs').fail('backup', new Error('disk full'));

  const r = await api('GET', '/api/admin/needs-you', { cookie: adminCookie });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.items.map((i) => [i.key, i]));
  assert.equal(by.returns.count, 1);
  assert.equal(by.returns.view, 'returns');
  assert.equal(by.packs_overdue.count, 1);
  assert.equal(by.packs_overdue.filter, 'overdue');
  assert.equal(by.refunds_by_hand.count, 1);
  assert.equal(by.refunds_by_hand.urgent, true);
  assert.equal(by.messages.count, 1);
  assert.ok(by.jobs && /backup/i.test(by.jobs.label));
  assert.ok(r.data.items.findIndex((i) => !i.urgent) === -1 || r.data.items.findIndex((i) => i.urgent) < r.data.items.findIndex((i) => !i.urgent), 'urgent first');
  assert.equal(r.data.orders.attention >= 1, true, 'the Orders badge count');
  assert.equal(r.data.jobs.find((j) => j.job === 'backup').failing, true);
  assert.equal((await api('GET', '/api/admin/needs-you', { cookie: await ctx.loginAs('needs-shop@test.local', 'testpass123') })).status, 403);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-admin.html'), 'utf8');
  assert.match(html, /id="needsList"/);
  assert.match(html, /\/api\/admin\/needs-you/);
  assert.match(html, /id="ordBadge"/);
});

test('F145: a failing job emails the owner once a day, and a later success clears it', async () => {
  const jobs = require('../src/job-runs');
  sent.length = 0;
  assert.equal(jobs.fail('settlement', new Error('PAYOUT_ENC_KEY missing')), true);
  assert.equal(jobs.fail('settlement', new Error('again')), false, 'no second email the same day');
  await tick();
  const alerts = sent.filter((m) => /Fortnightly settlement run failed/.test(m.subject));
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].html.includes('PAYOUT_ENC_KEY missing'));
  assert.equal(jobs.status().find((j) => j.job === 'settlement').failing, true);
  jobs.ok('settlement', 'nothing payable');
  assert.equal(jobs.status().find((j) => j.job === 'settlement').failing, false);
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  for (const job of ['settlement', 'backup', 'oto-webhooks', 'order-sweep', 'pack-by']) {
    assert.match(server, new RegExp(`jobs\\.fail\\('${job}'`), `${job} failures reach the owner`);
  }
  assert.match(server, /process\.on\('unhandledRejection'/);
});

/* ---------------- F112 ---------------- */

test('F112: orders can be searched, filtered, paged and opened in full', async () => {
  const s = mkShop('orders-shop');
  const a = sale(s.id, 15000, { email: 'findme@test.local', phone: '+971501112233', ship: { name: 'Huda Karim', line: 'Villa 7', city: 'Abu Dhabi', emirate: 'Abu Dhabi' } });
  const q = async (qs) => (await api('GET', `/api/admin/orders?${qs}`, { cookie: adminCookie })).data;
  assert.deepEqual((await q('q=findme')).orders.map((o) => o.publicId), [a.publicId], 'by email');
  assert.deepEqual((await q('q=1112233')).orders.map((o) => o.publicId), [a.publicId], 'by mobile');
  assert.deepEqual((await q('q=Huda')).orders.map((o) => o.publicId), [a.publicId], 'by delivery name');
  assert.deepEqual((await q(`q=${a.publicId}`)).orders.map((o) => o.publicId), [a.publicId], 'by order number');
  assert.equal((await q('q=100%25')).orders.length, 0, 'LIKE wildcards are literal');

  const all = await q('limit=2');
  assert.equal(all.orders.length, 2);
  assert.ok(all.next, 'there is a next page');
  const page2 = await q(`limit=2&before=${all.next}`);
  assert.ok(page2.orders.every((o) => !all.orders.some((x) => x.publicId === o.publicId)), 'no overlap');
  assert.ok(all.counts.all >= 3);
  assert.ok((await q('filter=overdue')).orders.every((o) => o.parcels.some((p) => p.packOverdue)));

  const d = await api('GET', `/api/admin/orders/${a.publicId}`, { cookie: adminCookie });
  assert.equal(d.status, 200);
  assert.equal(d.data.order.lines[0].name, 'Sand Vase');
  assert.deepEqual(d.data.order.lines[0].options, [{ name: 'Colour', value: 'Sand' }]);
  assert.equal(d.data.order.ship.line, 'Villa 7');
  assert.equal(d.data.order.phone, '+971501112233');
  assert.equal(d.data.order.parcels[0].shop, 'orders-shop');
  assert.equal((await api('GET', '/api/admin/orders/TRV-NOPE', { cookie: adminCookie })).status, 404);
});

/* ---------------- F199 ---------------- */

test('F199: the admin corrects the delivery details until a parcel is packed', async () => {
  const s = mkShop('fix-shop');
  const o = sale(s.id, 25000, { status: 'processing' });
  const patch = (body) => api('PATCH', `/api/admin/orders/${o.publicId}/delivery`, { cookie: adminCookie, body });
  assert.equal((await patch({ address: { emirate: 'Sharjah', city: 'Sharjah' } })).status, 400, 'still Dubai + Abu Dhabi only');
  assert.equal((await patch({ phone: '12345' })).status, 400, 'a UAE mobile');
  assert.equal((await patch({ address: { line: '<script>' } })).status, 400, 'no markup');
  const ok = await patch({ address: { line: 'Marina Gate 2, apt 2104' }, phone: '0501234999' });
  assert.equal(ok.status, 200, ok.text);
  const row = db.prepare('SELECT shipping_json, phone, delivery_edited_at FROM orders WHERE id=?').get(o.orderId);
  assert.equal(JSON.parse(row.shipping_json).line, 'Marina Gate 2, apt 2104');
  assert.equal(JSON.parse(row.shipping_json).name, 'Sara Ahmed', 'the rest is kept');
  assert.ok(!('phone' in JSON.parse(row.shipping_json)), 'the mobile never goes into the address shops see');
  assert.equal(row.phone, '+971501234999');
  assert.ok(row.delivery_edited_at);
  // Packed → too late here.
  db.prepare("UPDATE shipments SET ready_at=datetime('now') WHERE id=?").run(o.shipmentId);
  const late = await patch({ address: { line: 'Somewhere else' } });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /packed/);
  // Not for makers.
  assert.equal((await api('PATCH', `/api/admin/orders/${o.publicId}/delivery`, { cookie: await ctx.loginAs('fix-shop@test.local', 'testpass123'), body: { address: { line: 'x' } } })).status, 403);
});

/* ---------------- F065 ---------------- */

test('F065: Admin → Activity records admin changes with what they were before, and shop-view edits', async () => {
  const s = mkShop('audit-shop');
  db.prepare("UPDATE shops SET status='pending' WHERE id=?").run(s.id);
  const r = await api('PATCH', `/api/admin/shops/${s.id}`, { cookie: adminCookie, body: { status: 'approved' } });
  assert.equal(r.status, 200, r.text);
  // A refused change is not recorded.
  await api('PATCH', `/api/admin/shops/${s.id}`, { cookie: adminCookie, body: { status: 'nonsense' } });

  // Shop view: mark a parcel shipped as the maker.
  const o = sale(s.id, 9000, { status: 'processing' });
  const sv = await api('POST', `/api/admin/impersonate/${s.id}`, { cookie: adminCookie });
  const svCookie = (sv.headers.get('set-cookie') || '').split(';')[0];
  const up = await api('PATCH', `/api/seller/shipments/${o.shipmentId}`, { cookie: svCookie, body: { status: 'delivered' } });
  assert.equal(up.status, 200, up.text);
  const back = await api('POST', '/api/auth/stop-impersonating', { cookie: svCookie });
  adminCookie = (back.headers.get('set-cookie') || '').split(';')[0] || adminCookie;

  // A body carrying an email or a bank number: never kept in the log.
  assert.equal((await api('PATCH', `/api/admin/shops/${s.id}`, { cookie: adminCookie, body: { status: 'approved', email: 'someone@test.local', iban: 'AE07 0331' } })).status, 200);

  const log = (await api('GET', '/api/admin/activity', { cookie: adminCookie })).data.actions;
  const approved = log.find((a) => a.action === 'Shop status changed' && a.target === `shops ${s.id}` && a.before && a.before.status === 'pending');
  assert.ok(approved, JSON.stringify(log.slice(0, 5)));
  assert.equal(approved.before.status, 'pending');
  assert.equal(approved.after.status, 'approved');
  assert.equal(approved.admin, 'admin@test.local');
  assert.ok(!log.some((a) => a.after && a.after.status === 'nonsense'), 'refused changes are not logged');
  const parcel = log.find((a) => a.action === 'Parcel updated in shop view');
  assert.ok(parcel, 'the shop-view change is on record');
  assert.equal(parcel.shopView, 'audit-shop');
  assert.equal(parcel.admin, 'admin@test.local');
  assert.equal(parcel.before.status, 'processing');
  assert.equal(parcel.after.status, 'delivered');
  assert.ok(log.some((a) => a.action === 'Shop view opened') && log.some((a) => a.action === 'Shop view closed'));
  const raw = JSON.stringify(db.prepare('SELECT * FROM admin_actions').all());
  assert.ok(!raw.includes('someone@test.local') && !raw.includes('AE07'), 'no emails or bank numbers in the log');
  assert.equal((await api('GET', '/api/admin/activity', { cookie: await ctx.loginAs('audit-shop@test.local', 'testpass123') })).status, 403);
});

/* ---------------- F187 + F144 ---------------- */

test('F187: an admin always lands on /admin after signing in', () => {
  const login = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-login.html'), 'utf8');
  assert.match(login, /if\(me&&me\.user&&me\.user\.role==='admin'\) dest='\/admin';/);
  assert.doesNotMatch(login, /role==='admin'&&!me\.shop/);
});

test('F144: one money format — no rounding to whole dirhams, no browser-locale digits', () => {
  const docs = path.join(__dirname, '..', '..', 'docs');
  for (const f of ['trove-account.html', 'trove-seller.html', 'trove-admin.html', 'trove.html']) {
    const src = fs.readFileSync(path.join(docs, f), 'utf8');
    assert.doesNotMatch(src, /Math\.round\(n\)/, `${f} rounds money to whole dirhams`);
    assert.doesNotMatch(src, /'AED '\+n\.toLocaleString\(/, `${f} formats money itself`);
    assert.match(src, /function aed\(n\)\{return troveMoney\(n\);\}/, `${f} uses the shared formatter`);
  }
  // The shared formatter (docs/api.js troveMoney): en-GB digits, 0 or 2 decimals.
  const api = fs.readFileSync(path.join(docs, 'api.js'), 'utf8');
  const body = api.match(/window\.troveMoney = function \(n, opts\) \{([\s\S]*?)\n  \};/)[1];
  const window = { troveIso: (s) => s };
  const fmt = new Function('window', `return function (n, opts) {${body}\n};`)(window);
  assert.equal(fmt(45.5), 'AED 45.50');
  assert.equal(fmt(1200), 'AED 1,200');
  assert.equal(fmt(29.4), 'AED 29.40');
  assert.equal(fmt(1234567), 'AED 1,234,567');
});
