'use strict';
/**
 * One account, shop + services.
 *
 *   - a maker with an APPROVED shop switches on services from their dashboard
 *     and is live immediately (subscription anchored, agreement recorded);
 *     a PENDING shop yields a pending practice
 *   - the switch needs categories, the subscription and the Provider
 *     Agreement, and happens once
 *   - a shop application can carry a services application on the same
 *     session (pieces + services, one form)
 *   - the shared dashboard script and the seller dashboard's Services tab serve
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, adminCookie;

const SHOP_APP = {
  role: 'seller', name: 'Reem Potter', email: 'reem@test.local', password: 'testpass123',
  shopName: 'Reem Ceramics', category: 'Ceramics', location: 'Dubai, UAE',
  about: 'Hand-built stoneware from a small studio in Al Quoz, glazed in soft greens and creams.',
  experience: '3+ years', maker: 'I make everything myself', plannedProducts: 'Mugs, bowls', channels: 'Instagram / WhatsApp',
  capacity: '10–30', instagram: '@reemceramics', links: '', phone: '+971 50 111 2233',
};

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@test.local', ?, 'Admin', 'admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
});
after(async () => { await ctx.close(); });

test('an approved maker switches on services and is live straight away', async () => {
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('mara@test.local', ?, 'Mara', 'seller')").run(hashPassword('marapass123'));
  const uid = db.prepare("SELECT id FROM users WHERE email='mara@test.local'").get().id;
  db.prepare("INSERT INTO shops (user_id, name, slug, status, bio, location, color, pitch_phone, pitch_instagram) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(uid, 'Kiln & Clay', 'kiln-and-clay', 'approved', 'Stoneware from Al Quoz.', 'Al Quoz, Dubai', '#DBC7BD', '+971 50 000 1111', 'instagram.com/kilnandclay');
  const cookie = await ctx.loginAs('mara@test.local', 'marapass123');

  // Validation first: nothing is written on a bad request.
  let r = await api('POST', '/api/seller/enable-services', { cookie, body: { categories: [], agreeSub: true, agreeTerms: true } });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/seller/enable-services', { cookie, body: { categories: ['workshops'], agreeSub: true, agreeTerms: false } });
  assert.equal(r.status, 400); assert.match(r.data.error, /Provider Agreement/);
  r = await api('POST', '/api/seller/enable-services', { cookie, body: { categories: ['workshops'], agreeSub: false, agreeTerms: true } });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/seller/enable-services', { cookie, body: { categories: ['not-a-category'], agreeSub: true, agreeTerms: true } });
  assert.equal(r.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM service_providers WHERE user_id=?').get(uid).c, 0);

  r = await api('POST', '/api/seller/enable-services', { cookie, body: { categories: ['workshops', 'care-repair'], plannedServices: 'Hand-building afternoons', agreeSub: true, agreeTerms: true } });
  assert.equal(r.status, 201);
  assert.equal(r.data.provider.status, 'approved', 'already curated → live immediately');
  assert.equal(r.data.provider.slug, 'kiln-and-clay');
  const p = db.prepare('SELECT * FROM service_providers WHERE user_id=?').get(uid);
  assert.equal(p.name, 'Kiln & Clay');
  assert.equal(p.bio, 'Stoneware from Al Quoz.');
  assert.equal(p.location, 'Al Quoz, Dubai');
  assert.equal(p.pitch_phone, '+971 50 000 1111');
  assert.ok(p.sub_started_at, 'subscription anchored on the day it went live');
  assert.equal(p.agreement_version, 'v1');
  assert.ok(p.agreement_accepted_at);
  assert.deepEqual(JSON.parse(p.categories), ['workshops', 'care-repair']);

  // Once only.
  r = await api('POST', '/api/seller/enable-services', { cookie, body: { categories: ['workshops'], agreeSub: true, agreeTerms: true } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'already_provider');

  // Same session now drives the provider dashboard, and /auth/me shows both.
  const me = await api('GET', '/api/auth/me', { cookie });
  assert.equal(me.data.shop.slug, 'kiln-and-clay');
  assert.equal(me.data.provider.slug, 'kiln-and-clay');
  const dash = await api('GET', '/api/provider/me', { cookie });
  assert.equal(dash.data.provider.status, 'approved');
  const sv = await api('POST', '/api/provider/services', { cookie, body: { title: 'Hand-building afternoon', category: 'workshops', priceCents: 120000, priceType: 'fixed', setting: 'home' } });
  assert.equal(sv.status, 201);
  const pub = await api('GET', '/api/services/providers/kiln-and-clay');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.services.length, 1);
  assert.equal(pub.data.provider.shop.slug, 'kiln-and-clay');
});

test('a pending shop yields a pending practice with no subscription anchor', async () => {
  let r = await api('POST', '/api/auth/register', { body: SHOP_APP });
  assert.equal(r.status, 201);
  const cookie = await ctx.loginAs(SHOP_APP.email, SHOP_APP.password);
  r = await api('POST', '/api/seller/enable-services', { cookie, body: { categories: ['workshops'], agreeSub: true, agreeTerms: true } });
  assert.equal(r.status, 201);
  assert.equal(r.data.provider.status, 'pending');
  assert.equal(r.data.provider.subStartedAt, null);
  const p = db.prepare("SELECT * FROM service_providers WHERE slug='reem-ceramics'").get();
  assert.equal(p.status, 'pending');
  assert.equal(p.sub_started_at, null);
  // Not public until approved…
  assert.equal((await api('GET', '/api/services/providers/reem-ceramics')).status, 404);
  // …and approval stamps the anchor, like any provider.
  await api('PATCH', '/api/admin/providers/' + p.id, { cookie: adminCookie, body: { status: 'approved' } });
  assert.ok(db.prepare('SELECT sub_started_at FROM service_providers WHERE id=?').get(p.id).sub_started_at);
});

test('a shop application can carry a services application on the same session', async () => {
  const both = { ...SHOP_APP, name: 'Sami Weaver', email: 'sami@test.local', shopName: 'Sami Weaves', instagram: '@samiweaves' };
  let r = await api('POST', '/api/auth/register', { body: both });
  assert.equal(r.status, 201);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'the shop application signs the applicant in');
  // The way trove-apply.html does it: same session, no password resent.
  r = await api('POST', '/api/services/apply', { cookie, body: {
    name: both.name, email: both.email, providerName: both.shopName, categories: ['workshops'],
    location: both.location, about: both.about, experience: both.experience, plannedServices: 'Weaving afternoons',
    instagram: both.instagram, links: '', phone: both.phone, agreeSub: true, agreeTerms: true,
  } });
  assert.equal(r.status, 201, r.text);
  const me = await api('GET', '/api/auth/me', { cookie });
  assert.equal(me.data.shop.name, 'Sami Weaves');
  assert.equal(me.data.provider.name, 'Sami Weaves');
  assert.equal(me.data.provider.status, 'pending');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email='sami@test.local'").get().c, 1, 'one account');
});

test('the shared dashboard script and the Services tab are served', async () => {
  let r = await api('GET', '/provider-panel.js');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('window.ProviderPanel'));
  r = await api('GET', '/sell');
  assert.ok(r.text.includes('id="view-services"') && r.text.includes('enable-services') && r.text.includes('provider-panel.js'));
  r = await api('GET', '/provider');
  assert.ok(r.text.includes('provider-panel.js') && r.text.includes('id="ppServices"'));
  r = await api('GET', '/apply');
  assert.ok(r.text.includes('data-role="maker"') && r.text.includes('data-role="provider"') && r.text.includes('data-role="both"'), 'one form, three doors');
  assert.ok(r.text.includes('/api/services/apply') && r.text.includes('/api/auth/register'));
  // The old provider wizard address lands on the same form, services preselected.
  r = await api('GET', '/become-a-provider');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/apply?for=services');
  r = await api('GET', '/trove-provider-apply.html');
  assert.equal(r.status, 301);
});
