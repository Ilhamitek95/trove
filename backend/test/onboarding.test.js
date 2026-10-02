'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, sellerCookie;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')")
    .run(hashPassword('testpass123')).lastInsertRowid;
  db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?, 'approved')").run(uid, 'Test Pots', 'test-pots');
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('the seller agreement is served with a verifiable hash', async () => {
  const res = await ctx.api('GET', '/api/legal/seller-agreement');
  assert.equal(res.status, 200);
  assert.equal(res.data.version, 'v5');
  assert.match(res.data.markdown, /Trove purchases that piece from you/);
  assert.match(res.data.markdown, /accountable for the goods you supply/);
  assert.equal(res.data.sha256, require('../src/crypto').sha256(res.data.markdown));
});

// The magic-byte check is all the validator reads, so a stub JPEG body works.
const TINY_JPEG = 'data:image/jpeg;base64,' +
  Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7)]).toString('base64');

test('payout-setup validation: last4, expiry, IBAN, agreement', async () => {
  const good = {
    emiratesIdLast4: '4417', emiratesIdExpiry: '2033-05-01',
    iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Maker LLC',
    acceptAgreement: true,
    eidFront: TINY_JPEG, eidBack: TINY_JPEG, address: 'Apt 4, Sunrise Building, Al Quoz, Dubai',
  };
  for (const [patch, msg] of [
    [{ emiratesIdLast4: '12' }, /Emirates ID/],
    [{ emiratesIdExpiry: '2020-01-01' }, /expiry/],
    [{ iban: 'GB29NWBK60161331926819' }, /UAE IBAN/],
    [{ acceptAgreement: false }, /Seller Agreement/],
  ]) {
    const res = await ctx.api('POST', '/api/seller/payout-setup', { cookie: sellerCookie, body: { ...good, ...patch } });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.match(res.data.error, msg);
  }

  const ok = await ctx.api('POST', '/api/seller/payout-setup', { cookie: sellerCookie, body: good });
  assert.equal(ok.status, 200, ok.text);
  // Response is scrubbed: masked only, never the encrypted blob or plaintext.
  assert.equal(ok.data.shop.iban_encrypted, undefined);
  assert.equal(ok.data.shop.payout_iban, undefined);
  assert.equal(ok.data.shop.iban_masked, 'AE·· ···· 3456');

  const shop = db.prepare("SELECT * FROM shops WHERE slug='test-pots'").get();
  assert.ok(shop.iban_encrypted);
  assert.equal(shop.payout_iban, '');
  assert.equal(shop.emirates_id_last4, '4417');
  assert.equal(shop.agreement_version, 'v5');
  assert.ok(shop.agreement_accepted_at);
  assert.ok(shop.agreement_hash);
  assert.equal(require('../src/crypto').decrypt(shop.iban_encrypted), 'AE070331234567890123456');
});

