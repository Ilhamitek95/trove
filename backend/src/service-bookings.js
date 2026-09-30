'use strict';
/**
 * Services Marketplace — the booking lifecycle and card payment for bookings
 * paid through Trove.
 *
 *   requested ──confirm──▶ confirmed                        (direct)
 *   requested ──confirm──▶ awaiting_payment ──webhook──▶ confirmed (trove, paid)
 *   confirmed ──complete──▶ completed
 *   requested | awaiting_payment ──decline──▶ declined       (provider)
 *   requested | awaiting_payment | confirmed ──cancel──▶ cancelled
 *
 * For a 'trove' booking Trove is the customer's contracting party and engages
 * the provider as an independent contractor: the customer pays Trove the
 * booking amount by card, Trove keeps fees.SERVICE_COMMISSION_PERCENT and owes
 * the provider the rest (a provider_credits row, paid in the settlement run —
 * see service-credits.js). Nothing is charged at request time: the provider
 * confirms with the final amount and the service date, a PaymentIntent opens
 * and the customer pays through a private link.
 *
 * Guests have no account, so every booking has a signed link (an HMAC of the
 * booking id + code — never stored, re-derivable for any email):
 *   /services/booking/<code>?t=<token>   view + cancel
 *   /services/pay/<code>-<token>         pay (once the provider confirmed)
 *
 * Money-moving rules:
 *   - card payments for bookings exist only when the SERVER has a Stripe
 *     client (secret key, or the test mock) — never on the client's say-so
 *   - the webhook marks a booking paid once (webhook_events, one transaction)
 *   - a paid booking that is declined or cancelled is refunded in full,
 *     automatically; a failed refund flags the booking for a person
 */
const crypto = require('crypto');
const db = require('./db');
const fees = require('./fees');

const paymentsEnabled = () => !!require('./stripe').getStripe();
const CURRENCY = () => process.env.CURRENCY || 'aed';

/* ---------------- signed guest links ---------------- */

