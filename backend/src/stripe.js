'use strict';
/**
 * Stripe client. The server still boots without a key so you can explore the
 * non-payment routes; anything touching Connect/checkout throws a clear error.
 */
const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
const stripe = key ? new Stripe(key) : null;

function requireStripe() {
  if (!stripe) {
    const e = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in .env');
    e.status = 503;
    throw e;
  }
  return stripe;
}

module.exports = { stripe, requireStripe };
