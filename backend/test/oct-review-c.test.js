'use strict';
/**
 * October 2026 review, group C — seller onboarding, seller API, admin
 * approvals and sign-in:
 *   F037  admin second sign-in step (emailed code), trusted browser, 12-hour admin sessions, recovery switch
 *   F063  shop view cannot accept agreements, give bank/ID details or write reviews for the maker
 *   F006  a typed licence never skips identity; settlement pays only verified makers; account-name mismatch flagged
 *   F435  Emirates ID details shown to the admin, expiry flagged, maker reminded once per state
 *   F017  approval waits for the Seller Agreement and the courier pickup details
 *   F013  a sold piece can't be deleted, and its photos survive the refusal
 *   F058  an admin-hidden review stays hidden when its author edits it
 *   F061  per-shop piece cap and AI tag budget
 *   F062  compare-at price must be above the price
 *   F014, F029, F295, F320, F406  dashboard / page wiring (static checks)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { testEnv, startApp } = require('./helpers');

testEnv({ PENDING_SHOP_MAX_PIECES: '3', AI_TAGS_PER_SHOP_HOUR: '2', RATE_LIMIT_DISABLED: '1', PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DOCS = path.join(__dirname, '..', '..', 'docs');
const readDoc = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');

let ctx, db, twofa, adminCookie, makerCookie, buyerCookie, shopId, adminId, makerId, buyerId;
const cookieOf = (r, fallback) => ((r.headers.get('set-cookie') || '').match(/trove\.sid=[^;]+|connect\.sid=[^;]+/) || [fallback])[0];

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  twofa = require('../src/admin-2fa');
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  adminId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@test.local',?,'Owner Admin','admin')").run(pw).lastInsertRowid;
  makerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?,'Mara Haddad','seller')").run(pw).lastInsertRowid;
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?,'Layla Hassan','buyer')").run(pw).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,pitch_phone) VALUES (?,?,?,'pending','+971 50 222 3344')").run(makerId, 'Kiln House', 'kiln-house').lastInsertRowid;
  adminCookie = await ctx.loginAs('owner@test.local', 'testpass123');
  makerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('buyer@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

/* ---------------- F037: the admin's second sign-in step ---------------- */

