'use strict';
/**
 * Services marketplace — enrolment, listings, bookings, approval workflow.
 *
 * The load-bearing rules under test:
 *   - a provider's listings are public ONLY when the provider is approved
 *     and the service is live
 *   - the provider payload NEVER carries the customer's email, and the
 *     phone number appears only once the booking is confirmed
 *   - applying requires agreeing to the monthly platform subscription, and
 *     first approval stamps the subscription start date
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api;
let buyerCookie, providerCookie, adminCookie;
let providerId, serviceId;

const APPLY = {
  name: 'Reem Craft',
  email: 'reem@test.local',
  password: 'testpass123',
  providerName: 'Reem Makes',
  categories: ['workshops'],
  location: 'Dubai, UAE',
  about: 'Pottery hand-building workshops at your place, for groups of up to eight.',
  experience: '3+ years',
  instagram: '@reemmakes',
  links: '',
  phone: '+971 50 111 2233',
  agreeSub: true,
};

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  api = ctx.api;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@test.local', ?, 'Admin', 'admin')")
    .run(hashPassword('adminpass123'));
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('buyer@test.local', ?, 'Layla Buyer', 'buyer')")
    .run(hashPassword('buyerpass123'));
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
  buyerCookie = await ctx.loginAs('buyer@test.local', 'buyerpass123');
});
after(async () => { await ctx.close(); });

/* ---------------- taxonomy & config ---------------- */

test('taxonomy serves 12 categories across two audiences, with the subscription fee', async () => {
  const { status, data } = await api('GET', '/api/services/taxonomy');
  assert.equal(status, 200);
  assert.equal(data.categories.length, 12);
  assert.deepEqual(data.audiences.map((a) => a.key), ['home', 'makers']);
  assert.equal(data.categories.filter((c) => c.audience === 'home').length, 6);
  assert.equal(data.categories.filter((c) => c.audience === 'makers').length, 6);
  for (const c of data.categories) {
    assert.ok(c.slug && c.name && c.blurb, `category ${c.slug} is complete`);
    assert.ok(Array.isArray(c.examples) && c.examples.length >= 3, `category ${c.slug} has examples`);
  }
  assert.equal(data.providerSubFeeCents, 3000);
});

test('public config exposes the provider subscription fee', async () => {
  const { data } = await api('GET', '/api/config');
  assert.equal(data.providerSubFeeCents, 3000);
});

/* ---------------- enrolment ---------------- */

test('applying without agreeing to the subscription is refused', async () => {
  const { status, data } = await api('POST', '/api/services/apply', { body: { ...APPLY, agreeSub: false } });
  assert.equal(status, 400);
  assert.match(data.error, /AED 30/);
});

test('applying outside Dubai & Abu Dhabi is refused', async () => {
  const { status } = await api('POST', '/api/services/apply', { body: { ...APPLY, location: 'Sharjah, UAE' } });
  assert.equal(status, 400);
});

test('an unknown category is refused', async () => {
  const { status } = await api('POST', '/api/services/apply', { body: { ...APPLY, categories: ['sword-swallowing'] } });
  assert.equal(status, 422);
});

test('a new applicant gets an account and a pending provider profile', async () => {
  const res = await api('POST', '/api/services/apply', { body: APPLY });
  assert.equal(res.status, 201);
  providerCookie = res.headers.get('set-cookie').split(';')[0];
  const me = await api('GET', '/api/auth/me', { cookie: providerCookie });
  assert.equal(me.data.provider.name, 'Reem Makes');
  assert.equal(me.data.provider.status, 'pending');
  assert.equal(me.data.shop, null);
  const row = db.prepare('SELECT * FROM service_providers WHERE slug=?').get('reem-makes');
  providerId = row.id;
  assert.equal(row.status, 'pending');
  assert.ok(row.sub_agreed_at, 'subscription agreement is stamped');
  assert.equal(row.sub_started_at, null, 'billing anchor waits for approval');
});