test('GET /api/seller/me never exposes encrypted or plaintext IBANs', async () => {
  const me = await ctx.api('GET', '/api/seller/me', { cookie: sellerCookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.shop.iban_encrypted, undefined);
  assert.equal(me.data.shop.payout_iban, undefined);
  assert.ok(me.data.shop.iban_masked);
});

test('the old bank endpoint is gone (410)', async () => {
  const res = await ctx.api('PATCH', '/api/seller/payout', { cookie: sellerCookie, body: { iban: 'AE070331234567890123456' } });
  assert.equal(res.status, 410);
});

test('register with a license number queues the shop for the Connect rail', async () => {
  const res = await ctx.api('POST', '/api/auth/register', { body: {
    role: 'seller', name: 'Licensed Leila', email: 'leila@test.local', password: 'testpass123',
    shopName: 'Leila Makes', location: 'Al Quoz, Dubai', about: 'I make lovely handmade things in my Al Quoz studio, honest.',
    instagram: '@leilamakes', phone: '+971501234567', licenseNumber: 'CN-7654321',
  } });
  assert.equal(res.status, 201, res.text);
  const shop = db.prepare("SELECT * FROM shops WHERE name='Leila Makes'").get();
  assert.equal(shop.license_number, 'CN-7654321');
  assert.equal(shop.connect_queue, 1);
  assert.equal(shop.tier, 'consignment'); // sells on consignment until Rail B flips them
});

test('register without a license leaves connect_queue off', async () => {
  await ctx.api('POST', '/api/auth/register', { body: {
    role: 'seller', name: 'Plain Petra', email: 'petra@test.local', password: 'testpass123',
    shopName: 'Petra Pots', location: 'Deira, Dubai', about: 'Small-batch pottery from my Deira kitchen table, glazed by hand.',
    instagram: '@petrapots', phone: '+971501234568',
  } });
  const shop = db.prepare("SELECT * FROM shops WHERE name='Petra Pots'").get();
  assert.equal(shop.connect_queue, 0);
  assert.equal(shop.license_number, '');
});

test('Seller Agreement v5 names the company; v4 makers keep selling and are asked to accept', async () => {
  const legal = await ctx.api('GET', '/api/legal/seller-agreement');
  assert.equal(legal.data.version, 'v5');
  assert.match(legal.data.markdown, /fortnightly, every other Tuesday/);
  assert.match(legal.data.markdown, /15-day return window has closed/);
  assert.match(legal.data.markdown, /refunded once the\s+courier has collected it/);
  assert.match(legal.data.markdown, /\*\*Serein Consultancy\s+LLC\*\*, a limited liability company licensed by Sharjah Media City \(Shams\),\s+licence no\. 2220356\.01/);
  assert.match(legal.data.markdown, /Trove and Trove at Home are its brand names/);
  assert.match(legal.data.markdown, /licence\s+threshold stated in the maker section of the \[Help centre\]\(\/faq#makers\)/, 'the threshold is one a maker can find');
  assert.doesNotMatch(legal.data.markdown, /published threshold/);
  const flat = legal.data.markdown.replace(/\s+/g, ' ');
  assert.match(flat, /Trove emails you \*\*30 days before it expires\*\*\. While it has expired, settlements to you \*\*pause\*\*/);
  assert.match(flat, /Before your shop is approved, you accept this agreement and give Trove a \*\*collection \(pickup\) address and phone\*\*/);
  assert.match(flat, /\*\*full delivery address\*\* only for a parcel you deliver yourself, and only until that order's return window closes/);
  assert.doesNotMatch(legal.data.markdown, /weekly|7-day/, 'no old cadence');
  // Older versions stay untouched as the signed record.
  const read = (v) => require('fs').readFileSync(require('path').join(__dirname, '..', 'legal', `seller-agreement-${v}.md`), 'utf8');
  assert.match(read('v3'), /weekly, on Tuesdays/);
  assert.match(read('v4'), /Trove's published threshold/);

  // A v4 maker: v5 changes no money term, so selling carries on; they are asked to accept.
  db.prepare("UPDATE shops SET agreement_version='v4' WHERE slug='test-pots'").run();
  let me = await ctx.api('GET', '/api/seller/me', { cookie: sellerCookie });
  assert.equal(me.data.shop.agreementUpdateDue, true);
  assert.equal(me.data.shop.sellingPaused, false);
  assert.equal(me.data.shop.currentAgreementVersion, 'v5');
  assert.match(me.data.shop.agreementChangeNote, /Serein Consultancy LLC/);

  let res = await ctx.api('POST', '/api/seller/agreement', { cookie: sellerCookie, body: {} });
  assert.equal(res.status, 400, 'acceptance must be explicit');
  res = await ctx.api('POST', '/api/seller/agreement', { cookie: sellerCookie, body: { accept: true } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.shop.agreementUpdateDue, false);
  const shop = db.prepare("SELECT * FROM shops WHERE slug='test-pots'").get();
  assert.equal(shop.agreement_version, 'v5');
  assert.equal(shop.agreement_hash, require('../src/crypto').sha256(legal.data.markdown), 'hash of the exact v5 text');
  me = await ctx.api('GET', '/api/seller/me', { cookie: sellerCookie });
  assert.equal(me.data.shop.agreementUpdateDue, false);
});

test('a maker on v1–v3 cannot sell on terms they never accepted until they accept the current agreement', async () => {
  const shop = db.prepare("SELECT * FROM shops WHERE slug='test-pots'").get();
  const pid = db.prepare(`INSERT INTO products (shop_id, name, price_cents, stock, status) VALUES (?, 'Gate test bowl', 9000, 3, 'live')`)
    .run(shop.id).lastInsertRowid;
  const listed = async () => (await ctx.api('GET', '/api/products')).data.products.some((p) => p.id === pid);
  const checkout = () => ctx.api('POST', '/api/checkout', { body: { items: [{ productId: pid, qty: 1 }], email: 'buyer@test.local' } });
  assert.equal(await listed(), true, 'on the current version the piece is on sale');

  // v3 promised weekly runs and a 7-day hold; the code now applies v4 terms.
  db.prepare("UPDATE shops SET agreement_version='v3' WHERE id=?").run(shop.id);
  const me = await ctx.api('GET', '/api/seller/me', { cookie: sellerCookie });
  assert.equal(me.data.shop.agreementUpdateDue, true);
  assert.equal(me.data.shop.sellingPaused, true, 'the dashboard says the pieces are off sale');
  assert.equal(await listed(), false, 'hidden from the catalogue');
  assert.equal((await ctx.api('GET', `/api/products/${pid}`)).status, 404, 'no piece page either');
  const blocked = await checkout();
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /unavailable/);
  const settle = await ctx.api('GET', '/api/seller/settlements', { cookie: sellerCookie });
  assert.equal(settle.data.payoutSetupComplete, true, 'money already owed is not held back');
  for (const v of ['v1', 'v2', '', null]) {
    db.prepare('UPDATE shops SET agreement_version=? WHERE id=?').run(v, shop.id);
    assert.equal(await listed(), false, `version ${v} is off sale`);
  }

  const res = await ctx.api('POST', '/api/seller/agreement', { cookie: sellerCookie, body: { accept: true } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.shop.sellingPaused, false);
  assert.equal(await listed(), true, 'back on sale once accepted');
  const ok = await checkout();
  assert.equal(ok.status, 200, ok.text);

  // The rule itself.
  const agreements = require('../src/agreements');
  assert.equal(agreements.canSell({ agreement_accepted_at: 'x', agreement_version: 'v4' }), true, 'v4 carries the terms the code applies');
  assert.equal(agreements.canSell({ agreement_accepted_at: 'x', agreement_version: 'v3' }), false);
  assert.equal(agreements.canSell({ is_house: 1, agreement_accepted_at: 'x', agreement_version: 'v1' }), true, 'the Trove Collection has no agreement');
  db.prepare("UPDATE products SET status='hidden' WHERE id=?").run(pid);
});
