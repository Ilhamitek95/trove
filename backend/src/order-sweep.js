'use strict';
/**
 * Unpaid checkout sweep. The storefront opens the order row and its Stripe
 * PaymentIntent as soon as the payment form mounts, so every abandoned
 * checkout leaves a 'pending' order behind. Those are never shown as orders
 * (admin, seller and buyer lists all skip 'pending'), and once they are a
 * day old this sweep closes them: the PaymentIntent is cancelled first (so
 * it can no longer be paid), then the order is marked 'cancelled'.
 *
 * Runs from the hourly job in server.js. With no Stripe key (demo mode) or a
 * demo order without a PaymentIntent there is nothing to cancel at Stripe.
 *
 * If the PaymentIntent can't be cancelled because it is mid-payment, the
 * order is left alone for the payment webhook. If it has SUCCEEDED, the
 * webhook clearly never landed, so the sweep completes the order itself and
 * emails the admin (recoverPaid; sweepPaidMissing does the same within the
 * first day, from 30 minutes after checkout).
 * If a payment still lands on an order this sweep cancelled, the webhook
 * refunds it automatically (see app.js, attention='paid_after_cancel').
 */
const db = require('./db');

const CANCELLABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture']);

async function sweepUnpaid({ olderThanHours = 24, stripe = require('./stripe').getStripe() } = {}) {
  const rows = db.prepare(`SELECT id, public_id, stripe_payment_intent_id FROM orders
    WHERE status='pending' AND created_at <= datetime('now', ?) ORDER BY id LIMIT 500`).all(`-${Number(olderThanHours)} hours`);
  let cancelled = 0, skipped = 0, recovered = 0;
  for (const o of rows) {
    if (stripe && o.stripe_payment_intent_id) {
      try {
        await stripe.paymentIntents.cancel(o.stripe_payment_intent_id, { cancellation_reason: 'abandoned' });
      } catch (e) {
        // Already cancelled → fine; paid or mid-payment → leave it to the webhook.
        let status = '';
        try { status = (await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id)).status; } catch (_) { /* try again next hour */ }
        if (status === 'succeeded') {
          // Paid, but the payment webhook never landed (wrong webhook secret,
          // endpoint moved, Stripe gave up retrying): complete it now.
          if (recoverPaid(o, stripe)) recovered++;
          else skipped++;
          continue;
        }
        if (status !== 'canceled') {
          skipped++;
          if (!status || CANCELLABLE.has(status)) console.error(`unpaid sweep: could not cancel ${o.stripe_payment_intent_id} for ${o.public_id}:`, e.message);
          continue;
        }
      }
    }
    cancelled += db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(o.id).changes;
  }
  return { cancelled, skipped, recovered };
}

/**
 * A pending order whose PaymentIntent has SUCCEEDED: the buyer paid, but the
 * webhook that turns it into an order never arrived. Complete it exactly as
 * the webhook would (same transaction + idempotency, event id
 * 'sweep-<pi id>' — the webhook's status guard makes a late real event a
 * no-op) and tell the admin, because a missed webhook usually means the
 * webhook secret or endpoint is wrong and every payment is affected.
 */
function recoverPaid(o, stripe) {
  const pe = require('./paid-effects');
  const result = pe.completePaid(o.id, `sweep-${o.stripe_payment_intent_id}`, 'sweep.payment_intent.succeeded', stripe);
  if (!result) return false;
  console.warn(`order ${o.public_id}: paid but never confirmed by the webhook — completed by the sweep`);
  require('./notify').adminAlert({
    subject: `Payment webhook missed — order ${o.public_id} completed by the hourly check`,
    title: 'A paid order was not confirmed by Stripe',
    kicker: `Order ${o.public_id}`,
    lines: [
      `The buyer paid for ${o.public_id}, but Stripe's payment message never reached Trove, so the order sat unconfirmed. The hourly check has now completed it (makers told, courier booked, receipt sent).`,
      'If this keeps happening, the webhook signing secret (STRIPE_WEBHOOK_SECRET on Render) or the webhook address in the Stripe dashboard is probably wrong — every payment is affected until it is fixed.',
    ],
  });
  return true;
}

