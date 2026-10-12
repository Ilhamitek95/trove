'use strict';
/**
 * Low + nit fix round, 12 Oct 2026 — group B (services, account, sign-in,
 * apply). One file so the five branches never collide:
 *   F260  an unpaid booking can always be withdrawn, even on a same-day date
 *   F332  a booking confirmed with no date stops being cancellable after 30 days
 *   F261  the customer's own booking list carries no platform fee / provider share
 *   F414  a practice with nothing live stays off the directory and the sitemap
 *   F416  the provider's optional note with the confirmation: stored, shown, emailed
 *   F462  a refund after a late payment never becomes an unhandled rejection
 *   F463  retrying a failed refund looks first, then uses a fresh idempotency key
 *   F464  deleting someone else's listing is a plain 404, whatever its bookings
 *   F479  00971 and +971 (0) mobiles are understood
 *   F301  the default address can be deleted (the next one takes over); address phones are UAE mobiles
 *   F480  review prompts carry the piece's own photo
 *   F382  a maker can apply with a website instead of Instagram
 *   F488  'both' applicants get one 'application received' email, not two
 *   F486  the email promises the same review time as the page
 *   F339  every live service has its own address, server-rendered and in the sitemap
 *   F340  directory cards show examples as short pills, no dead 'Be the first' branch
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com', RATE_LIMIT_DISABLED: '1' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'https://troveathome.com';
let ctx, db, api, mock, adminCookie, providerCookie, providerId;
const svcIds = {};

const APPLY = {
  name: 'Huda Studio', email: 'huda@test.local', password: 'testpass123',
  providerName: 'Huda Frames', categories: ['workshops'], location: 'Abu Dhabi, UAE',
  about: 'Framing and gallery walls at your place.', experience: '3+ years',
  instagram: '@hudaframes', links: '', phone: '+971 50 111 9988', agreeSub: true, agreeTerms: true,
};
const GUEST = { name: 'Mona Guest', email: 'mona@test.local', phone: '050 222 7788', area: 'Abu Dhabi', preferredDate: 'next week', notes: 'Six frames.', agreeTerms: true };
const dayFromNow = (n) => new Date(Date.now() + 4 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const row = (id) => db.prepare('SELECT * FROM service_bookings WHERE id=?').get(id);
const tokenOf = (viewPath) => new URL('http://x' + viewPath).searchParams.get('t');
const viewApi = (viewPath) => viewPath.replace('/services/booking/', '/api/services/booking/');
const book = (serviceId, body = {}, cookie) => api('POST', `/api/services/${serviceId}/book`, { body: { ...GUEST, paymentMethod: 'trove', ...body }, cookie });
const act = (id, body) => api('PATCH', `/api/provider/bookings/${id}`, { cookie: providerCookie, body });
let evt = 0;
const paidEvent = (bk) => ({
  id: `evt_b12_${++evt}`, type: 'payment_intent.succeeded',
  data: { object: { id: bk.stripe_payment_intent_id, amount: bk.amount_cents, amount_received: bk.amount_cents, metadata: { kind: 'service_booking', booking_id: String(bk.id), code: bk.code } } },
});
const html = (p) => api('GET', p, { headers: { accept: 'text/html' } });
const noScripts = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ');
const h1s = (h) => (noScripts(h).match(/<h1[\s>][\s\S]*?<\/h1>/g) || []);
const canonical = (h) => (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
const ld = (h) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => { const o = JSON.parse(m[1]); return o['@graph'] || [o]; });

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api; mock = ctx.stripeMock;
  require('../src/seed');
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('boss12@test.local', ?, 'Boss', 'admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('boss12@test.local', 'adminpass123');
  const r = await api('POST', '/api/services/apply', { body: APPLY });
  assert.equal(r.status, 201, r.text);
  providerCookie = r.headers.get('set-cookie').split(';')[0];
  providerId = db.prepare("SELECT id FROM service_providers WHERE slug='huda-frames'").get().id;
  await api('PATCH', `/api/admin/providers/${providerId}`, { cookie: adminCookie, body: { status: 'approved' } });
  for (const [key, priceCents, priceType] of [['fixed', 40000, 'fixed'], ['from', 30000, 'from']]) {
    const s = await api('POST', '/api/provider/services', { cookie: providerCookie, body: { title: `Gallery wall hanging (${key})`, category: 'workshops', priceCents, priceType, setting: 'home', description: 'We hang up to twelve frames.' } });
    svcIds[key] = s.data.service.id;
  }
});
after(async () => { await ctx.close(); });

/* ---------------- bookings ---------------- */