test('F037: an admin password alone signs nobody in — the code does', async () => {
  const first = await ctx.api('POST', '/api/auth/login', { body: { email: 'owner@test.local', password: 'testpass123' } });
  assert.equal(first.status, 200);
  assert.equal(first.data.needsCode, true);
  assert.equal(first.data.user, undefined, 'no user before the code');
  assert.match(first.data.sentTo, /^o•+@test\.local$/);
  const pending = cookieOf(first);
  assert.equal((await ctx.api('GET', '/api/auth/me', { cookie: pending })).status, 401, 'nothing is signed in yet');
  assert.equal((await ctx.api('GET', '/api/admin/stats', { cookie: pending })).status, 401);

  const wrong = await ctx.api('POST', '/api/auth/admin-code', { cookie: pending, body: { code: '000000' === twofa._lastCode() ? '111111' : '000000' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, 'wrong_code');

  const ok = await ctx.api('POST', '/api/auth/admin-code', { cookie: pending, body: { code: twofa._lastCode() } });
  assert.equal(ok.status, 200, ok.text);
  const signedIn = cookieOf(ok);
  assert.equal((await ctx.api('GET', '/api/admin/stats', { cookie: signedIn })).status, 200);
  // The admin session cookie lasts 12 hours, not 14 days.
  const exp = /Expires=([^;]+)/i.exec(ok.headers.get('set-cookie'))[1];
  const ms = Date.parse(exp) - Date.now();
  assert.ok(ms <= 12 * 3600e3 + 60e3 && ms > 11 * 3600e3, `admin cookie lasts ~12h (got ${Math.round(ms / 3600e3)}h)`);
  assert.equal(ok.headers.get('set-cookie').includes(twofa.DEVICE_COOKIE), false, 'not trusted unless asked');
});

test('F037: five wrong codes end the attempt', async () => {
  const first = await ctx.api('POST', '/api/auth/login', { body: { email: 'owner@test.local', password: 'testpass123' } });
  const pending = cookieOf(first);
  const right = twofa._lastCode();
  const bad = right === '123456' ? '654321' : '123456';
  let last;
  for (let i = 0; i < 5; i++) last = await ctx.api('POST', '/api/auth/admin-code', { cookie: pending, body: { code: bad } });
  assert.equal(last.data.code, 'no_challenge');
  const late = await ctx.api('POST', '/api/auth/admin-code', { cookie: pending, body: { code: right } });
  assert.equal(late.status, 400, 'the right code no longer works after five misses');
});

test('F037: Google sign-in and a password reset do not skip the code', async () => {
  const google = require('../src/google-auth');
  const orig = { enabled: google.enabled, verify: google.verifyIdToken };
  google.enabled = () => true;
  google.verifyIdToken = async () => ({ email: 'owner@test.local', name: 'Owner Admin' });
  try {
    const g = await ctx.api('POST', '/api/auth/google', { body: { credential: 'x' } });
    assert.equal(g.status, 200);
    assert.equal(g.data.needsCode, true);
    assert.equal((await ctx.api('GET', '/api/auth/me', { cookie: cookieOf(g) })).status, 401);
  } finally { google.enabled = orig.enabled; google.verifyIdToken = orig.verify; }

  const token = require('../src/accounts').issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(adminId), 'reset');
  const r = await ctx.api('POST', '/api/auth/reset', { body: { token, password: 'testpass123' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.needsCode, true, 'the reset link proves the inbox only');
  // the reset signed every other session out — sign the admin back in for the tests below
  adminCookie = await ctx.loginAs('owner@test.local', 'testpass123');
});

test('F037: a trusted browser skips the code for 30 days; a password change forgets it', async () => {
  const first = await ctx.api('POST', '/api/auth/login', { body: { email: 'owner@test.local', password: 'testpass123' } });
  const ok = await ctx.api('POST', '/api/auth/admin-code', { cookie: cookieOf(first), body: { code: twofa._lastCode(), trust: true } });
  const device = (ok.headers.get('set-cookie').match(new RegExp(`${twofa.DEVICE_COOKIE}=[^;]+`)) || [])[0];
  assert.ok(device, 'trust cookie set');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/i);
  const row = db.prepare('SELECT * FROM admin_devices WHERE user_id=?').get(adminId);
  assert.ok(row && !row.token_hash.includes(device.split('=')[1]), 'only a hash is stored');

  const again = await ctx.api('POST', '/api/auth/login', { body: { email: 'owner@test.local', password: 'testpass123' }, headers: { cookie: device } });
  assert.equal(again.data.needsCode, undefined, 'no code on a trusted browser');
  assert.equal(again.data.user.role, 'admin');
  const cookie = cookieOf(again);
  assert.equal((await ctx.api('GET', '/api/admin/stats', { cookie })).status, 200);

  const changed = await ctx.api('POST', '/api/auth/password', { cookie, body: { current: 'testpass123', password: 'testpass123' } });
  assert.equal(changed.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM admin_devices WHERE user_id=?').get(adminId).c, 0, 'trusted browsers forgotten');
  const after = await ctx.api('POST', '/api/auth/login', { body: { email: 'owner@test.local', password: 'testpass123' }, headers: { cookie: device } });
  assert.equal(after.data.needsCode, true);
  adminCookie = await ctx.loginAs('owner@test.local', 'testpass123');
});

test('F037: an admin session older than 12 hours, or one that never did the code, is signed out', async () => {
  const cookie = await ctx.loginAs('owner@test.local', 'testpass123');
  const sid = decodeURIComponent(cookie.split('=')[1]).replace(/^s:/, '').split('.')[0];
  const row = db.prepare('SELECT sess FROM sessions WHERE sid=?').get(sid);
  const sess = JSON.parse(row.sess);
  sess.adminVerifiedAt = Date.now() - 13 * 3600e3;
  db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(sess), sid);
  assert.equal((await ctx.api('GET', '/api/admin/stats', { cookie })).status, 401, 'too old');

  const legacy = await ctx.loginAs('owner@test.local', 'testpass123');
  const sid2 = decodeURIComponent(legacy.split('=')[1]).replace(/^s:/, '').split('.')[0];
  const s2 = JSON.parse(db.prepare('SELECT sess FROM sessions WHERE sid=?').get(sid2).sess);
  delete s2.adminVerifiedFor; delete s2.adminVerifiedAt;
  db.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s2), sid2);
  assert.equal((await ctx.api('GET', '/api/admin/stats', { cookie: legacy })).status, 401, 'a session from before the second step');
  const s = await ctx.api('GET', '/api/auth/session', { cookie: legacy });
  assert.equal(s.data.user, null, 'and the public session check agrees');
});

