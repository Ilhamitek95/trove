'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let ctx, db, plainCookie, licensedCookie, buyerCookie, adminCookie;

// Distinct bodies so front/back can be told apart after decryption.
const FRONT_BYTES = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(48, 1)]);
const BACK_BYTES  = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(48, 2)]);
const FRONT = 'data:image/jpeg;base64,' + FRONT_BYTES.toString('base64');
const BACK  = 'data:image/jpeg;base64,' + BACK_BYTES.toString('base64');

const GOOD = {
  emiratesIdLast4: '4417', emiratesIdExpiry: '2033-05-01',
  iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Own Name',
  acceptAgreement: true,
};

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const mkUser = (email, role) => db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)')
    .run(email, hashPassword('testpass123'), 'T', role).lastInsertRowid;
  const plain = mkUser('plain@test.local', 'seller');
  db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(plain, 'Plain Pots', 'plain-pots');
  const lic = mkUser('licensed@test.local', 'seller');
  db.prepare("INSERT INTO shops (user_id,name,slug,status,connect_queue,license_number) VALUES (?,?,?,'approved',1,'CN-1')").run(lic, 'Lic Goods', 'lic-goods');
  mkUser('buyer@test.local', 'buyer');
  mkUser('admin@test.local', 'admin');
  plainCookie = await ctx.loginAs('plain@test.local', 'testpass123');
  licensedCookie = await ctx.loginAs('licensed@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('buyer@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('unlicensed sellers must provide ID photos and a home address', async () => {
  for (const [body, msg] of [
    [{ ...GOOD }, /home address/i],
    [{ ...GOOD, address: 'Apt 1, Blue Tower, Al Quoz, Dubai' }, /front of your Emirates ID/],
    [{ ...GOOD, address: 'Apt 1, Blue Tower, Al Quoz, Dubai', eidFront: FRONT }, /back of your Emirates ID/],
    [{ ...GOOD, eidFront: FRONT, eidBack: BACK, address: 'Somewhere in Sharjah' }, /Dubai or Abu Dhabi/],
  ]) {
    const res = await ctx.api('POST', '/api/seller/payout-setup', { cookie: plainCookie, body });
    assert.equal(res.status, 400, res.text);
    assert.match(res.data.error, msg);
  }
});

test('happy path: photos stored encrypted, address saved, response scrubbed', async () => {
  const res = await ctx.api('POST', '/api/seller/payout-setup', {
    cookie: plainCookie,
    body: { ...GOOD, eidFront: FRONT, eidBack: BACK, address: 'Apt 1, Blue Tower, Al Quoz, Dubai' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.shop.eidFrontProvided, true);
  assert.equal(res.data.shop.eidBackProvided, true);
  assert.equal(res.data.shop.eid_front_file, undefined, 'storage paths never leave the server');

  const shop = db.prepare("SELECT * FROM shops WHERE slug='plain-pots'").get();
  assert.ok(shop.eid_front_file && shop.eid_back_file);
  assert.equal(shop.seller_address, 'Apt 1, Blue Tower, Al Quoz, Dubai');

  // On disk: present, and NOT a readable JPEG (encrypted at rest).
  const onDisk = fs.readFileSync(path.join(process.env.PRIVATE_DIR, shop.eid_front_file));
  assert.notEqual(onDisk[0], 0xFF, 'file must not start with JPEG magic bytes');
  assert.notDeepEqual(onDisk.subarray(0, 4), FRONT_BYTES.subarray(0, 4));
});

test('updating bank details later keeps the ID and address on file', async () => {
  const res = await ctx.api('POST', '/api/seller/payout-setup', {
    cookie: plainCookie, body: { ...GOOD, bankName: 'Another Bank' },
  });
  assert.equal(res.status, 200, res.text);
  const shop = db.prepare("SELECT * FROM shops WHERE slug='plain-pots'").get();
  assert.ok(shop.eid_front_file && shop.eid_back_file && shop.seller_address);
  assert.equal(shop.payout_bank_name, 'Another Bank');
});

test('licensed sellers (connect queue) are not asked for ID photos', async () => {
  const res = await ctx.api('POST', '/api/seller/payout-setup', { cookie: licensedCookie, body: { ...GOOD } });
  assert.equal(res.status, 200, res.text);
});

test('admin can view decrypted ID images; nobody else can', async () => {
  const shop = db.prepare("SELECT id FROM shops WHERE slug='plain-pots'").get();

  // Binary round-trip: fetch directly so nothing text-decodes the body.
  const front = await fetch(`${ctx.baseUrl}/api/admin/shops/${shop.id}/eid/front`, { headers: { cookie: adminCookie } });
  assert.equal(front.status, 200);
  assert.equal(front.headers.get('content-type').split(';')[0], 'image/jpeg');
  assert.equal(front.headers.get('cache-control'), 'no-store, private');
  assert.deepEqual(Buffer.from(await front.arrayBuffer()), FRONT_BYTES, 'decrypted image matches the original upload');

  const back = await fetch(`${ctx.baseUrl}/api/admin/shops/${shop.id}/eid/back`, { headers: { cookie: adminCookie } });
  assert.equal(back.status, 200);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), BACK_BYTES);

  for (const cookie of [plainCookie, buyerCookie, undefined]) {
    const res = await ctx.api('GET', `/api/admin/shops/${shop.id}/eid/front`, { cookie });
    assert.ok([401, 403].includes(res.status), `expected auth rejection, got ${res.status}`);
  }

  const missing = await ctx.api('GET', '/api/admin/shops/999/eid/front', { cookie: adminCookie });
  assert.equal(missing.status, 404);
  const badSide = await ctx.api('GET', `/api/admin/shops/${shop.id}/eid/selfie`, { cookie: adminCookie });
  assert.equal(badSide.status, 400);
});

test('admin shop list shows address + ID flags', async () => {
  const res = await ctx.api('GET', '/api/admin/shops', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const plain = res.data.shops.find((s) => s.slug === 'plain-pots');
  assert.equal(plain.eidFront, true);
  assert.equal(plain.eidBack, true);
  assert.equal(plain.sellerAddress, 'Apt 1, Blue Tower, Al Quoz, Dubai');
  const lic = res.data.shops.find((s) => s.slug === 'lic-goods');
  assert.equal(lic.eidFront, false);
  assert.equal(lic.connectQueue, true);
});