test('F260: a booking waiting for its card payment can be withdrawn even on a same-day date', async () => {
  const r = await book(svcIds.fixed);
  await act(r.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(0) });
  assert.equal(row(r.data.booking.id).status, 'awaiting_payment');
  const view = await api('GET', viewApi(r.data.booking.viewPath));
  assert.equal(view.data.booking.canCancel, true, 'nothing paid, so the customer can still say no');
  const c = await api('POST', `/api/services/booking/${r.data.booking.code}/cancel`, { body: { t: tokenOf(r.data.booking.viewPath) } });
  assert.equal(c.status, 200);
  assert.equal(c.data.refunded, false);
  assert.equal(row(r.data.booking.id).status, 'cancelled');
});

test('F332: a booking confirmed with no date is cancellable for 30 days after confirmation, then not', async () => {
  const r = await book(svcIds.fixed, { paymentMethod: 'direct' });
  assert.equal((await act(r.data.booking.id, { action: 'confirm' })).status, 200);
  const svc = require('../src/service-bookings');
  assert.equal(svc.customerCanCancel(row(r.data.booking.id)), true);
  db.prepare("UPDATE service_bookings SET confirmed_at = datetime('now', '-31 days') WHERE id=?").run(r.data.booking.id);
  const view = await api('GET', viewApi(r.data.booking.viewPath));
  assert.equal(view.data.booking.canCancel, false);
  const c = await api('POST', `/api/services/booking/${r.data.booking.code}/cancel`, { body: { t: tokenOf(r.data.booking.viewPath) } });
  assert.equal(c.status, 409);
  assert.equal(row(r.data.booking.id).status, 'confirmed', 'months later, no surprise cancellation reaches the provider');
});

test("F261: the customer's own booking list never carries Trove's fee or the provider's share", async () => {
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('layla12@test.local', ?, 'Layla', 'buyer')").run(hashPassword('testpass123'));
  const cookie = await ctx.loginAs('layla12@test.local', 'testpass123');
  const r = await book(svcIds.fixed, { email: 'layla12@test.local' }, cookie);
  assert.equal(r.status, 201);
  const mine = await api('GET', '/api/services/my-bookings', { cookie });
  const b = mine.data.bookings.find((x) => x.code === r.data.booking.code);
  assert.ok(b);
  assert.equal('commissionCents' in b, false);
  assert.equal('providerNetCents' in b, false);
  assert.ok(row(r.data.booking.id).commission_cents > 0, 'the split is still recorded for Trove');
});

