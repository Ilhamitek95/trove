'use strict';
/**
 * Services Marketplace — browsing providers + the demo providers.
 *
 *   - the public provider directory and profile show approved providers and
 *     live services only, and never carry contact details
 *   - /services/<slug> serves the services page (asset paths under it do not)
 *   - the demo providers seed idempotently, pass the same validation a real
 *     provider's listings would, and can sign in to a dashboard that shows
 *     their bookings without the customer's email
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  api = ctx.api;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('layla@email.com', ?, 'Layla Hassan', 'buyer')")
    .run(hashPassword('demo1234'));
});
after(async () => { await ctx.close(); });

test('demo providers seed once and never twice', () => {
  const { ensureDemoProviders, DEMO_PROVIDERS, DEMO_BOOKINGS } = require('../src/demo-providers');
  assert.equal(ensureDemoProviders(db), DEMO_PROVIDERS.length);
  const count = () => db.prepare('SELECT COUNT(*) AS c FROM service_providers').get().c;
  const services = () => db.prepare('SELECT COUNT(*) AS c FROM services').get().c;
  const n = count(), s = services();
  assert.equal(ensureDemoProviders(db), 0, 'second run creates nothing');
  assert.equal(count(), n);
  assert.equal(services(), s);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM service_bookings').get().c, DEMO_BOOKINGS.length);
  // Mara's existing seller account gains the profile — no duplicate user.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email='mara@kilnandclay.com'").get().c, 1);
  const pending = db.prepare("SELECT status, sub_started_at FROM service_providers WHERE slug='oud-by-khalid'").get();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.sub_started_at, null, 'no billing anchor before approval');
  const approved = db.prepare("SELECT sub_started_at FROM service_providers WHERE slug='kiln-and-clay-workshops'").get();
  assert.ok(approved.sub_started_at, 'approved demo providers carry their subscription start');
});

test('every demo listing would pass the provider dashboard validation', () => {
  const { DEMO_PROVIDERS } = require('../src/demo-providers');
  const tax = require('../src/service-taxonomy');
  const { isServiceable } = require('../src/service-area');
  const slugs = new Set();
  for (const p of DEMO_PROVIDERS) {
    assert.ok(!slugs.has(p.slug), `slug ${p.slug} unique`); slugs.add(p.slug);
    assert.ok(p.categories.length >= 1 && p.categories.length <= 3, `${p.slug} has 1–3 categories`);
    for (const c of p.categories) assert.equal(tax.serviceCategoryError(c), null, `${p.slug} category ${c}`);
    assert.ok(isServiceable(p.location), `${p.slug} is in a service area`);
    assert.ok(p.services.length >= 1);
    for (const s of p.services) {
      assert.ok(s.title.length > 0 && s.title.length <= 90, `${s.title} title length`);
      assert.equal(tax.serviceCategoryError(s.category), null, `${s.title} category`);
      assert.ok(p.categories.includes(s.category), `${s.title} sits in one of ${p.slug}'s categories`);
      const cents = Math.round(s.price * 100);
      assert.ok(cents >= 100 && cents <= 10000000, `${s.title} price in range`);
      assert.ok(tax.PRICE_TYPES.includes(s.type), `${s.title} price type`);
      assert.ok(tax.SETTINGS.includes(s.setting), `${s.title} setting`);
      assert.ok(s.description.length <= 2000 && s.duration.length <= 60);
    }
  }
});

test('the provider directory lists approved providers only, with counts and no contact details', async () => {
  const { status, data } = await api('GET', '/api/services/providers');
  assert.equal(status, 200);
  const slugs = data.providers.map((p) => p.slug);
  assert.ok(slugs.includes('kiln-and-clay-workshops'));
  assert.ok(!slugs.includes('oud-by-khalid'), 'pending providers are not listed');
  assert.equal(data.providers.length, 6);
  for (const p of data.providers) {
    assert.ok(p.serviceCount >= 1, `${p.slug} has live services`);
    assert.ok(p.fromCents >= 100, `${p.slug} has a from-price`);
    assert.ok(Array.isArray(p.categories) && p.categories.length);
    assert.equal(p.since, String(new Date().getUTCFullYear()));
    for (const k of ['pitch_phone', 'pitchPhone', 'phone', 'email', 'user_id', 'userId', 'pitch_instagram']) {
      assert.ok(!(k in p), `${k} must not be public`);
    }
  }
  assert.ok(!JSON.stringify(data).includes('+971'), 'no phone number anywhere in the payload');
  assert.ok(!JSON.stringify(data).includes('@'), 'no email anywhere in the payload');
});

test('a provider profile carries their live services; hidden ones and pending providers stay out', async () => {
  let r = await api('GET', '/api/services/providers/kiln-and-clay-workshops');
  assert.equal(r.status, 200);
  assert.equal(r.data.provider.name, 'Kiln & Clay Workshops');
  assert.equal(r.data.services.length, 3);
  assert.equal(r.data.provider.serviceCount, 3);
  assert.equal(r.data.provider.fromCents, 18000);
  for (const s of r.data.services) assert.equal(s.provider.slug, 'kiln-and-clay-workshops');

  const hidden = db.prepare("SELECT id FROM services WHERE title='Ceramic repair & kintsugi'").get();
  db.prepare("UPDATE services SET status='hidden' WHERE id=?").run(hidden.id);
  r = await api('GET', '/api/services/providers/kiln-and-clay-workshops');
  assert.equal(r.data.services.length, 2);
  assert.equal(r.data.provider.serviceCount, 2);
  assert.equal(r.data.provider.fromCents, 95000, 'from-price follows the live listings');
  db.prepare("UPDATE services SET status='live' WHERE id=?").run(hidden.id);

  r = await api('GET', '/api/services/providers/oud-by-khalid');
  assert.equal(r.status, 404);
  r = await api('GET', '/api/services/providers/nobody-here');
  assert.equal(r.status, 404);
});

test('the public services list carries the demo listings with their provider', async () => {
  const { data } = await api('GET', '/api/services');
  const noor = data.services.filter((s) => s.provider.slug === 'noor-letters');
  assert.equal(noor.length, 4);
  assert.ok(!data.services.some((s) => s.provider.slug === 'oud-by-khalid'), 'pending provider listings stay private');
});

test('/services/<slug> serves the services page; asset paths under it do not', async () => {
  let r = await api('GET', '/services/kiln-and-clay-workshops');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('id="pview"'), 'the services page with the profile view');
  assert.ok(r.text.includes('src="/config.js"'), 'scripts resolve from the root at the nested path');
  r = await api('GET', '/services/config.js');
  assert.equal(r.status, 404);
  r = await api('GET', '/services/Not_A_Slug');
  assert.equal(r.status, 404);
});

test('a demo provider signs in to a dashboard that shows their bookings without the customer email', async () => {
  const cookie = await ctx.loginAs('mara@kilnandclay.com', 'demo1234');
  const me = await api('GET', '/api/auth/me', { cookie });
  assert.equal(me.data.provider.slug, 'kiln-and-clay-workshops');
  // (In the seeded app Mara also keeps her Kiln & Clay shop — one account, shop + services.)

  const r = await api('GET', '/api/provider/bookings', { cookie });
  assert.equal(r.status, 200);
  const list = r.data.bookings || r.data;
  assert.equal(list.length, 2);
  assert.ok(!r.text.includes('layla@email.com'), 'the customer email never reaches the provider');
  const requested = list.find((b) => b.code === 'SRV-DEMO01');
  const confirmed = list.find((b) => b.code === 'SRV-DEMO02');
  assert.equal(requested.status, 'requested');
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(!requested.phone, 'phone withheld until confirmed');
  assert.ok(confirmed.phone, 'phone released once confirmed');

  const services = await api('GET', '/api/provider/services', { cookie });
  assert.equal(services.data.services.length, 3);

  // A provider-only demo account (no shop) also signs in.
  const cookie2 = await ctx.loginAs('noor@noorletters.ae', 'demo1234');
  const me2 = await api('GET', '/api/auth/me', { cookie: cookie2 });
  assert.equal(me2.data.provider.slug, 'noor-letters');
  assert.equal(me2.data.shop, null);
});