/**
 * Hourly: pending orders between 30 minutes and a day old whose payment has
 * actually gone through (the webhook is late or lost). Older ones are
 * handled by sweepUnpaid, which also cancels the abandoned checkouts.
 */
async function sweepPaidMissing({ stripe = require('./stripe').getStripe(), minMinutes = 30 } = {}) {
  if (!stripe) return { checked: 0, recovered: 0 };
  const rows = db.prepare(`SELECT id, public_id, stripe_payment_intent_id FROM orders
    WHERE status='pending' AND stripe_payment_intent_id IS NOT NULL
      AND created_at <= datetime('now', ?) AND created_at > datetime('now', '-24 hours')
    ORDER BY id LIMIT 200`).all(`-${Number(minMinutes)} minutes`);
  let recovered = 0;
  for (const o of rows) {
    let status = '';
    try { status = (await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id)).status; } catch (_) { continue; }
    if (status === 'succeeded' && recoverPaid(o, stripe)) recovered++;
  }
  return { checked: rows.length, recovered };
}

/**
 * Pack-by reminders (owner, 2026-09-30), from the same hourly job. Every
 * paid shipment carries pack_by_at (the end of the Dubai day it should be
 * packed by — see src/lead-times.js). Still 'processing' and not handed to
 * the courier once that has passed →
 *   - the maker is emailed once (stamp pack_reminder_at), and
 *   - two days after it, the admin is emailed once (stamp pack_escalated_at).
 * The stamp is written BEFORE the email goes, so a slow or failed send can
 * never make it fire twice. Orders refunded or no longer paid are skipped.
 */
const ESCALATE_AFTER_DAYS = 2;
async function sweepPackBy({ now = null } = {}) {
  const notify = require('./notify');
  const at = now || db.prepare("SELECT datetime('now') AS t").get().t;
  const base = `FROM shipments sh JOIN orders o ON o.id = sh.order_id
    WHERE sh.status = 'processing' AND sh.ready_at IS NULL AND sh.packed_at IS NULL AND sh.pack_by_at IS NOT NULL
      AND o.status = 'paid' AND o.refunded_at IS NULL`;
  const due = db.prepare(`SELECT sh.id ${base} AND sh.pack_reminder_at IS NULL AND sh.pack_by_at < ?`).all(at);
  const late = db.prepare(`SELECT sh.id ${base} AND sh.pack_escalated_at IS NULL
    AND datetime(sh.pack_by_at, '+${ESCALATE_AFTER_DAYS} days') < ?`).all(at);
  const jobs = [];
  for (const { id } of due) {
    if (db.prepare("UPDATE shipments SET pack_reminder_at=datetime('now') WHERE id=? AND pack_reminder_at IS NULL").run(id).changes) jobs.push(notify.packReminder(id));
  }
  for (const { id } of late) {
    if (db.prepare("UPDATE shipments SET pack_escalated_at=datetime('now') WHERE id=? AND pack_escalated_at IS NULL").run(id).changes) jobs.push(notify.packOverdueAdmin(id));
  }
  await Promise.all(jobs);
  return { reminded: due.length, escalated: late.length };
}

/**
 * Courier upkeep, from the same hourly job (src/courier-ops.js): retry failed
 * bookings, flag parcels packed a day ago that no courier has collected, and
 * read the prepaid OTO wallet. Each step is independent — one failing never
 * stops the others.
 */
async function sweepCourier() {
  const courier = require('./courier-ops');
  const out = {};
  try { out.retried = await courier.retryBookings(); } catch (e) { console.error('courier retry sweep failed:', e.message); }
  try { out.uncollected = courier.flagUncollected(); } catch (e) { console.error('uncollected sweep failed:', e.message); }
  try { out.wallet = await courier.checkWallet(); } catch (e) { console.error('OTO wallet check failed:', e.message); }
  return out;
}

module.exports = { sweepUnpaid, sweepPaidMissing, sweepPackBy, sweepCourier, recoverPaid, ESCALATE_AFTER_DAYS };