test('F416: the provider can add a note on confirming; it is stored, shown on the booking page and emailed', async () => {
  const r = await book(svcIds.from);
  let c = await act(r.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(5), priceCents: 45000, note: 'Includes <b>frames</b>' });
  assert.equal(c.status, 400, 'no markup in a note that reaches an email');
  c = await act(r.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(5), priceCents: 45000, note: 'Twelve frames, hooks and levelling included; Sunday is my free day.' });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.data.booking.confirmNote, 'Twelve frames, hooks and levelling included; Sunday is my free day.');
  const view = await api('GET', viewApi(r.data.booking.viewPath));
  assert.equal(view.data.booking.confirmNote, 'Twelve frames, hooks and levelling included; Sunday is my free day.');
  const email = require('../src/email');
  const full = db.prepare(`SELECT bk.*, p.name AS provider_name FROM service_bookings bk JOIN service_providers p ON p.id = bk.provider_id WHERE bk.id=?`).get(r.data.booking.id);
  const pay = email.bookingConfirmedPay({ booking: full, payUrl: 'https://x/pay', viewUrl: 'https://x/view', lang: 'en' });
  assert.match(pay.html, /A note from Huda Frames/);
  assert.match(pay.html, /Twelve frames, hooks and levelling included/);
  const ar = email.bookingConfirmedPay({ booking: full, payUrl: 'https://x/pay', viewUrl: 'https://x/view', lang: 'ar' });
  assert.doesNotMatch(ar.html, /A note from/, 'the Arabic email has its own words');
  // a note is optional, and a direct confirmation carries it too
  const d = await book(svcIds.fixed, { paymentMethod: 'direct' });
  assert.equal((await act(d.data.booking.id, { action: 'confirm', note: 'See you then.' })).status, 200);
  const fullD = db.prepare(`SELECT bk.*, p.name AS provider_name FROM service_bookings bk JOIN service_providers p ON p.id = bk.provider_id WHERE bk.id=?`).get(d.data.booking.id);
  assert.match(email.bookingConfirmedDirect({ booking: fullD, viewUrl: 'https://x/view', lang: 'en' }).html, /See you then\./);
});

test('F462: a database error while refunding a late payment is logged, never an unhandled rejection', async () => {
  const r = await book(svcIds.fixed);
  const id = r.data.booking.id;
  await act(id, { action: 'confirm', serviceDate: dayFromNow(6) });
  const bk = row(id);
  assert.equal((await act(id, { action: 'decline', reason: 'Double-booked' })).status, 200);
  const credits = require('../src/service-credits');
  const saved = credits.reverseBooking;
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  credits.reverseBooking = () => { throw new Error('database is locked'); };
  try {
    await ctx.postWebhook(paidEvent(bk));
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(unhandled, 0);
  } finally {
    credits.reverseBooking = saved;
    process.off('unhandledRejection', onUnhandled);
  }
});

test('F463: a refund retry counts a refund that went through, and otherwise uses a fresh idempotency key', async () => {
  const paidBooking = async () => {
    const r = await book(svcIds.fixed);
    await act(r.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(8) });
    await ctx.postWebhook(paidEvent(row(r.data.booking.id)));
    assert.ok(row(r.data.booking.id).paid_at);
    mock.refunds.failNext = 'Your card issuer is unavailable';
    const c = await api('POST', `/api/services/booking/${r.data.booking.code}/cancel`, { body: { t: tokenOf(r.data.booking.viewPath) } });
    assert.equal(c.status, 200);
    assert.equal(row(r.data.booking.id).attention, 'refund_failed');
    return row(r.data.booking.id);
  };
  // 1) the first attempt actually reached the card: the retry sees it and creates nothing new
  const a = await paidBooking();
  mock.addExternalRefund(a.stripe_payment_intent_id, a.amount_cents);
  const before1 = mock.calls.filter((x) => x.method === 'refunds.create').length;
  let res = await api('POST', `/api/admin/service-bookings/${a.id}/refund`, { cookie: adminCookie, body: {} });
  assert.equal(res.status, 200, res.text);
  assert.equal(mock.calls.filter((x) => x.method === 'refunds.create').length, before1, 'no second refund');
  assert.ok(row(a.id).refunded_at);
  assert.equal(row(a.id).attention, '');
  // 2) nothing went through: a new refund with a key the first attempt never used
  const b = await paidBooking();
  const realCreate = mock.refunds.create;
  const keys = [];
  mock.refunds.create = (params, opts) => { keys.push(opts && opts.idempotencyKey); return realCreate(params, opts); };
  try {
    res = await api('POST', `/api/admin/service-bookings/${b.id}/refund`, { cookie: adminCookie, body: {} });
  } finally { mock.refunds.create = realCreate; }
  assert.equal(res.status, 200, res.text);
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0], `trove-svc-refund-${b.id}`);
  assert.match(keys[0], new RegExp(`^trove-svc-refund-${b.id}-retry-`));
  assert.ok(row(b.id).refunded_at);
});

