'use strict';
/**
 * Services Marketplace — terms and the two ways a booking is paid.
 *
 *   - the Provider Agreement and Services Terms are served with a hash, and
 *     their pages exist
 *   - applying records acceptance of the Provider Agreement; a booking records
 *     acceptance of the Services Terms — both are required
 *   - 'direct' bookings carry no commission; 'trove' bookings snapshot the
 *     10% platform fee and the provider's 90%, visible to the provider
 *   - the first release's 'cash' / 'online' spellings still work
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, adminCookie, providerCookie, serviceId;

const APPLY = {
  name: 'Dana Lettering', email: 'dana@test.local', password: 'testpass123',
  providerName: 'Dana Letters', categories: ['made-to-order'], location: 'Dubai, UAE',
  about: 'Hand-lettering for envelopes, signage and nursery walls, in Arabic and English.',
  experience: '3+ years', instagram: '@danaletters', links: '', phone: '+971 50 111 2233',
  agreeSub: true, agreeTerms: true,
};
const BOOK = { name: 'Guest One', email: 'guest@test.local', phone: '050 987 6543', area: 'Dubai', preferredDate: 'Friday', notes: 'Forty envelopes.', agreeTerms: true };

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@test.local', ?, 'Admin', 'admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
});
after(async () => { await ctx.close(); });

test('legal documents are served with a version and hash, and their pages exist', async () => {
  for (const [doc, needle] of [['provider-agreement', 'not the provider of your services'], ['services-terms', 'Trove is not the provider']]) {
    const r = await api('GET', '/api/legal/' + doc);
    assert.equal(r.status, 200);
    assert.equal(r.data.version, 'v1');
    assert.ok(r.data.markdown.includes(needle), `${doc} says it plainly`);
    assert.match(r.data.sha256, /^[0-9a-f]{64}$/);
    const page = await api('GET', '/' + doc);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('/api/legal/' + doc));
  }
  assert.equal((await api('GET', '/api/legal/seller-agreement')).data.version, 'v3', 'the seller agreement still serves');
  assert.equal((await api('GET', '/api/legal/nope')).status, 404);
});

test('config exposes the services commission and document versions', async () => {
  const { data } = await api('GET', '/api/config');
  assert.equal(data.serviceCommissionPercent, 10);
  assert.equal(data.providerAgreementVersion, 'v1');
  assert.equal(data.servicesTermsVersion, 'v1');
});

test('applying requires the Provider Agreement and records the accepted version', async () => {
  let r = await api('POST', '/api/services/apply', { body: { ...APPLY, agreeTerms: false } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Provider Agreement/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email='dana@test.local'").get().c, 0, 'no account left behind');

  r = await api('POST', '/api/services/apply', { body: APPLY });
  assert.equal(r.status, 201);
  const p = db.prepare("SELECT * FROM service_providers WHERE slug='dana-letters'").get();
  assert.equal(p.agreement_version, 'v1');
  assert.ok(p.agreement_accepted_at);
  providerCookie = await ctx.loginAs(APPLY.email, APPLY.password);
  const me = await api('GET', '/api/provider/me', { cookie: providerCookie });
  assert.equal(me.data.provider.agreement.version, 'v1');
  assert.equal(me.data.provider.commissionPercent, 10);

  await api('PATCH', '/api/admin/providers/' + p.id, { cookie: adminCookie, body: { status: 'approved' } });
  const sv = await api('POST', '/api/provider/services', { cookie: providerCookie, body: { title: 'Envelope calligraphy', category: 'made-to-order', priceCents: 120000, priceType: 'fixed', setting: 'studio' } });
  assert.equal(sv.status, 201);
  serviceId = sv.data.service.id;
  const admin = await api('GET', '/api/admin/providers', { cookie: adminCookie });
  const row = admin.data.providers.find((x) => x.slug === 'dana-letters');
  assert.equal(row.agreementVersion, 'v1');
});

test('a booking requires the Services Terms and records the version', async () => {
  let r = await api('POST', `/api/services/${serviceId}/book`, { body: { ...BOOK, agreeTerms: false } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Services Terms/);
  r = await api('POST', `/api/services/${serviceId}/book`, { body: { ...BOOK, paymentMethod: 'direct' } });
  assert.equal(r.status, 201);
  const bk = db.prepare('SELECT * FROM service_bookings WHERE code=?').get(r.data.booking.code);
  assert.equal(bk.terms_version, 'v1');
  assert.equal(bk.payment_method, 'direct');
  assert.equal(bk.commission_cents, 0);
  assert.equal(bk.provider_net_cents, 0);
});

test('paying through Trove snapshots the 10% platform fee; direct carries nothing', async () => {
  const r = await api('POST', `/api/services/${serviceId}/book`, { body: { ...BOOK, paymentMethod: 'trove' } });
  assert.equal(r.status, 201);
  const bk = db.prepare('SELECT * FROM service_bookings WHERE code=?').get(r.data.booking.code);
  assert.equal(bk.payment_method, 'trove');
  assert.equal(bk.commission_cents, 12000);
  assert.equal(bk.provider_net_cents, 108000);

  const mine = await api('GET', '/api/provider/bookings', { cookie: providerCookie });
  const trove = mine.data.bookings.find((b) => b.code === bk.code);
  assert.equal(trove.commissionCents, 12000);
  assert.equal(trove.providerNetCents, 108000);
  const direct = mine.data.bookings.find((b) => b.paymentMethod === 'direct');
  assert.equal(direct.commissionCents, 0);
  assert.ok(!mine.text.includes('guest@test.local'), 'the customer email never reaches the provider');
});

test('the first release spellings still map: cash → direct, online → trove', async () => {
  let r = await api('POST', `/api/services/${serviceId}/book`, { body: { ...BOOK, paymentMethod: 'cash' } });
  assert.equal(db.prepare('SELECT payment_method FROM service_bookings WHERE code=?').get(r.data.booking.code).payment_method, 'direct');
  r = await api('POST', `/api/services/${serviceId}/book`, { body: { ...BOOK, paymentMethod: 'online' } });
  assert.equal(db.prepare('SELECT payment_method FROM service_bookings WHERE code=?').get(r.data.booking.code).payment_method, 'trove');
  r = await api('POST', `/api/services/${serviceId}/book`, { body: { ...BOOK, paymentMethod: 'bitcoin' } });
  assert.equal(db.prepare('SELECT payment_method FROM service_bookings WHERE code=?').get(r.data.booking.code).payment_method, 'direct', 'anything unknown falls back to direct');
});

test('fees.serviceSplit rounds to whole fils and sums back to the gross', () => {
  const fees = require('../src/fees');
  for (const gross of [100, 1500, 12345, 120000, 9999999]) {
    const { fee, net } = fees.serviceSplit(gross);
    assert.equal(fee + net, gross);
    assert.equal(fee, Math.round(gross * 0.1));
  }
});
