'use strict';
/**
 * Medium-findings round 2026-10-02, group F4 — service bookings:
 *   F070  a booking can't be paid once its service date has passed; the hourly
 *         sweep closes unpaid bookings past their date, reminds a provider
 *         about an unanswered request after 2 days and closes it after 7
 *   F071  a suspended (or rejected) provider can't confirm a booking or be
 *         paid; suspending closes their open requests, and the admin can
 *         cancel + refund their confirmed bookings
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, mock, adminCookie, providerCookie, providerId, serviceId;
const APPLY = {
  name: 'Lina Frames', email: 'lina-f4@test.local', password: 'testpass123',
  providerName: 'Lina Walls', categories: ['workshops'], location: 'Dubai, UAE',
  about: 'Gallery walls at your place.', experience: '3+ years',
  instagram: '@linawalls', links: '', phone: '+971 50 111 9999', agreeSub: true, agreeTerms: true,
};
const GUEST = { name: 'Omar Guest', email: 'omar-f4@test.local', phone: '050 222 9999', area: 'Dubai', preferredDate: 'soon', notes: 'Four frames.', agreeTerms: true };
const dayFromNow = (n) => new Date(Date.now() + 4 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const row = (id) => db.prepare('SELECT * FROM service_bookings WHERE id=?').get(id);
const tokenOf = (viewPath) => new URL('http://x' + viewPath).searchParams.get('t');
let ip = 0;
const book = (body = {}) => api('POST', `/api/services/${serviceId}/book`, { body: { ...GUEST, paymentMethod: 'trove', ...body }, headers: { 'x-forwarded-for': `198.51.100.${(++ip % 250) + 1}` } });
const act = (id, body) => api('PATCH', `/api/provider/bookings/${id}`, { cookie: providerCookie, body });
const setStatus = (status) => api('PATCH', `/api/admin/providers/${providerId}`, { cookie: adminCookie, body: { status } });
let evt = 0;
const paidEvent = (bk) => ({
  id: `evt_f4_${++evt}`, type: 'payment_intent.succeeded',
  data: { object: { id: bk.stripe_payment_intent_id, amount: bk.amount_cents, amount_received: bk.amount_cents, metadata: { kind: 'service_booking', booking_id: String(bk.id), code: bk.code } } },
});

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api; mock = ctx.stripeMock;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin-f4@test.local', ?, 'Admin', 'admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('admin-f4@test.local', 'adminpass123');
  const r = await api('POST', '/api/services/apply', { body: APPLY });
  providerCookie = r.headers.get('set-cookie').split(';')[0];
  providerId = db.prepare("SELECT id FROM service_providers WHERE slug='lina-walls'").get().id;
  await setStatus('approved');
  const s = await api('POST', '/api/provider/services', { cookie: providerCookie, body: { title: 'Gallery wall', category: 'workshops', priceCents: 40000, priceType: 'fixed', setting: 'home' } });
  serviceId = s.data.service.id;
});
after(async () => { await ctx.close(); });

async function confirmedTrove() {
  const r = await book();
  const id = r.data.booking.id;
  const c = await act(id, { action: 'confirm', serviceDate: dayFromNow(3) });
  assert.equal(c.status, 200);
  return { id, code: r.data.booking.code, t: tokenOf(r.data.booking.viewPath) };
}

test('F070: a booking whose service date has passed cannot be paid', async () => {
  const b = await confirmedTrove();
  db.prepare('UPDATE service_bookings SET service_date=? WHERE id=?').run(dayFromNow(-2), b.id);
  const view = await api('GET', `/api/services/booking/${b.code}?t=${b.t}`);
  assert.equal(view.data.booking.canPay, false);
  assert.equal(view.data.booking.payBlocked, 'date_passed');
  const pay = await api('POST', `/api/services/booking/${b.code}/pay`, { body: { t: b.t } });
  assert.equal(pay.status, 409);
  assert.match(pay.data.error, /service date .* has passed/);
});

test('F070: the sweep closes unpaid bookings past their date and stale requests', async () => {
  const svc = require('../src/service-bookings');
  const past = await confirmedTrove();
  db.prepare('UPDATE service_bookings SET service_date=? WHERE id=?').run(dayFromNow(-1), past.id);
  const future = await confirmedTrove();

  const fresh = (await book()).data.booking.id;
  const waiting = (await book()).data.booking.id;
  db.prepare("UPDATE service_bookings SET created_at=datetime('now','-3 days') WHERE id=?").run(waiting);
  const old = (await book()).data.booking.id;
  db.prepare("UPDATE service_bookings SET created_at=datetime('now','-8 days') WHERE id=?").run(old);

  mock.reset();
  const out = await svc.sweepStale();
  assert.ok(out.expired >= 1 && out.reminded >= 1 && out.closed >= 1, JSON.stringify(out));

  assert.equal(row(past.id).status, 'cancelled');
  assert.equal(row(past.id).cancelled_by, 'expired');
  assert.ok(mock.calls.some((c) => c.method === 'paymentIntents.cancel' && c.params.id === row(past.id).stripe_payment_intent_id), 'the pay link is closed on Stripe');
  assert.equal(row(future.id).status, 'awaiting_payment', 'a future date is left alone');

  assert.equal(row(fresh).status, 'requested');
  assert.equal(row(fresh).reminded_at, null, 'a new request is not chased');
  assert.equal(row(waiting).status, 'requested');
  assert.ok(row(waiting).reminded_at, 'the provider is reminded after two days');
  assert.equal(row(old).status, 'declined');
  assert.equal(row(old).cancelled_by, 'expired');

  const again = await svc.sweepStale();
  assert.equal(again.reminded, 0, 'a reminder goes once');
  assert.equal(again.expired + again.closed, 0, 'nothing closes twice');

  // A payment that lands after the sweep closed the booking is refunded.
  const bk = row(past.id);
  mock.reset();
  svc.onPaymentSucceeded(paidEvent(bk));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(row(past.id).refunded_at || mock.calls.some((c) => c.method === 'refunds.create'), 'late money goes back');
});

test('F071: a suspended provider cannot confirm or be paid; suspending closes open requests', async () => {
  const awaiting = await confirmedTrove();
  const requested = (await book()).data.booking.id;
  const paid = await confirmedTrove();
  require('../src/service-bookings').onPaymentSucceeded(paidEvent(row(paid.id)));
  assert.ok(row(paid.id).paid_at);

  const s = await setStatus('suspended');
  assert.equal(s.status, 200);
  assert.ok(s.data.closedUnpaid >= 2, 'the requests and unpaid bookings are closed');
  assert.equal(s.data.confirmedOpen, 1, 'the paid booking is counted for the admin');
  assert.equal(row(requested).status, 'cancelled');
  assert.equal(row(awaiting.id).status, 'cancelled');

  // A request that reaches a suspended provider (made just before) can't be confirmed.
  db.prepare("INSERT INTO service_bookings (code, service_id, provider_id, name, email, phone, area, payment_method, title, price_cents, price_type, status) VALUES ('SRV-F4F4F4', ?, ?, 'X', 'x@test.local', '+971500000000', 'Dubai', 'trove', 'Gallery wall', 40000, 'fixed', 'requested')").run(serviceId, providerId);
  const sneaky = db.prepare("SELECT id FROM service_bookings WHERE code='SRV-F4F4F4'").get().id;
  const c = await act(sneaky, { action: 'confirm', serviceDate: dayFromNow(3) });
  assert.equal(c.status, 403, 'confirm refused while suspended');
  assert.equal(row(sneaky).status, 'requested');
  assert.equal((await act(sneaky, { action: 'decline', reason: '' })).status, 200, 'decline still works');

  // An unpaid booking that slipped through can't be paid while suspended.
  db.prepare("UPDATE service_bookings SET status='awaiting_payment', stripe_payment_intent_id='pi_f4_test', amount_cents=40000, service_date=? WHERE id=?").run(dayFromNow(3), sneaky);
  const svc = require('../src/service-bookings');
  assert.equal((await svc.paymentSession(row(sneaky))).status, 409);
  assert.equal(svc.forCustomer(row(sneaky)).payBlocked, 'provider_unavailable');

  mock.reset();
  const cb = await api('POST', `/api/admin/providers/${providerId}/cancel-bookings`, { cookie: adminCookie, body: {} });
  assert.equal(cb.status, 200);
  assert.equal(cb.data.cancelled, 1);
  assert.equal(cb.data.refunded, 1);
  assert.equal(row(paid.id).status, 'cancelled');
  assert.ok(row(paid.id).refunded_at);
  assert.ok(mock.calls.some((c2) => c2.method === 'refunds.create'));

  await setStatus('approved');
  assert.equal((await api('POST', `/api/admin/providers/${providerId}/cancel-bookings`, { cookie: adminCookie, body: {} })).status, 409, 'only for a suspended or rejected provider');
});
