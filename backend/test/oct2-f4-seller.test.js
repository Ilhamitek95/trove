'use strict';
/**
 * Medium-findings round 2026-10-02, group F4 — the maker dashboard:
 *   F096  changing only the bank details doesn't ask for the Emirates ID
 *         again (empty = keep what is on file), a maker with a verified
 *         licence is never asked for it, and an agreement already accepted
 *         isn't re-ticked
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, cookie, licCookie, shopId;
const TINY_JPEG = 'data:image/jpeg;base64,' +
  Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7)]).toString('base64');
const shop = () => db.prepare('SELECT * FROM shops WHERE id=?').get(shopId);
const setup = (body, c = cookie) => api('POST', '/api/seller/payout-setup', { cookie: c, body });

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('f4maker@test.local',?, 'Mara Maker','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(uid, 'F4 Pots', 'f4-pots').lastInsertRowid;
  cookie = await ctx.loginAs('f4maker@test.local', 'testpass123');
  const uid2 = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('f4lic@test.local',?, 'Lina Licence','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  db.prepare("INSERT INTO shops (user_id,name,slug,status,license_number,license_verified_at) VALUES (?,?,?, 'approved','CN-1234567',datetime('now'))").run(uid2, 'F4 Licensed', 'f4-licensed');
  licCookie = await ctx.loginAs('f4lic@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('F096: bank-only changes keep the Emirates ID on file; the agreement is not re-ticked', async () => {
  const first = await setup({
    emiratesIdLast4: '4417', emiratesIdExpiry: '2033-05-01',
    iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Mara Maker',
    acceptAgreement: true, eidFront: TINY_JPEG, eidBack: TINY_JPEG, address: 'Apt 4, Sunrise Building, Al Quoz, Dubai',
  });
  assert.equal(first.status, 200, first.text);
  const acceptedAt = shop().agreement_accepted_at;
  db.prepare("UPDATE shops SET identity_checked_at=datetime('now') WHERE id=?").run(shopId);

  // A new bank name only: no ID fields, no agreement tick, IBAN left empty.
  const r = await setup({ bankName: 'Other Bank', accountName: 'Mara Maker', currentPassword: 'testpass123' });
  assert.equal(r.status, 200, r.text);
  const s = shop();
  assert.equal(s.payout_bank_name, 'Other Bank');
  assert.equal(s.emirates_id_last4, '4417', 'the ID on file is kept');
  assert.equal(s.emirates_id_expiry, '2033-05-01');
  assert.equal(s.agreement_accepted_at, acceptedAt, 'the agreement is not re-stamped');
  assert.ok(s.identity_checked_at, 'a bank-only change keeps the ID check');

  // A malformed ID is still refused, and a renewed one replaces it.
  assert.equal((await setup({ bankName: 'Other Bank', accountName: 'Mara Maker', emiratesIdLast4: '12' })).status, 400);
  const renewed = await setup({ bankName: 'Other Bank', accountName: 'Mara Maker', emiratesIdLast4: '9001', emiratesIdExpiry: '2036-01-01' });
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(shop().emirates_id_last4, '9001');
  assert.equal(shop().identity_checked_at, null, 'new ID details need a fresh check');
});

test('F096: a maker with a verified licence is never asked for Emirates ID details', async () => {
  const r = await setup({ iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Lina Licence', acceptAgreement: true }, licCookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.shop.needsIdVerification, false);
});

test('F096: a maker without a verified licence must still give the ID once', async () => {
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('f4new@test.local',?, 'Nadia New','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(uid, 'F4 New', 'f4-new');
  const c = await ctx.loginAs('f4new@test.local', 'testpass123');
  const r = await setup({ iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Nadia New', acceptAgreement: true,
    eidFront: TINY_JPEG, eidBack: TINY_JPEG, address: 'Apt 4, Sunrise Building, Al Quoz, Dubai' }, c);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Emirates ID/);
  const noAgree = await setup({ emiratesIdLast4: '1111', emiratesIdExpiry: '2033-05-01', iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Nadia New',
    eidFront: TINY_JPEG, eidBack: TINY_JPEG, address: 'Apt 4, Sunrise Building, Al Quoz, Dubai' }, c);
  assert.equal(noAgree.status, 400, 'a first setup still needs the agreement');
  assert.match(noAgree.data.error, /Seller Agreement/);
});

/* F170 / F171: what a maker is waiting for, and why */
test('F170/F171: the settlements payload says when pending money lands, and when another parcel holds it', async () => {
  const { hashPassword } = require('../src/middleware');
  const other = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('f4slow@test.local',?, 'Slow Maker','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  const slowShop = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(other, 'F4 Slow', 'f4-slow').lastInsertRowid;
  const order = (pid) => db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,total_cents,status,rail,title_transferred_at)
    VALUES (?,'b@test.local',10000,13000,'paid','consignment',datetime('now','-20 days'))`).run(pid).lastInsertRowid;
  const credit = (oid, shop, c) => db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', ?)").run(shop, oid, c);
  const ship = (oid, shop, status, ends) => db.prepare(`INSERT INTO shipments (order_id,shop_id,status,delivered_at,return_window_ends_at)
    VALUES (?,?,?,${ends ? "datetime('now','-12 days')" : 'NULL'},${ends ? `datetime('now','${ends}')` : 'NULL'})`).run(oid, shop, status).lastInsertRowid;

  // 1) delivered, window still open → paid in the first run after it closes
  const o1 = order('TRV-F4W001'); credit(o1, shopId, 7680); ship(o1, shopId, 'delivered', '+5 days');
  // 2) delivered and its own window closed, but the slow maker's parcel isn't
  const o2 = order('TRV-F4W002'); credit(o2, shopId, 3840); ship(o2, shopId, 'delivered', '-2 days');
  const slow = ship(o2, slowShop, 'processing', null);
  // 3) not delivered yet
  const o3 = order('TRV-F4W003'); credit(o3, shopId, 1000); ship(o3, shopId, 'processing', null);

  const r = await api('GET', '/api/seller/settlements', { cookie });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.pending.map((p) => [p.order, p]));
  assert.equal(by['TRV-F4W001'].reason, 'return_window');
  assert.equal(by['TRV-F4W001'].amountCents, 7680);
  const settlement = require('../src/settlement');
  assert.ok(settlement.isRunDate(by['TRV-F4W001'].payoutDate), 'lands on a run date');
  assert.ok(by['TRV-F4W001'].payoutDate > by['TRV-F4W001'].readyOn, 'after the window closes');
  assert.equal(by['TRV-F4W002'].reason, 'other_parcel');
  assert.equal(by['TRV-F4W002'].payoutDate, null);
  assert.equal(by['TRV-F4W003'].reason, 'not_delivered');
  assert.equal(r.data.pendingCents, 7680 + 3840 + 1000);

  const orders = await api('GET', '/api/seller/orders', { cookie });
  const card = orders.data.orders.find((o) => o.order.publicId === 'TRV-F4W002');
  assert.equal(card.waitingForOtherParcels, true, 'the order card says it waits for the other parcel');
  assert.equal(orders.data.orders.find((o) => o.order.publicId === 'TRV-F4W001').waitingForOtherParcels, false);

  // Once the other parcel is delivered (window from then), it's an ordinary return window.
  db.prepare("UPDATE shipments SET status='delivered', delivered_at=datetime('now'), return_window_ends_at=datetime('now','+15 days') WHERE id=?").run(slow);
  db.prepare("UPDATE orders SET return_window_ends_at=datetime('now','+15 days') WHERE id=?").run(o2);
  const again = (await api('GET', '/api/seller/settlements', { cookie })).data.pending.find((p) => p.order === 'TRV-F4W002');
  assert.equal(again.reason, 'return_window');
  assert.ok(again.payoutDate);
});

test('F098/F099/F148/F150/F168/F305: dashboard wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const seller = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-seller.html'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'provider-panel.js'), 'utf8');
  assert.doesNotMatch(seller, /querySelectorAll\('\.pill,\.badge'\)\.forEach\(n=>n\.remove\(\)\)/, 'phone tabs keep their badges');
  assert.match(seller, /function setPill\(id,n\)/);
  assert.match(seller, /loadServiceCounts\(\)\]\)/, 'booking requests are counted at boot');
  assert.match(seller, /function todoCardHTML\(/);
  assert.match(seller, /Get your shop ready/);
  assert.doesNotMatch(seller, /leadBannerHTML\(\) \+ reviewBannerHTML/, 'the make-time banner is not repeated on the overview');
  assert.match(seller, /How many can you sell right now\? Set at least 1/);
  assert.match(seller, /\$\('dStock'\)\.value='1'/, 'a new piece starts with 1 in stock');
  assert.match(seller, /mountRequests\(\$\('ppRequests'\)\)/, 'requests sit at the top of the Services tab');
  assert.match(panel, /function mountRequests\(el\)/);
  assert.doesNotMatch(seller, /Trove Express/, 'no made-up courier name');
});
