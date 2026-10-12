'use strict';
/**
 * Stripe client. The server still boots without a key so you can explore the
 * non-payment routes; anything touching checkout/Connect throws a clear error.
 * STRIPE_MOCK=1 swaps in the in-process mock (used by the test suite) — the
 * client is resolved at call time, so tests set env before their first call.
 *
 * Production fails CLOSED (F211): with NODE_ENV=production (or an explicit
 * PAYMENTS_REQUIRED=1) payments are expected, so STRIPE_MOCK is ignored, the
 * server refuses to start without STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
 * (assertPaymentsConfigured, called by server.js at boot), and the checkout
 * never falls back to the free demo-payments mode.
 */
const Stripe = require('stripe');

// The API version the SDK (stripe@16.12.0) sends by default — pinned so a
// future SDK upgrade can't silently change what every call means (F444).
const API_VERSION = '2024-06-20';

let real = null;

/** True where real payments are expected: production, or PAYMENTS_REQUIRED=1. */
const paymentsRequired = () => process.env.NODE_ENV === 'production' || process.env.PAYMENTS_REQUIRED === '1';

function getStripe() {
  if (process.env.STRIPE_MOCK === '1' && !paymentsRequired()) return require('./stripe-mock');
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!real) real = new Stripe(key, { apiVersion: API_VERSION });
  return real;
}

function requireStripe() {
  const s = getStripe();
  if (!s) {
    const e = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in .env');
    e.status = 503;
    throw e;
  }
  return s;
}

/** What is missing for real payments where they are required ([] = fine). */
function missingPaymentConfig() {
  if (!paymentsRequired()) return [];
  return ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((k) => !String(process.env[k] || '').trim());
}

/** Boot guard (server.js): refuse to start a production server that would take orders without payment. */
function assertPaymentsConfigured() {
  const missing = missingPaymentConfig();
  if (missing.length) {
    throw new Error(`Refusing to start: ${missing.join(' and ')} must be set in production — without them checkout would hand out unpaid orders. Set them on Render (or unset NODE_ENV / PAYMENTS_REQUIRED for local work).`);
  }
}

/**
 * A refund Trove already made on this PaymentIntent that matches `metadata`
 * (every key/value must be equal), or null. Stripe idempotency keys only last
 * 24 hours, so a retry after a crash between Stripe's answer and the local
 * save looks for its own earlier refund before making a second one (F225).
 * A failed lookup returns null (the caller still sends its idempotency key).
 */
async function findRefund(stripe, paymentIntent, metadata) {
  if (!stripe || !paymentIntent || !stripe.refunds || typeof stripe.refunds.list !== 'function') return null;
  try {
    const list = await stripe.refunds.list({ payment_intent: paymentIntent, limit: 100 });
    return (list.data || []).find((r) => !['failed', 'canceled'].includes(r.status)
      && r.metadata && Object.entries(metadata).every(([k, v]) => String(r.metadata[k]) === String(v))) || null;
  } catch (e) {
    console.warn(`refund lookup on ${paymentIntent} failed:`, e.message);
    return null;
  }
}

module.exports = { getStripe, requireStripe, paymentsRequired, missingPaymentConfig, assertPaymentsConfigured, findRefund, API_VERSION };