const linkSecret = () => process.env.BOOKING_LINK_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';
function linkToken(bk) {
  return crypto.createHmac('sha256', linkSecret()).update(`svc-booking:${bk.id}:${bk.code}`).digest('hex').slice(0, 32);
}
function tokenOk(bk, token) {
  const want = Buffer.from(linkToken(bk));
  const got = Buffer.from(String(token || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const SITE = () => (process.env.PUBLIC_URL || String(process.env.CLIENT_URL || process.env.RENDER_EXTERNAL_URL || '').split(',')[0] || 'https://troveathome.com')
  .trim().replace(/\/+$/, '');
const viewUrl = (bk) => `${SITE()}/services/booking/${bk.code}?t=${linkToken(bk)}`;
const payUrl = (bk) => `${SITE()}/services/pay/${bk.code}-${linkToken(bk)}`;
const PAY_REF = /^(SRV-[0-9A-F]{6})-([0-9a-f]{32})$/;

/** A booking by its code, if the token matches — else null. */
function byCodeAndToken(code, token) {
  const bk = db.prepare('SELECT * FROM service_bookings WHERE code = ?').get(String(code || '').toUpperCase());
  return bk && tokenOk(bk, token) ? bk : null;
}

/* ---------------- dates ---------------- */

// The calendar day in Dubai (UTC+4, no daylight saving).
const dubaiToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
function serviceDateError(v, { required }) {
  const s = String(v || '').trim();
  if (!s) return required ? 'Set the date of the service' : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return 'The service date must be a real date';
  if (s < dubaiToday()) return 'The service date can’t be in the past';
  const max = new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10);
  if (s > max) return 'The service date must be within the next year';
  return null;
}
/** Before the service day (Dubai time)? A booking with no agreed date counts as before. */
const beforeService = (bk) => !bk.service_date || dubaiToday() < bk.service_date;

/* ---------------- amounts ---------------- */

/** The amount a 'trove' booking charges: the listed price for a fixed-price
 *  listing; the provider's final price (required) for 'from' / 'hourly'. */
function confirmAmount(bk, priceCents) {
  const given = priceCents === undefined || priceCents === null || priceCents === '' ? null : Math.round(Number(priceCents));
  if (bk.price_type === 'fixed') {
    if (given != null && given !== bk.price_cents) return { error: 'This is a fixed-price service — the listed price is the booking price' };
    return { amount: bk.price_cents };
  }
  if (given == null) {
    return { error: bk.price_type === 'hourly'
      ? 'Set the final price for this booking (hours × your hourly rate)'
      : 'Set the final price for this booking' };
  }
  if (!Number.isFinite(given) || given < 100 || given > 10000000) return { error: 'Set a final price between AED 1 and AED 100,000' };
  if (bk.price_type === 'from' && given < bk.price_cents) return { error: `The final price can’t be below your starting price of AED ${(bk.price_cents / 100).toLocaleString('en-GB')}` };
  return { amount: given };
}

/* ---------------- lookups ---------------- */

const get = (id) => db.prepare('SELECT * FROM service_bookings WHERE id = ?').get(id);
function withProvider(bk) {
  return db.prepare(`SELECT bk.*, p.name AS provider_name, p.slug AS provider_slug, u.email AS provider_email
    FROM service_bookings bk JOIN service_providers p ON p.id = bk.provider_id JOIN users u ON u.id = p.user_id
    WHERE bk.id = ?`).get(bk.id || bk);
}

/* ---------------- email (fire-and-forget) ---------------- */

function mail(kind, bk, extra = {}) {
  try {
    const email = require('./email');
    const row = withProvider(bk);
    if (!row) return;
    const ctx = { booking: row, viewUrl: viewUrl(row), payUrl: payUrl(row), commissionPercent: fees.SERVICE_COMMISSION_PERCENT, ...extra };
    const send = (to, msg) => email.send({ to, ...msg }).catch((e) => console.error(`booking email (${kind}) failed:`, e.message));
    switch (kind) {
      case 'requested':
        send(row.email, email.bookingRequestReceived(ctx));
        send(row.provider_email, email.bookingNewRequest(ctx));
        break;
      case 'confirmed':
        send(row.email, row.payment_method === 'trove' ? email.bookingConfirmedPay(ctx) : email.bookingConfirmedDirect(ctx));
        break;
      case 'paid':
        send(row.email, email.bookingPaid(ctx));
        send(row.provider_email, email.bookingPaidProvider(ctx));
        break;
      case 'declined':
      case 'cancelled':
        send(row.email, email.bookingCancelled({ ...ctx, kind }));
        if (kind === 'cancelled' && extra.by !== 'provider') send(row.provider_email, email.bookingCancelledProvider(ctx));
        break;
      case 'refunded':
        send(row.email, email.bookingRefunded(ctx));
        break;
      default:
    }
  } catch (e) { console.error(`booking email (${kind}) failed:`, e.message); }
}

/* ---------------- confirm ---------------- */

/**
 * The provider confirms a request. Direct: straight to 'confirmed'. Trove:
 * the final amount + service date are fixed, a PaymentIntent opens on
 * Trove's account, and the booking waits in 'awaiting_payment'.
 * Returns { booking } or { status, error }.
 */
async function confirm(bk, { priceCents, serviceDate } = {}) {
  if (bk.status !== 'requested') return { status: 409, error: 'Only a new request can be confirmed' };
  const trove = bk.payment_method === 'trove';
  const dateErr = serviceDateError(serviceDate, { required: trove });
  if (dateErr) return { status: 400, error: dateErr };
  const date = String(serviceDate || '').trim() || null;

  if (!trove) {
    const r = db.prepare(`UPDATE service_bookings SET status='confirmed', confirmed_at=datetime('now'),
        service_date=COALESCE(?, service_date) WHERE id=? AND status='requested'`).run(date, bk.id);
    if (!r.changes) return { status: 409, error: 'Only a new request can be confirmed' };
    mail('confirmed', bk);
    return { booking: get(bk.id) };
  }

  const amt = confirmAmount(bk, priceCents);
  if (amt.error) return { status: 400, error: amt.error };
  const stripe = require('./stripe').getStripe();
  if (!stripe) return { status: 409, error: 'Card payments are switched off right now — ask the customer to settle directly, or contact Trove' };
  const intent = await stripe.paymentIntents.create({
    amount: amt.amount,
    currency: CURRENCY(),
    automatic_payment_methods: { enabled: true },
    description: `Trove booking ${bk.code}`,
    receipt_email: bk.email,
    metadata: { kind: 'service_booking', booking_id: String(bk.id), code: bk.code },
  }, { idempotencyKey: `trove-svc-confirm-${bk.id}-${amt.amount}` });
  const split = fees.serviceSplit(amt.amount);
  const r = db.prepare(`UPDATE service_bookings SET status='awaiting_payment', confirmed_at=datetime('now'),
      amount_cents=?, service_date=?, stripe_payment_intent_id=?, commission_cents=?, provider_net_cents=?
    WHERE id=? AND status='requested'`).run(amt.amount, date, intent.id, split.fee, split.net, bk.id);
  if (!r.changes) {
    // Cancelled in the meantime: the intent was never shown to anyone.
    stripe.paymentIntents.cancel(intent.id).catch(() => {});
    return { status: 409, error: 'Only a new request can be confirmed' };
  }
  mail('confirmed', bk);
  return { booking: get(bk.id) };
}

/* ---------------- payment (webhook) ---------------- */

/**
 * payment_intent.succeeded with metadata.kind = 'service_booking'. One
 * transaction holds the idempotency guard and every database effect: a
 * redelivered event changes nothing. A payment that lands after the booking
 * was declined or cancelled is refunded in full straight away.
 */
function onPaymentSucceeded(event) {
  const pi = event.data.object;
  const result = db.transaction(() => {
    const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?,?)').run(event.id, event.type);
    if (!seen.changes) return null;
    const bk = get(Number(pi.metadata && pi.metadata.booking_id));
    if (!bk || !pi.id || !bk.stripe_payment_intent_id || bk.stripe_payment_intent_id !== pi.id || bk.paid_at) return null;
    const amount = Number(pi.amount_received || pi.amount) || bk.amount_cents;
    const split = fees.serviceSplit(amount);
    if (bk.status === 'awaiting_payment') {
      db.prepare(`UPDATE service_bookings SET status='confirmed', paid_at=datetime('now'), amount_cents=?,
          commission_cents=?, provider_net_cents=? WHERE id=?`).run(amount, split.fee, split.net, bk.id);
      require('./service-credits').creditBooking(get(bk.id));
      return { kind: 'paid', id: bk.id };
    }
    // Declined or cancelled while the customer was paying: nothing to deliver.
    if (!['declined', 'cancelled'].includes(bk.status)) return null;
    db.prepare(`UPDATE service_bookings SET paid_at=datetime('now'), amount_cents=?, commission_cents=?, provider_net_cents=?,
        attention='paid_after_cancel' WHERE id=?`).run(amount, split.fee, split.net, bk.id);
    return { kind: 'refund', id: bk.id };
  })();
  if (!result) return null;
  if (result.kind === 'paid') mail('paid', get(result.id));
  else refund(get(result.id), { reason: 'paid_after_cancel', notify: 'refunded' });
  return result;
}

/* ---------------- refunds ---------------- */

/**
 * Refund a paid booking in full (Stripe first — if that fails nothing local
 * changes but the attention flag). The provider's unpaid credit is voided;
 * one already paid out is mirrored by a debit on their next run.
 * Resolves true when refunded.
 */
async function refund(bk, { reason = 'cancelled', notify = null } = {}) {
  if (!bk || !bk.paid_at || bk.refunded_at) return false;
  const stripe = require('./stripe').getStripe();
  if (!stripe || !bk.stripe_payment_intent_id) {
    db.prepare("UPDATE service_bookings SET attention='refund_failed' WHERE id=?").run(bk.id);
    console.error(`booking ${bk.code}: REFUND NOT POSSIBLE (no Stripe client) — refund by hand`);
    return false;
  }
  try {
    await stripe.refunds.create({
      payment_intent: bk.stripe_payment_intent_id,
      metadata: { booking_id: String(bk.id), code: bk.code, reason },
    }, { idempotencyKey: `trove-svc-refund-${bk.id}` });
  } catch (e) {
    db.prepare("UPDATE service_bookings SET attention='refund_failed' WHERE id=?").run(bk.id);
    console.error(`booking ${bk.code}: AUTOMATIC REFUND FAILED — refund by hand in Stripe:`, e.message);
    return false;
  }
  db.transaction(() => {
    db.prepare(`UPDATE service_bookings SET refunded_at=COALESCE(refunded_at, datetime('now')), refund_cents=amount_cents,
        attention=CASE WHEN attention='refund_failed' THEN '' ELSE attention END WHERE id=?`).run(bk.id);
    require('./service-credits').reverseBooking(bk);
  })();
  if (notify) mail(notify, get(bk.id));
  return true;
}

/* ---------------- decline / cancel ---------------- */

/** Close an unpaid intent so the pay link stops working (best effort). */
function cancelIntent(bk) {
  const stripe = require('./stripe').getStripe();
  if (!stripe || !bk.stripe_payment_intent_id || bk.paid_at) return;
  stripe.paymentIntents.cancel(bk.stripe_payment_intent_id).catch((e) => console.warn(`booking ${bk.code}: intent cancel:`, e.message));
}

/** The provider declines a new or unpaid request. */
function decline(bk, reason) {
  if (!['requested', 'awaiting_payment'].includes(bk.status)) return { status: 409, error: 'Only a new request can be declined' };
  const r = db.prepare("UPDATE service_bookings SET status='declined', decline_reason=? WHERE id=? AND status IN ('requested','awaiting_payment')")
    .run(String(reason || '').trim().slice(0, 500), bk.id);
  if (!r.changes) return { status: 409, error: 'Only a new request can be declined' };
  cancelIntent(bk);
  mail('declined', bk);
  return { booking: get(bk.id) };
}

/**
 * Cancel a booking (customer, provider or admin). Customers can cancel only
 * before the service day; a paid booking is refunded in full. Returns
 * { booking, refunded } or { status, error }; the refund is awaited so the
 * caller can say what happened.
 */
async function cancel(bk, { by, reason = '' }) {
  const open = by === 'provider' ? ['confirmed'] : ['requested', 'awaiting_payment', 'confirmed'];
  if (!open.includes(bk.status)) return { status: 409, error: 'This booking can no longer be cancelled' };
  if (by === 'customer' && !beforeService(bk)) {
    return { status: 409, error: 'The service day has arrived, so this booking can no longer be cancelled here — contact Trove if something went wrong' };
  }
  const r = db.prepare(`UPDATE service_bookings SET status='cancelled', cancelled_at=datetime('now'), cancelled_by=?,
      decline_reason=CASE WHEN ?<>'' THEN ? ELSE decline_reason END WHERE id=? AND status=?`)
    .run(by, String(reason).trim().slice(0, 500), String(reason).trim().slice(0, 500), bk.id, bk.status);
  if (!r.changes) return { status: 409, error: 'This booking can no longer be cancelled' };
  cancelIntent(bk);
  const refunded = bk.paid_at ? await refund(get(bk.id), { reason: `cancelled_by_${by}` }) : false;
  mail('cancelled', get(bk.id), { by, refunded });
  return { booking: get(bk.id), refunded };
}

/** Provider marks the booking done: the credit becomes payable. */
function complete(bk) {
  if (bk.status !== 'confirmed') return { status: 409, error: 'Only a confirmed booking can be marked done' };
  db.prepare("UPDATE service_bookings SET status='completed', completed_at=datetime('now') WHERE id=? AND status='confirmed'").run(bk.id);
  return { booking: get(bk.id) };
}

/* ---------------- the customer's view (guest link or account) ---------------- */

function forCustomer(bk) {
  const row = withProvider(bk);
  const paid = !!row.paid_at;
  return {
    id: row.id, code: row.code, status: row.status, title: row.title,
    providerName: row.provider_name, providerSlug: row.provider_slug,
    priceCents: row.price_cents, priceType: row.price_type,
    amountCents: row.amount_cents || 0,
    area: row.area, preferredDate: row.preferred_date, serviceDate: row.service_date || null,
    paymentMethod: row.payment_method, termsVersion: row.terms_version || '',
    declineReason: row.decline_reason || '', cancelledBy: row.cancelled_by || '',
    paid, paidAt: row.paid_at || null,
    refunded: !!row.refunded_at, refundCents: row.refund_cents || 0,
    canPay: row.status === 'awaiting_payment' && !paid && paymentsEnabled(),
    canCancel: ['requested', 'awaiting_payment', 'confirmed'].includes(row.status) && beforeService(row),
    createdAt: row.created_at,
  };
}

/** The client secret for the pay page, re-read from Stripe (never stored). */
async function paymentSession(bk) {
  if (bk.status !== 'awaiting_payment' || bk.paid_at || !bk.stripe_payment_intent_id) {
    return { status: 409, error: bk.paid_at ? 'This booking is already paid' : 'This booking isn’t waiting for a payment' };
  }
  const stripe = require('./stripe').getStripe();
  if (!stripe) return { status: 503, error: 'Card payments are unavailable right now — please try again later' };
  const pi = await stripe.paymentIntents.retrieve(bk.stripe_payment_intent_id);
  if (pi.status === 'succeeded' || pi.status === 'processing') return { status: 409, error: 'Your payment is already being processed — this page updates in a moment' };
  if (pi.status === 'canceled') return { status: 409, error: 'This payment link has expired — contact Trove' };
  return { clientSecret: pi.client_secret, amountCents: bk.amount_cents, currency: CURRENCY() };
}

module.exports = {
  paymentsEnabled, linkToken, tokenOk, viewUrl, payUrl, PAY_REF, byCodeAndToken,
  dubaiToday, serviceDateError, beforeService, confirmAmount,
  confirm, onPaymentSucceeded, refund, decline, cancel, complete, forCustomer, paymentSession, mail,
};
