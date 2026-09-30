'use strict';
/**
 * Central fee configuration — the single source of truth for the marketplace's
 * money rules. Every amount is in fils (integer minor units of AED), and each
 * value can be overridden from the environment without touching code.
 *
 *   COMMISSION_PERCENT             Trove's purchase margin: on the consignment
 *                                  rail Trove buys each item from the supplier
 *                                  at list price minus this margin; on the
 *                                  connect rail it is the application fee.
 *   SERVICE_FEE_CENTS              flat buyer service fee, per order (0 — the
 *                                  2026-08 pricing has no service fee and no
 *                                  hidden costs; the column and plumbing stay
 *                                  so old orders still render correctly)
 *   DELIVERY_FEE_CENTS             flat buyer delivery fee, per order ...
 *   FREE_DELIVERY_THRESHOLD_CENTS  ... charged on orders AT OR BELOW this;
 *                                  waived once the cart subtotal exceeds it
 *   RETURN_WINDOW_DAYS             the buyer's return window, counted from
 *                                  delivery (15 — owner, 2026-09-30). The SAME
 *                                  number holds the maker's credit: a sale is
 *                                  payable only once this window has closed,
 *                                  so a return inside it never needs clawing
 *                                  back from a payout
 *   SETTLEMENT_INTERVAL_DAYS       how often the maker settlement run happens
 *                                  (14 = fortnightly, every other Tuesday)
 *   SETTLEMENT_ANCHOR_DATE         a fixed run Tuesday (YYYY-MM-DD); every run
 *                                  date is this plus a whole number of
 *                                  intervals, so the schedule is deterministic
 */
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const fees = {
  COMMISSION_PERCENT: num(process.env.COMMISSION_PERCENT ?? process.env.PLATFORM_FEE_PERCENT, 40),
  SERVICE_FEE_CENTS: num(process.env.SERVICE_FEE_CENTS, 0), // none — no hidden costs
  DELIVERY_FEE_CENTS: num(process.env.DELIVERY_FEE_CENTS, 3000), // AED 30.00
  FREE_DELIVERY_THRESHOLD_CENTS: num(process.env.FREE_DELIVERY_THRESHOLD_CENTS, 20000), // AED 200.00
  // Services marketplace: a flat monthly listing fee — FREE DURING LAUNCH
  // (owner, 2026-09-30; it starts later with 30 days' notice, nothing bills
  // it yet). Bookings the customer settles directly with the provider carry
  // nothing else; on a booking paid THROUGH Trove by card Trove keeps a
  // platform fee and the provider's fee is the remainder.
  PROVIDER_SUB_FEE_CENTS: num(process.env.PROVIDER_SUB_FEE_CENTS, 3000), // AED 30.00 / month
  SERVICE_COMMISSION_PERCENT: num(process.env.SERVICE_COMMISSION_PERCENT, 10),
  // Returns + maker payouts (owner, 2026-09-30: 'bi-weekly shop payments
  // with 15 days return policy').
  RETURN_WINDOW_DAYS: num(process.env.RETURN_WINDOW_DAYS, 15),
  SETTLEMENT_INTERVAL_DAYS: num(process.env.SETTLEMENT_INTERVAL_DAYS, 14),
  SETTLEMENT_ANCHOR_DATE: /^\d{4}-\d{2}-\d{2}$/.test(process.env.SETTLEMENT_ANCHOR_DATE || '')
    ? process.env.SETTLEMENT_ANCHOR_DATE : '2026-10-06', // a Tuesday
  // Delivery time (owner, 2026-09-30: 'handmade things take longer'). Each
  // piece carries its maker's make/pack time (products.lead_days, whole
  // calendar days); the buyer's estimate is that time plus the courier's
  // window below. A 2-day piece therefore shows 3–6 days, as before.
  COURIER_TRANSIT_MIN_DAYS: num(process.env.COURIER_TRANSIT_MIN_DAYS, 1),
  COURIER_TRANSIT_MAX_DAYS: num(process.env.COURIER_TRANSIT_MAX_DAYS, 4),
  LEAD_DAYS_DEFAULT: 2,  // every existing piece, until its maker says otherwise
  LEAD_DAYS_MIN: 1,
  LEAD_DAYS_MAX: 42,     // made to order: up to six weeks
};

// Deprecated alias — old readers still get the same number.
fees.PLATFORM_FEE_PERCENT = fees.COMMISSION_PERCENT;

// Delivery is charged on orders at or below the threshold, free above it.
fees.deliveryFor = (subtotalCents) =>
  subtotalCents > fees.FREE_DELIVERY_THRESHOLD_CENTS ? 0 : fees.DELIVERY_FEE_CENTS;

// Split a gross sale amount into Trove's margin and the supplier's purchase
// price. Both rails use this one function so they always round the same way.
fees.split = (grossCents) => {
  const fee = Math.round((grossCents * fees.COMMISSION_PERCENT) / 100);
  return { fee, net: grossCents - fee };
};

// A booking paid through Trove: the platform fee and the provider's fee.
fees.serviceSplit = (grossCents) => {
  const fee = Math.round((grossCents * fees.SERVICE_COMMISSION_PERCENT) / 100);
  return { fee, net: grossCents - fee };
};

module.exports = fees;
