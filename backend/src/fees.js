'use strict';
/**
 * Central fee configuration — the single source of truth for the marketplace's
 * money rules. Every amount is in fils (integer minor units of AED), and each
 * value can be overridden from the environment without touching code.
 *
 *   PLATFORM_FEE_PERCENT           Trove's cut of each shop's sales (BOTH payout types)
 *   SERVICE_FEE_CENTS              flat buyer service fee, per order
 *   DELIVERY_FEE_CENTS             flat buyer delivery fee, per order ...
 *   FREE_DELIVERY_THRESHOLD_CENTS  ... waived once the cart subtotal reaches this
 */
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const fees = {
  PLATFORM_FEE_PERCENT: num(process.env.PLATFORM_FEE_PERCENT, 10),
  SERVICE_FEE_CENTS: num(process.env.SERVICE_FEE_CENTS, 900), // AED 9.00
  DELIVERY_FEE_CENTS: num(process.env.DELIVERY_FEE_CENTS, 2500), // AED 25.00
  FREE_DELIVERY_THRESHOLD_CENTS: num(process.env.FREE_DELIVERY_THRESHOLD_CENTS, 50000), // AED 500.00
};

// Delivery is free once the cart subtotal reaches the threshold.
fees.deliveryFor = (subtotalCents) =>
  subtotalCents >= fees.FREE_DELIVERY_THRESHOLD_CENTS ? 0 : fees.DELIVERY_FEE_CENTS;

// Split a shop's gross sales into Trove's fee and the shop's net payout.
// Used identically by the live transfer (connect) and the weekly run (managed)
// so the two payout paths always round the same way.
fees.split = (grossCents) => {
  const fee = Math.round((grossCents * fees.PLATFORM_FEE_PERCENT) / 100);
  return { fee, net: grossCents - fee };
};

module.exports = fees;