test("F464: deleting another provider's listing is a 404, whatever its bookings", async () => {
  const other = db.prepare("SELECT id FROM services WHERE provider_id != ? AND status = 'live' LIMIT 1").get(providerId);
  db.prepare("INSERT INTO service_bookings (code, service_id, provider_id, name, email, phone, area, payment_method, title, price_cents, price_type, paid_at, stripe_payment_intent_id) SELECT 'SRV-F464AA', id, provider_id, 'X', 'x@test.local', '+971500000000', 'Dubai', 'trove', title, price_cents, price_type, datetime('now'), 'pi_x' FROM services WHERE id = ?").run(other.id);
  const r = await api('DELETE', `/api/provider/services/${other.id}`, { cookie: providerCookie });
  assert.equal(r.status, 404);
});

/* ---------------- directory, provider pages, service addresses ---------------- */

test('F414: a practice with nothing live is off the directory and the sitemap; its page still answers', async () => {
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('empty12@test.local', ?, 'Empty', 'buyer')").run(hashPassword('x')).lastInsertRowid;
  db.prepare("INSERT INTO service_providers (user_id, name, slug, status, categories) VALUES (?, 'Quiet Practice', 'quiet-practice', 'approved', '[\"workshops\"]')").run(uid);
  const list = await api('GET', '/api/services/providers');
  assert.ok(!list.data.providers.some((p) => p.slug === 'quiet-practice'));
  assert.ok(list.data.providers.some((p) => p.slug === 'huda-frames'));
  assert.equal((await api('GET', '/api/services/providers/quiet-practice')).status, 200);
  const map = await api('GET', '/sitemap.xml');
  assert.ok(!map.text.includes(`${BASE}/services/quiet-practice<`), 'not submitted to search engines');
});

test('F339: every live service has its own server-rendered address; wrong slugs 301, gone ones 404', async () => {
  const s = (await api('GET', `/api/services/providers/huda-frames`)).data.services.find((x) => x.id === svcIds.fixed);
  assert.equal(s.path, `/services/huda-frames/${svcIds.fixed}-gallery-wall-hanging-fixed`);
  const res = await html(s.path);
  assert.equal(res.status, 200);
  const h = res.text;
  assert.equal(canonical(h), BASE + s.path);
  const titles = h1s(h);
  assert.equal(titles.length, 1, 'one <h1>');
  assert.match(titles[0], /Gallery wall hanging \(fixed\)/);
  assert.match(h, /<div class="scrim open" id="svScrim"/, 'the service is open over its provider');
  assert.match(h, /<section id="pview">/);
  assert.match(h, /We hang up to twelve frames\./);
  assert.match(h, /<title>Gallery wall hanging \(fixed\) · Huda Frames · Trove Services Marketplace<\/title>/);
  const service = ld(h).find((n) => [].concat(n['@type']).includes('Service') && n.url === BASE + s.path);
  assert.ok(service, 'a Service node for this address');
  assert.equal(service.offers.price, '400.00');
  // cards link to it, and the provider's catalogue offers point at it
  const prov = await html('/services/huda-frames');
  assert.ok(prov.text.includes(`href="${s.path}"`));
  // wrong slug or wrong provider → the right address; an unknown or hidden one → 404
  let r = await html(`/services/huda-frames/${svcIds.fixed}-old-name`);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), s.path);
  r = await html(`/services/someone-else/${svcIds.fixed}`);
  assert.equal(r.status, 301);
  assert.equal((await html('/services/huda-frames/999999-nope')).status, 404);
  await api('PATCH', `/api/provider/services/${svcIds.from}`, { cookie: providerCookie, body: { status: 'hidden' } });
  const hidden = (await api('GET', `/api/provider/services`, { cookie: providerCookie })).data.services.find((x) => x.id === svcIds.from);
  assert.equal(hidden.status, 'hidden');
  assert.equal((await html(`/services/huda-frames/${svcIds.from}-gallery-wall-hanging-from`)).status, 404);
  await api('PATCH', `/api/provider/services/${svcIds.from}`, { cookie: providerCookie, body: { status: 'live' } });
  // the Arabic twin answers, and the sitemap lists the address
  const arr = await html(`/ar${s.path}`);
  assert.equal(arr.status, 200);
  assert.match(arr.text, /<html lang="ar" dir="rtl"/);
  const map = await api('GET', '/sitemap.xml');
  assert.ok(map.text.includes(`<loc>${BASE}${s.path}</loc>`));
});

