'use strict';
/**
 * In-process Stripe stand-in for the test suite (STRIPE_MOCK=1). Implements
 * only the calls the app makes and records every one on `calls`, so tests can
 * assert on params (transfer_data.destination, application_fee_amount, the
 * 'custom' account type, refund params, …).
 *
 * webhooks.constructEvent does no signature check — tests POST plain JSON
 * events with an `id` field straight to /api/stripe/webhook.
 */
let n = 0;
const calls = [];
const intentStatus = new Map();
const refundsMade = [];

function record(method, params, result) {
  calls.push({ method, params });
  return result;
}

module.exports = {
  calls,
  reset() { calls.length = 0; intentStatus.clear(); refundsMade.length = 0; },
  setIntentStatus(id, status) { intentStatus.set(id, status); },

  paymentIntents: {
    create: async (params) => record('paymentIntents.create', params, {
      id: `pi_mock_${++n}`,
      client_secret: `pi_mock_${n}_secret_test`,
      ...params,
    }),
    // States are only tracked for intents a test marks via `setIntentStatus`;
    // anything else is an unpaid intent that can be cancelled.
    cancel: async (id, params) => {
      const st = intentStatus.get(id) || 'requires_payment_method';
      if (st === 'succeeded' || st === 'processing' || st === 'canceled') {
        record('paymentIntents.cancel', { id, ...params }, null);
        const e = new Error(`You cannot cancel this PaymentIntent because it has a status of ${st}.`);
        e.code = 'payment_intent_unexpected_state';
        throw e;
      }
      intentStatus.set(id, 'canceled');
      return record('paymentIntents.cancel', { id, ...params }, { id, status: 'canceled' });
    },
    // client_secret mirrors what create handed out (the pay page re-reads it).
    retrieve: async (id) => record('paymentIntents.retrieve', { id }, { id, client_secret: `${id}_secret_test`, status: intentStatus.get(id) || 'requires_payment_method' }),
  },
  refunds: {
    // `failNext` makes the next create throw (a declined/failed refund).
    create: async (params) => {
      if (module.exports.refunds.failNext) {
        const msg = module.exports.refunds.failNext;
        module.exports.refunds.failNext = null;
        record('refunds.create.failed', params, null);
        throw new Error(msg);
      }
      const r = record('refunds.create', params, { id: `re_mock_${++n}`, status: 'succeeded', metadata: {}, ...params });
      refundsMade.push(r);
      return r;
    },
    list: async (params) => record('refunds.list', params, {
      data: refundsMade.filter((r) => !params || !params.payment_intent || r.payment_intent === params.payment_intent),
      has_more: false,
    }),
    failNext: null,
  },
  /** Test hook: a refund made straight in the Stripe dashboard (no Trove metadata). */
  addExternalRefund(paymentIntent, amount) {
    const r = { id: `re_ext_${++n}`, payment_intent: paymentIntent, amount, status: 'succeeded', metadata: {} };
    refundsMade.push(r);
    return r;
  },
  transfers: {
    create: async (params) => record('transfers.create', params, { id: `tr_mock_${++n}`, ...params }),
  },
  accounts: {
    create: async (params) => record('accounts.create', params, { id: `acct_mock_${++n}`, type: params.type }),
    retrieve: async (id) => record('accounts.retrieve', { id }, {
      id, charges_enabled: true, payouts_enabled: true, details_submitted: true,
    }),
    createLoginLink: async (id) => record('accounts.createLoginLink', { id }, { url: `https://mock.stripe.local/login/${id}` }),
  },
  accountLinks: {
    create: async (params) => record('accountLinks.create', params, { url: `https://mock.stripe.local/onboard/${params.account}` }),
  },
  webhooks: {
    constructEvent: (rawBody) => JSON.parse(rawBody.toString()),
  },
};
