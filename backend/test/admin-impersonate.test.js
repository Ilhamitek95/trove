'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, sellerCookie;
let approvedShopId, pendingShopId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const mkUser = (email, role) => db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)')
    .run(email, hashPassword('testpass123'), 'T', role).lastInsertRowid;
  mkUser('admin-imp@test.local', 'admin');
  const owner = mkUser('owner-imp@test.local', 'seller');
  approvedShopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')")
    .run(owner, 'Imp Shop', 'imp-shop').lastInsertRowid;
  const pendingOwner = mkUser('pending-imp@test.local', 'seller');
  pendingShopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'pending')")
    .run(pendingOwner, 'Pending Imp Shop', 'pending-imp-shop').lastInsertRowid;
  adminCookie = await ctx.loginAs('admin-imp@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('owner-imp@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('only admins can open a shop view', async () => {
  const anon = await ctx.api('POST', `/api/admin/impersonate/${approvedShopId}`);
  assert.equal(anon.status, 401);
  const seller = await ctx.api('POST', `/api/admin/impersonate/${approvedShopId}`, { cookie: sellerCookie });
  assert.equal(seller.status, 403);
});

test('unknown shop is a 404', async () => {
  const r = await ctx.api('POST', '/api/admin/impersonate/99999', { cookie: adminCookie });
  assert.equal(r.status, 404);
});

test('impersonating switches the session to the shop owner', async () => {
  const r = await ctx.api('POST', `/api/admin/impersonate/${approvedShopId}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'owner-imp@test.local');
  assert.equal(r.data.shop.slug, 'imp-shop');
  const me = await ctx.api('GET', '/api/auth/me', { cookie: adminCookie });
  assert.equal(me.data.user.email, 'owner-imp@test.local');
  assert.equal(me.data.impersonating, true);
  assert.equal(me.data.shop.slug, 'imp-shop');
  const sellerMe = await ctx.api('GET', '/api/seller/me', { cookie: adminCookie });
  assert.equal(sellerMe.status, 200);
  assert.equal(sellerMe.data.shop.slug, 'imp-shop');
});

test('while in shop view, admin endpoints lock out', async () => {
  const r = await ctx.api('GET', '/api/admin/stats', { cookie: adminCookie });
  assert.equal(r.status, 403);
});

test('stop-impersonating returns the session to the admin', async () => {
  const r = await ctx.api('POST', '/api/auth/stop-impersonating', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'admin-imp@test.local');
  const me = await ctx.api('GET', '/api/auth/me', { cookie: adminCookie });
  assert.equal(me.data.user.email, 'admin-imp@test.local');
  assert.equal(me.data.impersonating, false);
  const stats = await ctx.api('GET', '/api/admin/stats', { cookie: adminCookie });
  assert.equal(stats.status, 200);
});

test('pending shops have a shop view too', async () => {
  const r = await ctx.api('POST', `/api/admin/impersonate/${pendingShopId}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  const sellerMe = await ctx.api('GET', '/api/seller/me', { cookie: adminCookie });
  assert.equal(sellerMe.data.shop.slug, 'pending-imp-shop');
  const back = await ctx.api('POST', '/api/auth/stop-impersonating', { cookie: adminCookie });
  assert.equal(back.status, 200);
});

test('stop without a shop view is a 400', async () => {
  const r = await ctx.api('POST', '/api/auth/stop-impersonating', { cookie: adminCookie });
  assert.equal(r.status, 400);
});