test('the same account cannot apply twice', async () => {
  const { status, data } = await api('POST', '/api/services/apply', { body: APPLY, cookie: providerCookie });
  assert.equal(status, 409);
  assert.equal(data.code, 'already_provider');
});

test('accounts without a profile are locked out of the provider dashboard', async () => {
  const { status } = await api('GET', '/api/provider/me', { cookie: buyerCookie });
  assert.equal(status, 403);
});

/* ---------------- listings ---------------- */

test('a pending provider can create a listing, but it stays off the public list', async () => {
  const res = await api('POST', '/api/provider/services', {
    cookie: providerCookie,
    body: { title: 'Pottery hand-building workshop', category: 'workshops', description: 'Clay, tools and firing included.', priceCents: 35000, priceType: 'fixed', duration: '2–3 hours', setting: 'home' },
  });
  assert.equal(res.status, 201);
  serviceId = res.data.service.id;
  assert.equal(res.data.service.status, 'live');
  const pub = await api('GET', '/api/services');
  assert.equal(pub.data.services.length, 0, 'unapproved providers are invisible');
});

test('listing validation: price bounds, price type, category', async () => {
  const bad = (body) => api('POST', '/api/provider/services', { cookie: providerCookie, body });
  assert.equal((await bad({ title: 'X', category: 'workshops', priceCents: 50 })).status, 400);
  assert.equal((await bad({ title: 'X', category: 'workshops', priceCents: 35000, priceType: 'weekly' })).status, 400);
  assert.equal((await bad({ title: 'X', category: 'nope', priceCents: 35000 })).status, 422);
  assert.equal((await bad({ title: '', category: 'workshops', priceCents: 35000 })).status, 400);
});

test('admin approval publishes the listing and stamps the subscription start', async () => {
  const r = await api('PATCH', `/api/admin/providers/${providerId}`, { cookie: adminCookie, body: { status: 'approved' } });
  assert.equal(r.status, 200);
  const pub = await api('GET', '/api/services');
  assert.equal(pub.data.services.length, 1);
  const sv = pub.data.services[0];
  assert.equal(sv.title, 'Pottery hand-building workshop');
  assert.equal(sv.audience, 'home');
  assert.equal(sv.provider.name, 'Reem Makes');
  const adm = await api('GET', '/api/admin/providers', { cookie: adminCookie });
  const row = adm.data.providers.find((p) => p.id === providerId);
  assert.ok(row.subStartedAt, 'first approval anchors the monthly subscription');
  assert.equal(row.liveServices, 1);
});

test('public filters: category, audience, search', async () => {
  assert.equal((await api('GET', '/api/services?category=workshops')).data.services.length, 1);
  assert.equal((await api('GET', '/api/services?category=coaching')).data.services.length, 0);
  assert.equal((await api('GET', '/api/services?audience=makers')).data.services.length, 0);
  assert.equal((await api('GET', '/api/services?q=pottery')).data.services.length, 1);
});

test('admin stats count providers', async () => {
  const { data } = await api('GET', '/api/admin/stats', { cookie: adminCookie });
  assert.equal(data.providers.total, 1);
  assert.equal(data.providers.approved, 1);
});

/* ---------------- bookings ---------------- */

let guestBookingId, buyerBookingId;

test('a guest can request a booking; area and phone are validated', async () => {
  const body = { name: 'Amal Guest', email: 'amal@test.local', phone: '050 987 6543', area: 'Dubai', preferredDate: 'Friday afternoon', notes: 'Six adults, garden table.', paymentMethod: 'cash' };
  assert.equal((await api('POST', `/api/services/${serviceId}/book`, { body: { ...body, area: 'Sharjah' } })).status, 400);
  assert.equal((await api('POST', `/api/services/${serviceId}/book`, { body: { ...body, phone: '12345' } })).status, 400);
  const res = await api('POST', `/api/services/${serviceId}/book`, { body });
  assert.equal(res.status, 201);
  assert.match(res.data.booking.code, /^SRV-[0-9A-F]{6}$/);
  guestBookingId = res.data.booking.id;
});

