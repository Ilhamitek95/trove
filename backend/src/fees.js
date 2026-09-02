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
  // Services marketplace: providers pay a flat monthly platform subscription;
  // Trove takes no commission on the service price itself.
  PROVIDER_SUB_FEE_CENTS: num(process.env.PROVIDER_SUB_FEE_CENTS, 3000), // AED 30.00 / month
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

module.exports = fees;
