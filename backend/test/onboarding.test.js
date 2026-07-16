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
  assert.equal(res.data.version, 'v2');
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
  assert.equal(shop.agreement_version, 'v2');
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
