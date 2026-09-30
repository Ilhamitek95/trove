'use strict';
/**
 * Services Marketplace — card payment for bookings paid through Trove
 * (src/service-bookings.js + src/service-credits.js), against the Stripe mock.
 *
 * The load-bearing rules under test:
 *   - 'trove' is accepted only while the SERVER has a Stripe client
 *   - confirm fixes the amount (listed price, or the provider's final price
 *     for from/hourly) + the service date and opens ONE PaymentIntent
 *   - the webhook marks the booking paid exactly once, snapshots the 10%
 *     split from the amount paid, credits the provider, releases the phone
 *   - completion (or 3 days after the service date) makes the credit payable
 *   - a paid booking that is cancelled — by anyone — is refunded in full; a
 *     payment landing after a decline is refunded automatically
 *   - the guest link only works with the right token, and is never cached
 *   - direct bookings are unchanged: no PaymentIntent, no credit
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, mock, adminCookie, providerCookie, providerId;
const svcIds = {};

const APPLY = {
  name: 'Noor Studio', email: 'noor@test.local', password: 'testpass123',
  providerName: 'Noor Frames', categories: ['workshops'], location: 'Dubai, UAE',
  about: 'Framing and gallery walls at your place.', experience: '3+ years',
  instagram: '@noorframes', links: '', phone: '+971 50 111 2233', agreeSub: true, agreeTerms: true,
};
const GUEST = { name: 'Sara Guest', email: 'sara@test.local', phone: '050 222 3344', area: 'Dubai', preferredDate: 'next week', notes: 'Six frames.', agreeTerms: true };

const dayFromNow = (n) => new Date(Date.now() + 4 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const row = (id) => db.prepare('SELECT * FROM service_bookings WHERE id=?').get(id);
const credit = (id) => db.prepare("SELECT * FROM provider_credits WHERE booking_id=? AND type='credit_service'").get(id);
const tokenOf = (viewPath) => new URL('http://x' + viewPath).searchParams.get('t');
const until = async (fn, ms = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
let evt = 0;
const paidEvent = (bk, over = {}) => ({
  id: `evt_svc_${++evt}`, type: 'payment_intent.succeeded',
  data: { object: { id: bk.stripe_payment_intent_id, amount: bk.amount_cents, amount_received: bk.amount_cents, metadata: { kind: 'service_booking', booking_id: String(bk.id), code: bk.code } } },
  ...over,
});
let bookN = 0; // one address per request: the booking limiter allows 10 an hour
const book = (serviceId, body = {}, cookie) => api('POST', `/api/services/${serviceId}/book`, { body: { ...GUEST, paymentMethod: 'trove', ...body }, cookie, headers: { 'x-forwarded-for': `192.0.2.${(++bookN % 250) + 1}` } });
const act = (id, body) => api('PATCH', `/api/provider/bookings/${id}`, { cookie: providerCookie, body });

before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api; mock = ctx.stripeMock;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@test.local', ?, 'Admin', 'admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
  const r = await api('POST', '/api/services/apply', { body: APPLY });
  providerCookie = r.headers.get('set-cookie').split(';')[0];
  providerId = db.prepare("SELECT id FROM service_providers WHERE slug='noor-frames'").get().id;
  await api('PATCH', `/api/admin/providers/${providerId}`, { cookie: adminCookie, body: { status: 'approved' } });
  for (const [key, priceCents, priceType] of [['fixed', 40000, 'fixed'], ['hourly', 15000, 'hourly'], ['from', 50000, 'from']]) {
    const s = await api('POST', '/api/provider/services', { cookie: providerCookie, body: { title: `Gallery wall (${key})`, category: 'workshops', priceCents, priceType, setting: 'home' } });
    svcIds[key] = s.data.service.id;
  }
});
after(async () => { await ctx.close(); });

/* ---------------- the server gate ---------------- */

