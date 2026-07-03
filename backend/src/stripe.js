'use strict';
/**
 * Stripe client. The server still boots without a key so you can explore the
 * non-payment routes; anything touching checkout/Connect throws a clear error.
 * STRIPE_MOCK=1 swaps in the in-process mock (used by the test suite) — the
 * client is resolved at call time, so tests set env before their first call.
 */
const Stripe = require('stripe');

let real = null;

function getStripe() {
  if (process.env.STRIPE_MOCK === '1') return require('./stripe-mock');
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!real) real = new Stripe(key);
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

module.exports = { getStripe, requireStripe };
