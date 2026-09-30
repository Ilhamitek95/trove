'use strict';
/**
 * Feature flags + business rules for the two-rail payment architecture.
 * Everything env-driven is read at CALL time (not module load) so the test
 * suite can flip a flag mid-file without re-requiring the world.
 *
 *   RAIL_B_ENABLED           '1'/'true' switches on the Connect graduation rail
 *   VAT_REGISTERED           '1'/'true' once Trove is VAT-registered (5% capture)
 *   GRADUATION_THRESHOLD_AED trailing-30-day paid settlements that flag a
 *                            supplier for graduation (default 12000)
 */
const on = (v) => v === '1' || v === 'true';

const AGREEMENT_VERSION = 'v4';
// Services Marketplace legal documents (backend/legal/*). Bump on any change
// and add a new file — accepted versions are recorded on profiles/bookings.
const PROVIDER_AGREEMENT_VERSION = 'v2';
// v2 (2026-09-30): card payment for bookings, private booking links, full
// refund on cancelling a paid booking before the service date.
const SERVICES_TERMS_VERSION = 'v2';
// Buyer-facing documents (backend/legal/buyer-terms-*.md, privacy-*.md),
// shown at /terms and /privacy. Same rule: a change is a new file + a bump.
// v2 (2026-09-30): the delivery clause — each piece shows its own estimate
// (the maker's stated make/pack time + the courier's 1–4 days) instead of a
// fixed 3–6 days. Nothing else changed.
const BUYER_TERMS_VERSION = 'v2';
const PRIVACY_VERSION = 'v1';
// One number (fees.RETURN_WINDOW_DAYS, 15 by default) is both the buyer's
// return window and the maker's settlement hold — the two names are kept so
// older readers keep working, but they can no longer drift apart.
const RETURN_WINDOW_DAYS = require('./fees').RETURN_WINDOW_DAYS;
const BUYER_RETURN_DAYS = RETURN_WINDOW_DAYS;

module.exports = {
  AGREEMENT_VERSION,
  PROVIDER_AGREEMENT_VERSION,
  SERVICES_TERMS_VERSION,
  BUYER_TERMS_VERSION,
  PRIVACY_VERSION,
  RETURN_WINDOW_DAYS,
  BUYER_RETURN_DAYS,
  railBEnabled: () => on(process.env.RAIL_B_ENABLED || ''),
  vatRegistered: () => on(process.env.VAT_REGISTERED || ''),
  graduationThresholdCents: () => {
    const aed = Number(process.env.GRADUATION_THRESHOLD_AED);
    return (Number.isFinite(aed) && aed > 0 ? aed : 12000) * 100;
  },
  // UAE VAT is 5%; prices are VAT-inclusive, so the tax inside a gross amount
  // is 5/105 of it.
  vatFromGross: (cents) => Math.round((cents * 5) / 105),
};