test('F037: the seller application form cannot sign the admin in with a password', async () => {
  const r = await ctx.api('POST', '/api/auth/register', { body: {
    email: 'owner@test.local', password: 'testpass123', name: 'Owner Admin', role: 'seller', shopName: 'Sneaky',
    instagram: '@x', phone: '+971501112233', location: 'Dubai, UAE' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'sign_in_required');
});

test('F037: recovery — ADMIN_2FA=off lets the password alone sign the admin in', async () => {
  process.env.ADMIN_2FA = 'off';
  try {
    const r = await ctx.api('POST', '/api/auth/login', { body: { email: 'owner@test.local', password: 'testpass123' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.role, 'admin');
    assert.equal((await ctx.api('GET', '/api/admin/stats', { cookie: cookieOf(r) })).status, 200);
  } finally { delete process.env.ADMIN_2FA; }
});

/* ---------------- F063: shop view is not the maker ---------------- */

test('F063: in shop view the maker-only steps are refused; the admin stays signed in after', async () => {
  const imp = await ctx.api('POST', `/api/admin/impersonate/${shopId}`, { cookie: adminCookie });
  assert.equal(imp.status, 200);
  const view = cookieOf(imp, adminCookie);
  assert.equal((await ctx.api('GET', '/api/seller/me', { cookie: view })).status, 200, 'looking is fine');
  for (const [method, url, body] of [
    ['POST', '/api/seller/agreement', { accept: true }],
    ['POST', '/api/seller/payout-setup', { emiratesIdLast4: '1234', emiratesIdExpiry: '2030-01-01', iban: 'AE070331234567890123456', accountName: 'Someone Else', bankName: 'X', acceptAgreement: true }],
    ['POST', '/api/seller/me/license', { licenseNumber: 'CN-0001' }],
    ['POST', '/api/seller/enable-services', { categories: ['workshops'], agreeSub: true, agreeTerms: true }],
    ['POST', '/api/account/reviews', { shopId, rating: 5 }],
  ]) {
    const r = await ctx.api(method, url, { cookie: view, body });
    assert.equal(r.status, 403, `${url} must be refused in shop view (got ${r.status})`);
    assert.equal(r.data.code, 'shop_view');
  }
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(shopId);
  assert.equal(shop.agreement_accepted_at, null, 'no acceptance recorded in the maker’s name');
  assert.equal(shop.payout_account_name || '', '');

  const back = await ctx.api('POST', '/api/auth/stop-impersonating', { cookie: view });
  assert.equal(back.status, 200);
  adminCookie = cookieOf(back, view);
  assert.equal((await ctx.api('GET', '/api/admin/stats', { cookie: adminCookie })).status, 200, 'back to admin without a new code');
});

/* ---------------- F017 / F029: approval waits for agreement + pickup ---------------- */

test('F017: approval is refused until the maker accepted the agreement and gave pickup details', async () => {
  let shops = (await ctx.api('GET', '/api/admin/shops', { cookie: adminCookie })).data.shops;
  assert.deepEqual(shops.find((s) => s.id === shopId).approvalMissing, ['agreement', 'pickup']);
  const me = (await ctx.api('GET', '/api/seller/me', { cookie: makerCookie })).data.shop;
  assert.equal(me.agreementAccepted, false);
  assert.equal(me.pickupReady, false, 'the dashboard asks for pickup details');

  const r1 = await ctx.api('PATCH', `/api/admin/shops/${shopId}`, { cookie: adminCookie, body: { status: 'approved' } });
  assert.equal(r1.status, 409);
  assert.equal(r1.data.code, 'not_ready');
  assert.match(r1.data.error, /Seller Agreement/);

  assert.equal((await ctx.api('POST', '/api/seller/agreement', { cookie: makerCookie, body: { accept: true } })).status, 200);
  const r2 = await ctx.api('PATCH', `/api/admin/shops/${shopId}`, { cookie: adminCookie, body: { status: 'approved' } });
  assert.equal(r2.status, 409);
  assert.deepEqual(r2.data.missing, ['pickup']);

  const pick = await ctx.api('PATCH', '/api/seller/me', { cookie: makerCookie, body: { pickupAddress: 'Villa 12, Street 4, Al Barsha 2, Dubai', pickupPhone: '050 222 3344' } });
  assert.equal(pick.status, 200);
  assert.equal(pick.data.shop.pickupReady, true);
  const r3 = await ctx.api('PATCH', `/api/admin/shops/${shopId}`, { cookie: adminCookie, body: { status: 'approved' } });
  assert.equal(r3.status, 200);
  shops = (await ctx.api('GET', '/api/admin/shops', { cookie: adminCookie })).data.shops;
  assert.deepEqual(shops.find((s) => s.id === shopId).approvalMissing, []);
});

/* ---------------- F006 / F435: identity before payment ---------------- */

const GOOD_ID = (over = {}) => ({
  emiratesIdLast4: '4321', emiratesIdIssue: '2024-01-10', emiratesIdExpiry: '2029-01-09',
  iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Mara Haddad', acceptAgreement: true,
  address: 'Villa 12, Street 4, Al Barsha 2, Dubai',
  eidFront: 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(48, 1)]).toString('base64'),
  eidBack: 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(48, 2)]).toString('base64'),
  ...over,
});