test('paying through Trove is refused while the server has no Stripe client', async () => {
  const saved = process.env.STRIPE_MOCK;
  process.env.STRIPE_MOCK = '0';
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.data.serviceCardPayments, false);
    const r = await book(svcIds.fixed);
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'payments_off');
    assert.equal((await book(svcIds.fixed, { paymentMethod: 'direct' })).status, 201, 'direct still works');
  } finally { process.env.STRIPE_MOCK = saved; }
  assert.equal((await api('GET', '/api/config')).data.serviceCardPayments, true);
});

/* ---------------- the full lifecycle ---------------- */

let life; // the fixed-price booking followed end to end
test('a trove request charges nothing and gives the guest a private link', async () => {
  mock.reset();
  const r = await book(svcIds.fixed);
  assert.equal(r.status, 201);
  assert.ok(r.data.booking.viewPath.startsWith(`/services/booking/${r.data.booking.code}?t=`));
  life = { id: r.data.booking.id, code: r.data.booking.code, token: tokenOf(r.data.booking.viewPath) };
  assert.equal(mock.calls.length, 0, 'no Stripe call at request time');

  const view = await api('GET', `/api/services/booking/${life.code}?t=${life.token}`);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('cache-control'), 'no-store');
  assert.equal(view.data.booking.status, 'requested');
  assert.equal(view.data.booking.canPay, false);
  assert.equal(view.data.booking.canCancel, true);
  assert.ok(!JSON.stringify(view.data).includes('050'), 'the link view carries no phone');

  for (const t of ['', 'nope', life.token.replace(/.$/, (c) => (c === '0' ? '1' : '0'))]) {
    assert.equal((await api('GET', `/api/services/booking/${life.code}?t=${t}`)).status, 404, `token "${t}" is refused`);
  }
  const page = await api('GET', `/services/booking/${life.code}?t=${life.token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await api('GET', `/services/pay/${life.code}-${life.token}`)).status, 200);
});

test('confirming a trove booking needs a service date and opens one PaymentIntent', async () => {
  assert.equal((await act(life.id, { action: 'confirm' })).status, 400, 'date required');
  assert.equal((await act(life.id, { action: 'confirm', serviceDate: dayFromNow(-2) })).status, 400, 'not in the past');
  assert.equal((await act(life.id, { action: 'confirm', serviceDate: dayFromNow(2), priceCents: 99900 })).status, 400, 'a fixed price is fixed');
  mock.reset();
  const r = await act(life.id, { action: 'confirm', serviceDate: dayFromNow(2) });
  assert.equal(r.status, 200);
  assert.equal(r.data.booking.status, 'awaiting_payment');
  assert.equal(r.data.booking.phone, null, 'the phone waits for the payment');
  assert.equal(r.data.booking.paid, false);
  const creates = mock.calls.filter((c) => c.method === 'paymentIntents.create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].params.amount, 40000);
  assert.equal(creates[0].params.currency, 'aed');
  assert.equal(creates[0].params.metadata.kind, 'service_booking');
  assert.equal(creates[0].params.metadata.booking_id, String(life.id));
  assert.equal(creates[0].params.transfer_data, undefined, 'charged on Trove’s own account');
  const bk = row(life.id);
  assert.equal(bk.amount_cents, 40000);
  assert.equal(bk.commission_cents, 4000);
  assert.equal(bk.provider_net_cents, 36000);
  assert.ok(bk.stripe_payment_intent_id);
  assert.equal((await act(life.id, { action: 'confirm', serviceDate: dayFromNow(2) })).status, 409, 'confirm once');
});

test('the pay link hands the card form its client secret — with the right token only', async () => {
  const bad = await api('POST', `/api/services/booking/${life.code}/pay`, { body: { t: 'x'.repeat(32) } });
  assert.equal(bad.status, 404);
  const r = await api('POST', `/api/services/booking/${life.code}/pay`, { body: { t: life.token } });
  assert.equal(r.status, 200);
  assert.equal(r.data.amountCents, 40000);
  assert.ok(r.data.clientSecret.startsWith(row(life.id).stripe_payment_intent_id + '_secret'));
  const view = await api('GET', `/api/services/booking/${life.code}?t=${life.token}`);
  assert.equal(view.data.booking.canPay, true);
});

test('the webhook marks it paid once, credits the provider and releases the phone', async () => {
  const bk = row(life.id);
  const ev = paidEvent(bk);
  assert.equal((await ctx.postWebhook(ev)).status, 200);
  let after = row(life.id);
  assert.equal(after.status, 'confirmed');
  assert.ok(after.paid_at);
  assert.equal(after.commission_cents, 4000);
  assert.equal(after.provider_net_cents, 36000);
  assert.equal(credit(life.id).amount_cents, 36000);

  // redelivery, and a new event id for the same payment: both no-ops
  await ctx.postWebhook(ev);
  await ctx.postWebhook(paidEvent(bk));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM provider_credits WHERE booking_id=?').get(life.id).c, 1);
  assert.equal(row(life.id).paid_at, after.paid_at);

  const pv = await api('GET', '/api/provider/bookings', { cookie: providerCookie });
  const mine = pv.data.bookings.find((b) => b.id === life.id);
  assert.equal(mine.paid, true);
  assert.equal(mine.phone, '+971502223344');
  assert.ok(!JSON.stringify(pv.data).includes('sara@test.local'), 'never the email');
  const pay = await api('POST', `/api/services/booking/${life.code}/pay`, { body: { t: life.token } });
  assert.equal(pay.status, 409, 'a paid booking has nothing more to pay');
});

test('a product-order webhook path is untouched by a booking payment', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c, 0);
});

test('the credit becomes payable when the provider marks the booking done', async () => {
  const credits = require('../src/service-credits');
  assert.equal(credits.eligibleServiceCredits().length, 0, 'not before the service');
  const done = await act(life.id, { action: 'complete' });
  assert.equal(done.data.booking.status, 'completed');
  const later = db.prepare("SELECT datetime('now','+1 minute') AS t").get().t;
  const rows = credits.eligibleServiceCredits(later);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_cents, 36000);
  // the settlement run shows it; with no payout details it is held back, not lost
  const pv = require('../src/settlement').preview(later).serviceCredits;
  assert.equal(pv.excluded.length, 1);
  assert.equal(pv.excluded[0].reason, 'payout_details_missing');
  assert.equal(pv.excluded[0].netCents, 36000);
  const me = await api('GET', '/api/provider/me', { cookie: providerCookie });
  assert.equal(me.data.provider.earnings.payableCents + me.data.provider.earnings.pendingCents, 36000);
  const adm = await api('GET', '/api/admin/service-credits', { cookie: adminCookie });
  assert.equal(adm.status, 200);
});

test('a booking nobody marked done is payable 3 days after its service date', async () => {
  const credits = require('../src/service-credits');
  const r = await book(svcIds.fixed);
  await act(r.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(1) });
  await ctx.postWebhook(paidEvent(row(r.data.booking.id)));
  const ids = (t) => credits.eligibleServiceCredits(t).map((c) => c.booking_id);
  assert.ok(!ids(`${dayFromNow(3)} 00:00:00`).includes(r.data.booking.id), 'day 2 after: not yet');
  assert.ok(ids(`${dayFromNow(4)} 00:00:00`).includes(r.data.booking.id), 'day 3 after: payable');
});

test('admin marks a provider paid; a refund after that debits their next payment', async () => {
  const credits = require('../src/service-credits');
  const later = `${dayFromNow(10)} 00:00:00`;
  const paid = credits.markPaid(providerId, 'Trove service fees — test', later);
  assert.equal(paid.amountCents, 36000 + 36000);
  assert.ok(credit(life.id).paid_at);
  mock.reset();
  const r = await api('POST', `/api/admin/service-bookings/${life.id}/refund`, { cookie: adminCookie, body: {} });
  assert.equal(r.status, 200);
  const refunds = mock.calls.filter((c) => c.method === 'refunds.create');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].params.payment_intent, row(life.id).stripe_payment_intent_id);
  assert.equal(refunds[0].params.amount, undefined, 'in full');
  assert.ok(row(life.id).refunded_at);
  assert.equal(row(life.id).status, 'completed', 'a dispute refund keeps the history');
  const debit = db.prepare("SELECT * FROM provider_credits WHERE booking_id=? AND type='debit_refund'").get(life.id);
  assert.equal(debit.amount_cents, -36000);
  assert.equal((await api('POST', `/api/admin/service-bookings/${life.id}/refund`, { cookie: adminCookie, body: {} })).status, 409);
  const list = await api('GET', '/api/admin/service-bookings', { cookie: adminCookie });
  assert.ok(list.data.bookings.some((b) => b.code === life.code && b.refundedAt));
});

/* ---------------- final price for from / hourly ---------------- */

test('hourly and from listings need the provider’s final price at confirm', async () => {
  const h = await book(svcIds.hourly);
  assert.equal((await act(h.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(3) })).status, 400);
  const ok = await act(h.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(3), priceCents: 45000 });
  assert.equal(ok.status, 200);
  assert.equal(row(h.data.booking.id).amount_cents, 45000);
  assert.equal(row(h.data.booking.id).provider_net_cents, 40500);

  const f = await book(svcIds.from);
  const low = await act(f.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(3), priceCents: 40000 });
  assert.equal(low.status, 400, 'never below the starting price');
  assert.equal((await act(f.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(3), priceCents: 65000 })).status, 200);
});

/* ---------------- cancellations and refunds ---------------- */

test('a paid booking cannot be declined — cancelling it refunds in full and voids the credit', async () => {
  const r = await book(svcIds.fixed);
  const id = r.data.booking.id;
  await act(id, { action: 'confirm', serviceDate: dayFromNow(5) });
  await ctx.postWebhook(paidEvent(row(id)));
  assert.equal(row(id).status, 'confirmed');
  assert.equal((await act(id, { action: 'decline' })).status, 409);
  mock.reset();
  const c = await act(id, { action: 'cancel', reason: 'Unwell that week' });
  assert.equal(c.status, 200);
  assert.equal(c.data.booking.status, 'cancelled');
  assert.equal(c.data.booking.phone, null);
  assert.equal(mock.calls.filter((x) => x.method === 'refunds.create').length, 1);
  assert.ok(row(id).refunded_at);
  assert.equal(row(id).refund_cents, 40000);
  assert.equal(row(id).cancelled_by, 'provider');
  assert.ok(credit(id).voided_at, 'nothing is owed to the provider');
});

test('the guest cancels through the link: unpaid closes the intent, paid refunds in full', async () => {
  const a = await book(svcIds.fixed);
  const aTok = tokenOf(a.data.booking.viewPath);
  await act(a.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(4) });
  assert.equal((await api('POST', `/api/services/booking/${a.data.booking.code}/cancel`, { body: { t: 'wrong' } })).status, 404);
  mock.reset();
  const ca = await api('POST', `/api/services/booking/${a.data.booking.code}/cancel`, { body: { t: aTok } });
  assert.equal(ca.status, 200);
  assert.equal(ca.data.refunded, false);
  assert.equal(row(a.data.booking.id).status, 'cancelled');
  assert.ok(await until(() => mock.calls.some((x) => x.method === 'paymentIntents.cancel')), 'the pay link is closed');

  const b = await book(svcIds.fixed);
  const bTok = tokenOf(b.data.booking.viewPath);
  await act(b.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(4) });
  await ctx.postWebhook(paidEvent(row(b.data.booking.id)));
  const cb = await api('POST', `/api/services/booking/${b.data.booking.code}/cancel`, { body: { t: bTok } });
  assert.equal(cb.status, 200);
  assert.equal(cb.data.refunded, true);
  assert.equal(cb.data.booking.refunded, true);
  assert.equal(row(b.data.booking.id).cancelled_by, 'customer');
});

test('the customer cannot cancel on the service day', async () => {
  const r = await book(svcIds.fixed);
  await act(r.data.booking.id, { action: 'confirm', serviceDate: dayFromNow(1) });
  db.prepare('UPDATE service_bookings SET service_date=? WHERE id=?').run(dayFromNow(0), r.data.booking.id);
  const c = await api('POST', `/api/services/booking/${r.data.booking.code}/cancel`, { body: { t: tokenOf(r.data.booking.viewPath) } });
  assert.equal(c.status, 409);
  const view = await api('GET', r.data.booking.viewPath.replace('/services/booking/', '/api/services/booking/'));
  assert.equal(view.data.booking.canCancel, false);
});

test('a payment that lands after the provider declined is refunded automatically', async () => {
  const r = await book(svcIds.fixed);
  const id = r.data.booking.id;
  await act(id, { action: 'confirm', serviceDate: dayFromNow(6) });
  const bk = row(id);
  assert.equal((await act(id, { action: 'decline', reason: 'Double-booked' })).status, 200);
  mock.reset();
  await ctx.postWebhook(paidEvent(bk));
  assert.ok(await until(() => row(id).refunded_at), 'refunded');
  assert.equal(row(id).status, 'declined');
  assert.equal(row(id).attention, 'paid_after_cancel');
  assert.equal(credit(id), undefined, 'never credited');
});

test('a failed refund flags the booking for a person', async () => {
  const r = await book(svcIds.fixed);
  const id = r.data.booking.id;
  await act(id, { action: 'confirm', serviceDate: dayFromNow(6) });
  await ctx.postWebhook(paidEvent(row(id)));
  const real = mock.refunds.create;
  mock.refunds.create = async () => { throw new Error('card_declined'); };
  try {
    const c = await act(id, { action: 'cancel' });
    assert.equal(c.status, 200);
  } finally { mock.refunds.create = real; }
  assert.equal(row(id).attention, 'refund_failed');
  assert.equal(row(id).refunded_at, null);
  const list = await api('GET', '/api/admin/service-bookings', { cookie: adminCookie });
  assert.equal(list.data.bookings[0].attention, 'refund_failed', 'attention first');
  // the admin retry goes through and clears the flag
  const retry = await api('POST', `/api/admin/service-bookings/${id}/refund`, { cookie: adminCookie, body: {} });
  assert.equal(retry.status, 200);
  assert.equal(row(id).attention, '');
});

test('a listing with a paid booking cannot be deleted, only hidden', async () => {
  const r = await api('DELETE', `/api/provider/services/${svcIds.fixed}`, { cookie: providerCookie });
  assert.equal(r.status, 409);
});

/* ---------------- direct mode is unchanged ---------------- */

test('direct bookings: no PaymentIntent, no credit, phone on confirm', async () => {
  mock.reset();
  const r = await book(svcIds.hourly, { paymentMethod: 'direct' });
  const c = await act(r.data.booking.id, { action: 'confirm' });
  assert.equal(c.status, 200);
  assert.equal(c.data.booking.status, 'confirmed');
  assert.equal(c.data.booking.phone, '+971502223344');
  assert.equal(mock.calls.length, 0);
  assert.equal(credit(r.data.booking.id), undefined);
  assert.equal(row(r.data.booking.id).commission_cents, 0);
});

/* ---------------- emails ---------------- */

test('every booking email renders, names the booking and keeps to the copy rules', () => {
  const email = require('../src/email');
  const { copyViolation } = require('../src/copy-rules');
  const bk = { ...row(life.id), provider_name: 'Noor Frames' };
  const ctx2 = { booking: bk, viewUrl: 'https://x/v', payUrl: 'https://x/p', commissionPercent: 10 };
  const all = {
    bookingRequestReceived: email.bookingRequestReceived(ctx2),
    bookingNewRequest: email.bookingNewRequest(ctx2),
    bookingConfirmedPay: email.bookingConfirmedPay(ctx2),
    bookingConfirmedDirect: email.bookingConfirmedDirect({ ...ctx2, booking: { ...bk, payment_method: 'direct' } }),
    bookingPaid: email.bookingPaid(ctx2),
    bookingPaidProvider: email.bookingPaidProvider(ctx2),
    bookingCancelled: email.bookingCancelled({ ...ctx2, kind: 'cancelled', by: 'customer', refunded: true }),
    bookingDeclined: email.bookingCancelled({ ...ctx2, kind: 'declined' }),
    bookingCancelledProvider: email.bookingCancelledProvider(ctx2),
    bookingRefunded: email.bookingRefunded(ctx2),
  };
  for (const [name, m] of Object.entries(all)) {
    assert.ok(m.subject.includes(bk.code) || m.subject.includes(bk.title), `${name} subject names the booking`);
    assert.equal(copyViolation(m.html), null, `${name} copy`);
    assert.ok(!m.html.includes('an order you placed'), `${name} footer`);
  }
  assert.match(all.bookingPaidProvider.html, /AED 360/);
  assert.match(all.bookingPaidProvider.subject, /Paid through Trove/);
  assert.ok(all.bookingConfirmedPay.html.includes('https://x/p'));
  assert.ok(all.bookingRequestReceived.html.includes('https://x/v'));
  assert.ok(!all.bookingNewRequest.html.includes('sara@test.local'), 'the provider never gets the email');
  assert.ok(!all.bookingNewRequest.html.includes('502223344'), 'nor the phone before payment');
});

/* ---------------- copy: launch fee + honest payment status ---------------- */

test('the provider dashboard shows the fee as free during launch, never a running subscription', async () => {
  const me = await api('GET', '/api/provider/me', { cookie: providerCookie });
  assert.equal(me.data.provider.subscription.freeDuringLaunch, true);
  assert.equal(me.data.provider.subscription.startedAt, undefined);
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'docs', f), 'utf8');
  const panel = read('provider-panel.js');
  assert.match(panel, /Awaiting the customer’s card payment/);
  assert.match(panel, /if \(b\.paid\) return `<span class="pp-paid">Paid through Trove/, 'paid wording only once paid');
  assert.doesNotMatch(panel, /Running since/);
  for (const f of ['trove-apply.html', 'trove-seller.html', 'trove-services.html']) {
    assert.match(read(f), /30 days/, `${f} gives the notice period`);
  }
  const agreement = fs.readFileSync(path.join(__dirname, '..', 'legal', `provider-agreement-${require('../src/config').PROVIDER_AGREEMENT_VERSION}.md`), 'utf8');
  assert.match(agreement, /free during\s+launch/);
  assert.match(agreement, /30 days/);
  const services = read('trove-services.html');
  assert.doesNotMatch(services, /arriving with (our )?card payments|Coming with Trove’s card payments/);
  assert.match(services, /serviceCardPayments/, 'the booking form asks the server');
});

test('a payment event can never touch a booking that has no PaymentIntent of its own', async () => {
  const r = await book(svcIds.fixed);
  const bk = row(r.data.booking.id);
  assert.equal(bk.stripe_payment_intent_id, null);
  await ctx.postWebhook(paidEvent(bk)); // id: null, like a misrouted event
  await ctx.postWebhook(paidEvent({ ...bk, stripe_payment_intent_id: 'pi_someone_else' }));
  const after = row(bk.id);
  assert.equal(after.paid_at, null);
  assert.equal(after.status, 'requested');
});
