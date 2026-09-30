'use strict';
/**
 * The facts every help page states, in one place. Money comes from fees.js
 * (so an env override moves the pages with the checkout); the two policy
 * numbers below are the owner's decisions of 2026-09-30.
 */
const fees = require('../fees');

const aed = (cents) => {
  const n = cents / 100;
  return 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toFixed(2));
};

// Owner, 2026-09-30: buyers have 15 days from delivery to ask for a return
// (was 30), and makers are paid fortnightly, every other Tuesday (was weekly).
// Both read from fees.js, so the pages move with the code if either changes.
const RETURN_DAYS = fees.RETURN_WINDOW_DAYS;
const PAYOUT_RHYTHM = fees.SETTLEMENT_INTERVAL_DAYS === 14 ? 'fortnightly, every other Tuesday'
  : fees.SETTLEMENT_INTERVAL_DAYS === 7 ? 'weekly, every Tuesday'
    : `every ${fees.SETTLEMENT_INTERVAL_DAYS} days, on a Tuesday`;

function facts() {
  // Worked examples for the returns page: a piece worth three quarters of the
  // free-delivery threshold, alone and inside an order above it.
  const piece = Math.round((fees.FREE_DELIVERY_THRESHOLD_CENTS * 0.75) / 1000) * 1000;
  return {
    exPiece: aed(piece),
    exPieceLessFee: aed(Math.max(0, piece - fees.DELIVERY_FEE_CENTS)),
    exBigOrder: aed(fees.FREE_DELIVERY_THRESHOLD_CENTS + 6000),
    returnDays: RETURN_DAYS,
    payoutRhythm: PAYOUT_RHYTHM,
    deliveryFee: aed(fees.DELIVERY_FEE_CENTS),
    freeOver: aed(fees.FREE_DELIVERY_THRESHOLD_CENTS),
    commission: fees.COMMISSION_PERCENT,
    makerShare: 100 - fees.COMMISSION_PERCENT,
    providerSub: aed(fees.PROVIDER_SUB_FEE_CENTS),
    serviceCommission: fees.SERVICE_COMMISSION_PERCENT,
    providerPayer: require('../service-credits').payerName(), // who sends provider transfers (PROVIDER_PAYER_NAME)
    providerGraceDays: require('../service-credits').GRACE_DAYS,
    deliveryDays: '3–6 days',
    areas: 'Dubai and Abu Dhabi',
  };
}

module.exports = { facts, aed, RETURN_DAYS, PAYOUT_RHYTHM };
