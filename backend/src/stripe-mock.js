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

function record(method, params, result) {
  calls.push({ method, params });
  return result;
}

module.exports = {
  calls,
  reset() { calls.length = 0; },

  paymentIntents: {
    create: async (params) => record('paymentIntents.create', params, {
      id: `pi_mock_${++n}`,
      client_secret: `pi_mock_${n}_secret_test`,
      ...params,
    }),
  },
  refunds: {
    create: async (params) => record('refunds.create', params, { id: `re_mock_${++n}`, ...params }),
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