test('F340: directory cards show examples as short pills, no unreachable empty-category branch', async () => {
  const res = await html('/services');
  assert.equal(res.status, 200);
  assert.match(res.text, /<div class="exs"><span>[^<]+<\/span>/);
  assert.doesNotMatch(noScripts(res.text), /Be the first/);
});

test('F520: the provider page names the emirate, never just the country', async () => {
  const res = await html('/services/huda-frames');
  assert.match(res.text, /<div><b>Abu Dhabi<\/b><span>BASED IN<\/span><\/div>/);
});

/* ---------------- phones, addresses, reviews ---------------- */

test('F479: 00971 and +971 (0) mobiles normalise; other numbers still fail', () => {
  const { normalizeUAEMobile } = require('../src/phone');
  assert.equal(normalizeUAEMobile('00971501234567'), '+971501234567');
  assert.equal(normalizeUAEMobile('00971 50 123 4567'), '+971501234567');
  assert.equal(normalizeUAEMobile('+971 (0)50 123 4567'), '+971501234567');
  assert.equal(normalizeUAEMobile('00501234567'), null);
  assert.equal(normalizeUAEMobile('0044 7700 900123'), null);
});

test('F301: the default address can be deleted (the oldest left takes over); address phones are UAE mobiles', async () => {
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('addr12@test.local', ?, 'Addr', 'buyer')").run(hashPassword('testpass123'));
  const cookie = await ctx.loginAs('addr12@test.local', 'testpass123');
  const base = { name: 'Addr', line: 'Villa 1, Street 2', city: 'Al Barsha, Dubai' };
  let r = await api('POST', '/api/account/addresses', { cookie, body: { ...base, phone: 'n/a', isDefault: true } });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/account/addresses', { cookie, body: { ...base, phone: '050 123 4567', isDefault: true } });
  assert.equal(r.status, 201);
  assert.equal(r.data.address.phone, '+971501234567');
  const first = r.data.address.id;
  const second = (await api('POST', '/api/account/addresses', { cookie, body: { ...base, label: 'Work', phone: '' } })).data.address.id;
  assert.equal((await api('PATCH', `/api/account/addresses/${second}`, { cookie, body: { phone: '04 123 4567' } })).status, 400, 'a landline is not a courier contact');
  assert.equal((await api('DELETE', `/api/account/addresses/${first}`, { cookie })).status, 200, 'the default can go');
  const left = (await api('GET', '/api/account/addresses', { cookie })).data.addresses;
  assert.equal(left.length, 1);
  assert.equal(left[0].id, second);
  assert.equal(left[0].is_default, 1, 'the next address becomes the default');
});

