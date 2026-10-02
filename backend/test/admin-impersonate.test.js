'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Every privilege change issues a fresh session cookie (session fixation);
// follow it the way a browser does.
const follow = (res, cookie) => (res.headers.get('set-cookie') || '').split(';')[0] || cookie;

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
  const before = adminCookie;
  const r = await ctx.api('POST', `/api/admin/impersonate/${approvedShopId}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  adminCookie = follow(r, adminCookie);
  assert.notEqual(adminCookie, before, 'shop view starts on a new session id');
  assert.equal((await ctx.api('GET', '/api/auth/me', { cookie: before })).status, 401, 'the old session id is dead');
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
  const before = adminCookie;
  adminCookie = follow(r, adminCookie);
  assert.notEqual(adminCookie, before, 'leaving shop view starts on a new session id');
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
  adminCookie = follow(r, adminCookie);
  const sellerMe = await ctx.api('GET', '/api/seller/me', { cookie: adminCookie });
  assert.equal(sellerMe.data.shop.slug, 'pending-imp-shop');
  const back = await ctx.api('POST', '/api/auth/stop-impersonating', { cookie: adminCookie });
  assert.equal(back.status, 200);
  adminCookie = follow(back, adminCookie);
});

test('stop without a shop view is a 400', async () => {
  const r = await ctx.api('POST', '/api/auth/stop-impersonating', { cookie: adminCookie });
  assert.equal(r.status, 400);
});

// F064: changing the admin password must also end a session the admin left
// parked in shop view, or its 'Back to admin' restores full admin powers.
test('a password change ends a session the admin left in shop view', async () => {
  const r = await ctx.api('POST', `/api/admin/impersonate/${approvedShopId}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  const parked = follow(r, adminCookie);
  const other = await ctx.loginAs('admin-imp@test.local', 'testpass123');
  const ch = await ctx.api('POST', '/api/auth/password', { cookie: other, body: { current: 'testpass123', password: 'NewAdminPass456!' } });
  assert.equal(ch.status, 200);
  const back = await ctx.api('POST', '/api/auth/stop-impersonating', { cookie: parked });
  assert.notEqual(back.status, 200, 'the parked shop-view session is gone');
  const stats = await ctx.api('GET', '/api/admin/stats', { cookie: follow(back, parked) });
  assert.equal(stats.status, 401);
  // The session that made the change carries on.
  const mine = await ctx.api('GET', '/api/admin/stats', { cookie: follow(ch, other) });
  assert.equal(mine.status, 200);
});
