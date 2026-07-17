'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, sellerCookie, adminCookie;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const mkUser = (email, role) => db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)')
    .run(email, hashPassword('testpass123'), 'T', role).lastInsertRowid;
  const uid = mkUser('late-lic@test.local', 'seller');
  db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(uid, 'Late License', 'late-license');
  mkUser('admin2@test.local', 'admin');
  sellerCookie = await ctx.loginAs('late-lic@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('admin2@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const shopRow = () => db.prepare("SELECT * FROM shops WHERE slug='late-license'").get();

test('too-short license number is rejected', async () => {
  const r = await ctx.api('POST', '/api/seller/me/license', { cookie: sellerCookie, body: { licenseNumber: ' CN ' } });
  assert.equal(r.status, 400);
  assert.equal(shopRow().license_number, '');
});

test('recording a license flags the shop for verification and waives EID', async () => {
  const r = await ctx.api('POST', '/api/seller/me/license', { cookie: sellerCookie, body: { licenseNumber: '  CN-7654321  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.shop.license_number, 'CN-7654321');
  assert.equal(r.data.shop.needsIdVerification, false);
  const row = shopRow();
  assert.equal(row.license_number, 'CN-7654321');
  assert.equal(row.connect_queue, 1);
  assert.equal(row.license_verified_at, null);
});

test('the shop appears in the admin graduation queue and can be verified', async () => {
  const q = await ctx.api('GET', '/api/admin/graduation', { cookie: adminCookie });
  const entry = q.data.queue.find((g) => g.shopId === shopRow().id);
  assert.ok(entry, 'late-licensed shop is in the graduation queue');
  assert.equal(entry.licenseNumber, 'CN-7654321');
  const v = await ctx.api('POST', `/api/admin/graduation/${shopRow().id}/verify-license`, { cookie: adminCookie });
  assert.equal(v.status, 200);
  assert.ok(shopRow().license_verified_at, 'verification stamped');
});

test('changing the number resets verification; same number keeps it', async () => {
  const same = await ctx.api('POST', '/api/seller/me/license', { cookie: sellerCookie, body: { licenseNumber: 'CN-7654321' } });
  assert.equal(same.status, 200);
  assert.ok(shopRow().license_verified_at, 'unchanged number stays verified');
  const changed = await ctx.api('POST', '/api/seller/me/license', { cookie: sellerCookie, body: { licenseNumber: 'CN-9999999' } });
  assert.equal(changed.status, 200);
  assert.equal(shopRow().license_verified_at, null);
  assert.equal(shopRow().license_number, 'CN-9999999');
});

test('buyers and signed-out visitors cannot record a license', async () => {
  const anon = await ctx.api('POST', '/api/seller/me/license', { body: { licenseNumber: 'CN-1234567' } });
  assert.equal(anon.status, 401);
});