test("F480: review prompts carry the piece's own cover photo", async () => {
  const { hashPassword } = require('../src/middleware');
  const buyer = db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('rev12@test.local', ?, 'Rev', 'buyer')").run(hashPassword('testpass123')).lastInsertRowid;
  const shop = db.prepare("SELECT id FROM shops WHERE status = 'approved' AND is_house = 0 LIMIT 1").get();
  const prod = db.prepare("INSERT INTO products (shop_id, name, category, price_cents, stock, status, images) VALUES (?, 'Photo mug', 'Ceramics', 6400, 3, 'live', ?)").run(shop.id, JSON.stringify(['/uploads/products/mug-1.jpg'])).lastInsertRowid;
  const order = db.prepare("INSERT INTO orders (public_id, buyer_id, email, subtotal_cents, total_cents, status) VALUES ('TRV-B12R01', ?, 'rev12@test.local', 6400, 6400, 'paid')").run(buyer).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id, product_id, shop_id, name_snapshot, price_cents, qty) VALUES (?,?,?,?,?,1)').run(order, prod, shop.id, 'Photo mug', 6400);
  db.prepare("INSERT INTO shipments (order_id, shop_id, status) VALUES (?, ?, 'delivered')").run(order, shop.id);
  const cookie = await ctx.loginAs('rev12@test.local', 'testpass123');
  const r = await api('GET', '/api/account/reviewables', { cookie });
  const p = r.data.products.find((x) => x.id === prod);
  assert.equal(p.image, '/uploads/products/mug-1.jpg');
  assert.equal('images' in p, false);
});

/* ---------------- applications ---------------- */

test('F382: a maker can apply with a website instead of Instagram; one of the two is still needed', async () => {
  const body = { role: 'seller', name: 'Market Potter', email: 'potter12@test.local', password: 'testpass123', shopName: 'Market Pots', phone: '+971 50 333 4455', location: 'Dubai, UAE', about: 'Stoneware sold at weekend markets.' };
  let r = await api('POST', '/api/auth/register', { body: { ...body, instagram: '', links: '' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Instagram or a website/);
  r = await api('POST', '/api/auth/register', { body: { ...body, instagram: '', links: 'marketpots.ae' } });
  assert.equal(r.status, 201, r.text);
});

test("F488: a 'both' applicant gets one 'application received' email; the admin still hears about both", async () => {
  const email = require('../src/email');
  const saved = email.send;
  const sent = [];
  email.send = async (msg) => { sent.push(msg); return { id: 'test' }; };
  try {
    const reg = await api('POST', '/api/auth/register', { body: {
      role: 'seller', name: 'Both Maker', email: 'both12@test.local', password: 'testpass123', shopName: 'Both Studio',
      instagram: '@both', phone: '+971 50 444 5566', location: 'Dubai, UAE', about: 'Pieces and workshops.' } });
    assert.equal(reg.status, 201, reg.text);
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const svc = await api('POST', '/api/services/apply', { cookie, body: {
      name: 'Both Maker', email: 'both12@test.local', providerName: 'Both Studio', categories: ['workshops'], location: 'Dubai, UAE',
      instagram: '@both', phone: '+971 50 444 5566', agreeSub: true, agreeTerms: true, withShop: true } });
    assert.equal(svc.status, 201, svc.text);
    await new Promise((res) => setTimeout(res, 50));
    const toApplicant = sent.filter((m) => m.to === 'both12@test.local' && /application/i.test(m.subject));
    assert.equal(toApplicant.length, 1, toApplicant.map((m) => m.subject).join(' | '));
    // Without the flag (services-only, or a shop from long ago) the applicant is told as before.
    db.prepare("UPDATE shops SET created_at = datetime('now', '-2 hours') WHERE name = 'Both Studio'").run();
    db.prepare("DELETE FROM service_providers WHERE name = 'Both Studio'").run();
    sent.length = 0;
    const again = await api('POST', '/api/services/apply', { cookie, body: {
      name: 'Both Maker', email: 'both12@test.local', providerName: 'Both Studio', categories: ['workshops'], location: 'Dubai, UAE',
      instagram: '@both', phone: '+971 50 444 5566', agreeSub: true, agreeTerms: true, withShop: true } });
    assert.equal(again.status, 201, again.text);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(sent.filter((m) => m.to === 'both12@test.local' && /services application/i.test(m.subject)).length, 1);
  } finally { email.send = saved; }
});

test('F486: the application email promises the same review time as the page', () => {
  const email = require('../src/email');
  const m = email.applicationReceived({ kind: 'shop', name: 'Ola', businessName: 'Ola Pots', link: 'https://x', lang: 'en' });
  assert.match(m.html, /usually within a day or two/);
  assert.doesNotMatch(m.html, /a few days/);
});
