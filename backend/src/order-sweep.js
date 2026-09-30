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
 * If the PaymentIntent can't be cancelled because it has been paid (or is
 * mid-payment), the order is left alone — the payment webhook completes it.
 * If a payment still lands on an order this sweep cancelled, the webhook
 * refunds it automatically (see app.js, attention='paid_after_cancel').
 */
const db = require('./db');

const CANCELLABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture']);

async function sweepUnpaid({ olderThanHours = 24, stripe = require('./stripe').getStripe() } = {}) {
  const rows = db.prepare(`SELECT id, public_id, stripe_payment_intent_id FROM orders
    WHERE status='pending' AND created_at <= datetime('now', ?) ORDER BY id LIMIT 500`).all(`-${Number(olderThanHours)} hours`);
  let cancelled = 0, skipped = 0;
  for (const o of rows) {
    if (stripe && o.stripe_payment_intent_id) {
      try {
        await stripe.paymentIntents.cancel(o.stripe_payment_intent_id, { cancellation_reason: 'abandoned' });
      } catch (e) {
        // Already cancelled → fine; paid or mid-payment → leave it to the webhook.
        let status = '';
        try { status = (await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id)).status; } catch (_) { /* try again next hour */ }
        if (status !== 'canceled') {
          skipped++;
          if (!status || CANCELLABLE.has(status)) console.error(`unpaid sweep: could not cancel ${o.stripe_payment_intent_id} for ${o.public_id}:`, e.message);
          continue;
        }
      }
    }
    cancelled += db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(o.id).changes;
  }
  return { cancelled, skipped };
}

module.exports = { sweepUnpaid };