test('the provider sees the request without email or phone until confirmed', async () => {
  const { data } = await api('GET', '/api/provider/bookings', { cookie: providerCookie });
  assert.equal(data.bookings.length, 1);
  const bk = data.bookings[0];
  assert.equal(bk.customerName, 'Amal Guest');
  assert.equal(bk.paymentMethod, 'cash');
  assert.equal(bk.phone, null, 'phone is withheld until the provider confirms');
  assert.ok(!JSON.stringify(data).includes('amal@test.local'), 'the customer email never reaches the provider');
});

test('confirming hands over the phone; completing needs a confirmed booking', async () => {
  assert.equal((await api('PATCH', `/api/provider/bookings/${guestBookingId}`, { cookie: providerCookie, body: { action: 'complete' } })).status, 409);
  const c = await api('PATCH', `/api/provider/bookings/${guestBookingId}`, { cookie: providerCookie, body: { action: 'confirm' } });
  assert.equal(c.status, 200);
  assert.equal(c.data.booking.phone, '+971509876543');
  const done = await api('PATCH', `/api/provider/bookings/${guestBookingId}`, { cookie: providerCookie, body: { action: 'complete' } });
  assert.equal(done.data.booking.status, 'completed');
  assert.equal((await api('PATCH', `/api/provider/bookings/${guestBookingId}`, { cookie: providerCookie, body: { action: 'decline' } })).status, 409);
});

test('a signed-in customer sees their bookings and can cancel a request', async () => {
  const res = await api('POST', `/api/services/${serviceId}/book`, {
    cookie: buyerCookie,
    body: { name: 'Layla Buyer', email: 'buyer@test.local', phone: '0501112222', area: 'Abu Dhabi', paymentMethod: 'online' },
  });
  assert.equal(res.status, 201);
  buyerBookingId = res.data.booking.id;
  const mine = await api('GET', '/api/services/my-bookings', { cookie: buyerCookie });
  assert.equal(mine.data.bookings.length, 1);
  assert.equal(mine.data.bookings[0].paymentMethod, 'online');
  assert.equal(mine.data.bookings[0].providerName, 'Reem Makes');
  const cancel = await api('POST', `/api/services/bookings/${buyerBookingId}/cancel`, { cookie: buyerCookie });
  assert.equal(cancel.status, 200);
  assert.equal((await api('POST', `/api/services/bookings/${buyerBookingId}/cancel`, { cookie: buyerCookie })).status, 409);
});

test('another account cannot touch someone else\'s booking', async () => {
  const { status } = await api('POST', `/api/services/bookings/${guestBookingId}/cancel`, { cookie: buyerCookie });
  assert.equal(status, 404);
});

/* ---------------- visibility edges ---------------- */

test('hidden listings and suspended providers vanish, and cannot be booked', async () => {
  await api('PATCH', `/api/provider/services/${serviceId}`, { cookie: providerCookie, body: { status: 'hidden' } });
  assert.equal((await api('GET', '/api/services')).data.services.length, 0);
  assert.equal((await api('POST', `/api/services/${serviceId}/book`, { body: { name: 'A', email: 'a@b.co', phone: '0501234567', area: 'Dubai' } })).status, 404);
  await api('PATCH', `/api/provider/services/${serviceId}`, { cookie: providerCookie, body: { status: 'live' } });
  assert.equal((await api('GET', '/api/services')).data.services.length, 1);
  await api('PATCH', `/api/admin/providers/${providerId}`, { cookie: adminCookie, body: { status: 'suspended' } });
  assert.equal((await api('GET', '/api/services')).data.services.length, 0);
  await api('PATCH', `/api/admin/providers/${providerId}`, { cookie: adminCookie, body: { status: 'approved' } });
});
