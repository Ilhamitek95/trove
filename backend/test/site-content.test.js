'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, adminCookie, sellerCookie;

before(async () => {
  ctx = await startApp();
  const { hashPassword } = require('../src/middleware');
  const mkUser = (email, role) => ctx.db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)')
    .run(email, hashPassword('testpass123'), 'T', role).lastInsertRowid;
  mkUser('cms-admin@test.local', 'admin');
  const uid = mkUser('cms-seller@test.local', 'seller');
  ctx.db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(uid, 'CMS Shop', 'cms-shop');
  adminCookie = await ctx.loginAs('cms-admin@test.local', 'testpass123');
  sellerCookie = await ctx.loginAs('cms-seller@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('public content serves the built-in defaults', async () => {
  const r = await ctx.api('GET', '/api/content');
  assert.equal(r.status, 200);
  assert.equal(r.data.home.hero.h1, 'Curated|for *Living*');
  assert.equal(r.data.sell.faq.items.length, 7);
  assert.deepEqual(r.data.home.weekly.productIds, []);
  assert.match(r.data.site.promo.text, /Free delivery/);
  assert.match(r.data.site.footer.legal, /© 2026 trove/);
});

test('the sitewide chrome (announcement bar + footer) is editable', async () => {
  const def = (await ctx.api('GET', '/api/admin/content', { cookie: adminCookie })).data.defaults;
  const promo = { ...def['site.promo'], text: 'Eid delivery slots are open · Free delivery over AED 500' };
  assert.equal((await ctx.api('PUT', '/api/admin/content/site.promo', { cookie: adminCookie, body: promo })).status, 200);
  const footer = { ...def['site.footer'], legal: '© 2026 trove LLC · Dubai, UAE' };
  assert.equal((await ctx.api('PUT', '/api/admin/content/site.footer', { cookie: adminCookie, body: footer })).status, 200);
  const pub = await ctx.api('GET', '/api/content');
  assert.match(pub.data.site.promo.text, /Eid delivery/);
  assert.equal(pub.data.site.footer.legal, '© 2026 trove LLC · Dubai, UAE');
  assert.match(pub.data.site.footer.blurb, /Thoughtfully chosen/, 'untouched field keeps its default');
  await ctx.api('DELETE', '/api/admin/content/site.promo', { cookie: adminCookie });
  await ctx.api('DELETE', '/api/admin/content/site.footer', { cookie: adminCookie });
});

test('editing is admin-only', async () => {
  const anon = await ctx.api('GET', '/api/admin/content');
  assert.equal(anon.status, 401);
  const seller = await ctx.api('PUT', '/api/admin/content/home.hero', { cookie: sellerCookie, body: {} });
  assert.equal(seller.status, 403);
});

test('a saved section overrides the default on the public endpoint', async () => {
  const hero = (await ctx.api('GET', '/api/admin/content', { cookie: adminCookie })).data.defaults['home.hero'];
  const edited = { ...hero, eyebrow: 'Gathered with love', h1: 'Made|for *Home*' };
  const r = await ctx.api('PUT', '/api/admin/content/home.hero', { cookie: adminCookie, body: edited });
  assert.equal(r.status, 200);
  const pub = await ctx.api('GET', '/api/content');
  assert.equal(pub.data.home.hero.eyebrow, 'Gathered with love');
  assert.equal(pub.data.home.hero.h1, 'Made|for *Home*');
  const admin = await ctx.api('GET', '/api/admin/content', { cookie: adminCookie });
  assert.ok(admin.data.overrides['home.hero'], 'override listed for the editor');
});

test('reset returns a section to the default', async () => {
  const r = await ctx.api('DELETE', '/api/admin/content/home.hero', { cookie: adminCookie });
  assert.equal(r.status, 200);
  const pub = await ctx.api('GET', '/api/content');
  assert.equal(pub.data.home.hero.eyebrow, 'Thoughtfully gathered');
});

test('banned money-transmission phrasing is rejected and not saved', async () => {
  const faq = (await ctx.api('GET', '/api/admin/content', { cookie: adminCookie })).data.defaults['sell.faq'];
  const evil = { ...faq, items: [{ q: 'Who takes the money?', a: 'Easy - we handle payments for you.' }] }; // copy-ok: asserting the guardrail
  const r = await ctx.api('PUT', '/api/admin/content/sell.faq', { cookie: adminCookie, body: evil });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /can't be used/);
  const pub = await ctx.api('GET', '/api/content');
  assert.equal(pub.data.sell.faq.items.length, 7, 'default kept');
});

test('shape and length validation', async () => {
  const def = (await ctx.api('GET', '/api/admin/content', { cookie: adminCookie })).data.defaults;
  const missing = { ...def['home.browse'], heading: '' };
  assert.equal((await ctx.api('PUT', '/api/admin/content/home.browse', { cookie: adminCookie, body: missing })).status, 422);
  const tooLong = { ...def['home.browse'], heading: 'x'.repeat(300) };
  assert.equal((await ctx.api('PUT', '/api/admin/content/home.browse', { cookie: adminCookie, body: tooLong })).status, 422);
  const wrongList = { ...def['home.marquee'], items: def['home.marquee'].items.slice(0, 2) };
  assert.equal((await ctx.api('PUT', '/api/admin/content/home.marquee', { cookie: adminCookie, body: wrongList })).status, 422);
  assert.equal((await ctx.api('PUT', '/api/admin/content/nonsense', { cookie: adminCookie, body: {} })).status, 422);
});

test('flexible lists accept a different length within bounds', async () => {
  const def = (await ctx.api('GET', '/api/admin/content', { cookie: adminCookie })).data.defaults['sell.faq'];
  const three = { ...def, items: def.items.slice(0, 3) };
  const r = await ctx.api('PUT', '/api/admin/content/sell.faq', { cookie: adminCookie, body: three });
  assert.equal(r.status, 200);
  assert.equal((await ctx.api('GET', '/api/content')).data.sell.faq.items.length, 3);
  const none = { ...def, items: [] };
  assert.equal((await ctx.api('PUT', '/api/admin/content/sell.faq', { cookie: adminCookie, body: none })).status, 422);
  await ctx.api('DELETE', '/api/admin/content/sell.faq', { cookie: adminCookie });
});

test('weekly picks validate as product ids and cap at 8', async () => {
  const def = (await ctx.api('GET', '/api/admin/content', { cookie: adminCookie })).data.defaults['home.weekly'];
  const good = { ...def, productIds: [3, 1, 2] };
  assert.equal((await ctx.api('PUT', '/api/admin/content/home.weekly', { cookie: adminCookie, body: good })).status, 200);
  assert.deepEqual((await ctx.api('GET', '/api/content')).data.home.weekly.productIds, [3, 1, 2]);
  const bad = { ...def, productIds: ['DROP TABLE'] };
  assert.equal((await ctx.api('PUT', '/api/admin/content/home.weekly', { cookie: adminCookie, body: bad })).status, 422);
  const many = { ...def, productIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] };
  assert.equal((await ctx.api('PUT', '/api/admin/content/home.weekly', { cookie: adminCookie, body: many })).status, 422);
});