function paidCreditReadyToSettle() {
  const pid = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,20000,5,'live')").run(shopId, 'Bowl', 'Ceramics').lastInsertRowid;
  const oid = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,shipping_cents,total_cents,status,rail)
    VALUES ('TRV-C0001',?,'buyer@test.local',20000,0,20000,'paid','consignment')`).run(buyerId).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,20000,1)').run(oid, pid, shopId, 'Bowl');
  db.prepare(`INSERT INTO shipments (order_id,shop_id,status,delivered_at,return_window_ends_at)
    VALUES (?,?,'delivered',datetime('now','-30 days'),datetime('now','-10 days'))`).run(oid, shopId);
  db.prepare("UPDATE orders SET delivered_at=datetime('now','-30 days'), return_window_ends_at=datetime('now','-10 days') WHERE id=?").run(oid);
  db.prepare("INSERT INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?,'credit_sale',12000)").run(shopId, oid);
  return { pid, oid };
}

test('F006: a typed licence does not skip the ID step; settlement waits for the admin’s ID check', async () => {
  const lic = await ctx.api('POST', '/api/seller/me/license', { cookie: makerCookie, body: { licenseNumber: 'abcd' } });
  assert.equal(lic.data.shop.needsIdVerification, true, 'a typed number proves nothing');
  const noId = await ctx.api('POST', '/api/seller/payout-setup', { cookie: makerCookie, body: GOOD_ID({ eidFront: undefined, eidBack: undefined, address: undefined }) });
  assert.equal(noId.status, 400, 'ID photos still required');

  const ok = await ctx.api('POST', '/api/seller/payout-setup', { cookie: makerCookie, body: GOOD_ID() });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.shop.identity.verified, false);
  assert.equal(ok.data.shop.identity.reason, 'id_to_check');

  paidCreditReadyToSettle();
  let pv = (await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie })).data;
  const held = pv.excluded.find((x) => x.shopId === shopId);
  assert.ok(held, 'not paid before the ID check');
  assert.equal(held.reason, 'id_to_check');

  // The admin sees the typed details beside the photos, then ticks the check.
  const row = (await ctx.api('GET', '/api/admin/shops', { cookie: adminCookie })).data.shops.find((s) => s.id === shopId);
  assert.deepEqual(row.eid, { last4: '4321', issue: '2024-01-10', expiry: '2029-01-09', state: 'ok' });
  assert.equal(row.payoutAccountName, 'Mara Haddad');
  assert.equal(row.accountNameMatches, true);
  const chk = await ctx.api('POST', `/api/admin/shops/${shopId}/identity-check`, { cookie: adminCookie, body: { checked: true } });
  assert.equal(chk.status, 200);
  assert.equal(chk.data.identity.verified, true);
  const stamped = db.prepare('SELECT * FROM shops WHERE id=?').get(shopId);
  assert.equal(stamped.identity_checked_by, adminId, 'who checked it is recorded');
  assert.equal(stamped.verification_method, 'emirates_id');

  pv = (await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie })).data;
  const due = pv.eligible.find((x) => x.shopId === shopId);
  assert.ok(due, 'payable once checked');
  assert.equal(due.accountNameMatches, true);
  assert.equal(due.ownerName, 'Mara Haddad');
});

test('F006: a payout account in someone else’s name is flagged; a bank-only change keeps the ID check', async () => {
  const r = await ctx.api('POST', '/api/seller/payout-setup', { cookie: makerCookie, body: GOOD_ID({ accountName: 'Someone Else Entirely', eidFront: undefined, eidBack: undefined, address: undefined, iban: '', currentPassword: 'testpass123' }) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.shop.identity.verified, true, 'same ID details, so the check stands');
  assert.equal(r.data.shop.iban_masked, 'AE·· ···· 3456', 'an empty IBAN keeps the one on file');
  const pv = (await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie })).data;
  assert.equal(pv.eligible.find((x) => x.shopId === shopId).accountNameMatches, false, 'mismatch flagged to the admin');

  const renewed = await ctx.api('POST', '/api/seller/payout-setup', { cookie: makerCookie, body: GOOD_ID({ emiratesIdExpiry: '2031-01-09', accountName: 'Mara Haddad', iban: '', currentPassword: 'testpass123' }) });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.shop.identity.reason, 'id_to_check', 'a new ID needs a fresh check');
  await ctx.api('POST', `/api/admin/shops/${shopId}/identity-check`, { cookie: adminCookie, body: { checked: true } });
});

test('F006: name matching tolerates order, case, titles and middle names', () => {
  const { namesMatch } = require('../src/identity');
  assert.ok(namesMatch('MARA K HADDAD', 'Mara Haddad'));
  assert.ok(namesMatch('Haddad Mara', 'mara haddad'));
  assert.ok(namesMatch('Ahmed Al Mansoori', 'Ahmed Mansoori'));
  assert.ok(!namesMatch('Someone Else Entirely', 'Mara Haddad'));
  assert.ok(!namesMatch('', 'Mara Haddad'));
});

test('F435: an expiring ID is flagged, the maker is emailed once per state, and an expired ID holds payment', async () => {
  const sent = [];
  const email = require('../src/email');
  const origSend = email.send;
  email.send = async (m) => { sent.push(m); return { id: 't' }; };
  const identity = require('../src/identity');
  try {
    const soon = identity.addDays(identity.today(), 10);
    db.prepare('UPDATE shops SET emirates_id_expiry=? WHERE id=?').run(soon, shopId);
    const row = (await ctx.api('GET', '/api/admin/shops', { cookie: adminCookie })).data.shops.find((s) => s.id === shopId);
    assert.equal(row.eid.state, 'expiring', 'flagged for the admin');
    let r = identity.sweepIdExpiry();
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(r, { reminded: 1, expired: 0 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'maker@test.local');
    assert.match(sent[0].subject, /expires soon/);
    assert.match(sent[0].html, /sell\?view=payments/);
    r = identity.sweepIdExpiry();
    assert.deepEqual(r, { reminded: 0, expired: 0 }, 'once');

    db.prepare('UPDATE shops SET emirates_id_expiry=? WHERE id=?').run(identity.addDays(identity.today(), -1), shopId);
    r = identity.sweepIdExpiry();
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(r, { reminded: 0, expired: 1 });
    assert.match(sent[1].subject, /has expired/);
    const pv = (await ctx.api('GET', '/api/admin/settlements/preview', { cookie: adminCookie })).data;
    assert.equal(pv.excluded.find((x) => x.shopId === shopId).reason, 'id_expired', 'no payment on an expired ID');
    const me = (await ctx.api('GET', '/api/seller/me', { cookie: makerCookie })).data.shop;
    assert.equal(me.identity.eidState, 'expired', 'the dashboard can say so');
  } finally {
    email.send = origSend;
    db.prepare("UPDATE shops SET emirates_id_expiry='2031-01-09', eid_reminder_for=NULL WHERE id=?").run(shopId);
  }
});

/* ---------------- F013: deleting a sold piece ---------------- */

test('F013: a sold piece cannot be deleted and keeps its photos; an unsold one goes with its photos', async () => {
  const uploads = require('../src/uploads');
  const mk = await ctx.api('POST', '/api/seller/products', { cookie: makerCookie, body: { name: 'Sold Mug', price: 60, stock: 2, status: 'live', images: [PNG] } });
  assert.equal(mk.status, 201, mk.text);
  const p = mk.data.product;
  const img = JSON.parse(p.images)[0];
  const file = path.join(uploads.UPLOADS_DIR, img.replace(/^\/uploads\//, ''));
  assert.ok(fs.existsSync(file));
  const oid = db.prepare("INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status) VALUES ('TRV-C0002','b@test.local',6000,6000,'paid')").run().lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,6000,1)').run(oid, p.id, shopId, 'Sold Mug');

  const del = await ctx.api('DELETE', `/api/seller/products/${p.id}`, { cookie: makerCookie });
  assert.equal(del.status, 409);
  assert.equal(del.data.code, 'has_orders');
  assert.match(del.data.error, /hide it instead/);
  assert.ok(db.prepare('SELECT 1 FROM products WHERE id=?').get(p.id), 'still there');
  assert.ok(fs.existsSync(file), 'its photo survives the refused delete');

  const fresh = await ctx.api('POST', '/api/seller/products', { cookie: makerCookie, body: { name: 'Unsold Mug', price: 60, stock: 1, images: [PNG] } });
  const ffile = path.join(uploads.UPLOADS_DIR, JSON.parse(fresh.data.product.images)[0].replace(/^\/uploads\//, ''));
  assert.equal((await ctx.api('DELETE', `/api/seller/products/${fresh.data.product.id}`, { cookie: makerCookie })).status, 200);
  assert.ok(!fs.existsSync(ffile), 'photos go with a deleted piece');
});

/* ---------------- F062: compare-at must be a real reduction ---------------- */

test('F062: a was-price at or below the price is refused, on create and when the price is raised', async () => {
  const bad = await ctx.api('POST', '/api/seller/products', { cookie: makerCookie, body: { name: 'Vase', price: 500, compareAt: 50, stock: 1 } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /compare-at/);
  const same = await ctx.api('POST', '/api/seller/products', { cookie: makerCookie, body: { name: 'Vase', price: 500, compareAt: 500, stock: 1 } });
  assert.equal(same.status, 400);
  const ok = await ctx.api('POST', '/api/seller/products', { cookie: makerCookie, body: { name: 'Vase', price: 300, compareAt: 400, stock: 1 } });
  assert.equal(ok.status, 201, ok.text);
  const raise = await ctx.api('PATCH', `/api/seller/products/${ok.data.product.id}`, { cookie: makerCookie, body: { price: 450 } });
  assert.equal(raise.status, 400, 'raising the price above the was-price is caught');
  const both = await ctx.api('PATCH', `/api/seller/products/${ok.data.product.id}`, { cookie: makerCookie, body: { price: 450, compareAt: null } });
  assert.equal(both.status, 200, 'clearing the was-price with it is fine');
});

/* ---------------- F061: per-shop limits ---------------- */

test('F061: a pending shop has a piece cap; AI tags have an hourly budget per shop', async () => {
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('new@test.local',?,'New Maker','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'pending')").run(uid, 'New Shop', 'new-shop');
  const cookie = await ctx.loginAs('new@test.local', 'testpass123');
  for (let i = 0; i < 3; i++) {
    assert.equal((await ctx.api('POST', '/api/seller/products', { cookie, body: { name: `Piece ${i}`, price: 50, stock: 1 } })).status, 201);
  }
  const over = await ctx.api('POST', '/api/seller/products', { cookie, body: { name: 'One too many', price: 50, stock: 1 } });
  assert.equal(over.status, 409);
  assert.equal(over.data.code, 'piece_limit');

  const ai = require('../src/ai');
  const orig = { enabled: ai.enabled, suggest: ai.suggestTags };
  ai.enabled = () => true;
  ai.suggestTags = async () => ['mug'];
  try {
    for (let i = 0; i < 2; i++) assert.equal((await ctx.api('POST', '/api/seller/products/suggest-tags', { cookie, body: { name: 'Mug' } })).status, 200);
    const third = await ctx.api('POST', '/api/seller/products/suggest-tags', { cookie, body: { name: 'Mug' } });
    assert.equal(third.status, 429);
    assert.equal(third.data.code, 'tag_limit');
    assert.equal((await ctx.api('POST', '/api/seller/products/suggest-tags', { cookie: makerCookie, body: { name: 'Mug' } })).status, 200, 'the budget is per shop');
  } finally { ai.enabled = orig.enabled; ai.suggestTags = orig.suggest; }
});

/* ---------------- F058: moderation is sticky ---------------- */

test('F058: a review the admin hid stays hidden when its author edits it', async () => {
  const pid = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,9000,5,'live')").run(shopId, 'Jug', 'Ceramics').lastInsertRowid;
  const oid = db.prepare("INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,total_cents,status) VALUES ('TRV-C0003',?,'buyer@test.local',9000,9000,'paid')").run(buyerId).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,9000,1)').run(oid, pid, shopId, 'Jug');
  db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?,'delivered')").run(oid, shopId);
  const made = await ctx.api('POST', '/api/account/reviews', { cookie: buyerCookie, body: { productId: pid, rating: 1, body: 'first' } });
  assert.equal(made.status, 201, made.text);
  assert.equal((await ctx.api('PATCH', `/api/admin/reviews/${made.data.id}`, { cookie: adminCookie, body: { status: 'hidden' } })).status, 200);
  const edit = await ctx.api('POST', '/api/account/reviews', { cookie: buyerCookie, body: { productId: pid, rating: 1, body: 'edited after hide' } });
  assert.equal(edit.status, 200);
  assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(made.data.id).status, 'hidden');
  const pub = await ctx.api('GET', `/api/products/${pid}/reviews`);
  assert.ok(!pub.text.includes('edited after hide'), 'not back on the public page');
});

/* ---------------- dashboard + page wiring ---------------- */

test('F014/F029: the editor keeps Hidden; the overview asks for pickup details and the agreement', () => {
  const seller = readDoc('trove-seller.html');
  assert.match(seller, /data-s="hidden"[^>]*>Hidden<\/button>/, 'Hidden is a Visibility choice');
  assert.match(seller, /setSegStatus\(p\.status\);/, 'a hidden piece opens as Hidden, not Live');
  assert.doesNotMatch(seller, /p\.status==='hidden'\?'live'/);
  assert.match(seller, /setupBannerHTML\(\) \+ idExpiryBannerHTML\(\) \+ agreementBannerHTML\(\)/);
  assert.match(seller, /Where should the courier collect\?/);
  assert.match(seller, /SHOP\.pickupPhone\|\|SHOP\.whatsapp/, 'pickup phone prefilled from the WhatsApp number');
  assert.match(seller, /body\.shop-view \.owner-only\{display:none!important\}/);
});

test('F295/F320/F406: agreement and privacy links where people sign up and apply', () => {
  const apply = readDoc('trove-apply.html');
  assert.match(apply, /By applying you agree to our <a href="\/privacy"/);
  assert.match(apply, /class="help r-maker"[^>]*>Before your shop is approved you'll accept the <a href="\/seller-agreement"/);
  const store = readDoc('trove.html');
  assert.match(store, /Read the <a href="\/seller-agreement"[^>]*>Seller Agreement<\/a>/);
  const login = readDoc('trove-login.html');
  assert.match(login, /\/api\/auth\/admin-code/, 'the sign-in page carries the code step');
  assert.match(login, /autocomplete="one-time-code"/);
});
