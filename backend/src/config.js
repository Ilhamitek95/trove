'use strict';
/**
 * Feature flags + business rules for the two-rail payment architecture.
 * Everything env-driven is read at CALL time (not module load) so the test
 * suite can flip a flag mid-file without re-requiring the world. The one
 * exception is RETURN_WINDOW_DAYS below, copied from fees.js at load.
 *
 *   RAIL_B_ENABLED           '1'/'true' switches on the Connect graduation rail
 *   VAT_REGISTERED           '1'/'true' once Trove is VAT-registered (5% capture)
 *   GRADUATION_THRESHOLD_AED trailing-30-day paid settlements that flag a
 *                            supplier for graduation (default 12000)
 */
const on = (v) => v === '1' || v === 'true';

// Seller Agreement. v5 (2026-10-02) names the contracting company (Serein
// Consultancy LLC, whose brands Trove and Trove at Home are) and states the
// licence threshold; the money terms are v4's.
// v6 (2026-10-26): makers may be based in Dubai, Abu Dhabi or Sharjah (pickup
// and home address in one of the three; customers still Dubai + Abu Dhabi
// only), and section 5 describes the Didit identity check (Emirates ID scan +
// live selfie) next to the licence and photo routes. Money terms unchanged,
// so v4/v5 shops keep selling and are only prompted to accept v6.
// v7 (2026-10-27): customers in Sharjah can buy too, so section 1 says Trove
// resells to customers in Dubai, Abu Dhabi and Sharjah (no longer 'does not
// deliver to Sharjah'). Nothing else changed — money terms are v4's, so
// v4/v5/v6 shops keep selling and are only prompted to accept v7.
const AGREEMENT_VERSION = 'v7';
// The oldest Seller Agreement whose terms the code actually applies (40%
// margin, fortnightly runs, payable after the 15-day return window). A shop
// that accepted an OLDER version (v1–v3: weekly runs, 7-day hold) has not
// agreed to those terms, so its pieces cannot be sold until it accepts the
// current version (src/agreements.js). Raise this only when a new version
// changes terms the code enforces.
const AGREEMENT_MIN_SELLING_VERSION = 'v4';
// Services Marketplace legal documents (backend/legal/*). Bump on any change
// and add a new file — accepted versions are recorded on profiles/bookings.
// v3 (2026-10-02): names Serein Consultancy LLC as the contracting company
// and the payer of provider fees; liability cap no longer zero while listing
// is free, and never limits paying over fees Trove collected.
// v4 (2026-10-12, F343): the customer's mobile is released once the booking
// is SECURED — on confirm for a direct booking, on payment for a card booking
// — as the Services Terms and the code already said (v3 said 'on confirm').
// Nothing else changed; v3 acceptances stand (no re-acceptance gate).
// v5 (2026-10-26): providers may be based in Dubai, Abu Dhabi or Sharjah;
// bookings still come only from customers in Dubai + Abu Dhabi, and a Sharjah
// provider travels to them. Earlier acceptances stand (no re-acceptance gate).
// v6 (2026-10-27): bookings are taken from customers in Dubai, Abu Dhabi and
// Sharjah; the Sharjah-provider travel line is gone. Nothing else changed;
// earlier acceptances stand (no re-acceptance gate).
const PROVIDER_AGREEMENT_VERSION = 'v6';
// v2 (2026-09-30): card payment for bookings, private booking links, full
// refund on cancelling a paid booking before the service date.
// v3 (2026-10-02): names the contracting company. Nothing else changed.
const SERVICES_TERMS_VERSION = 'v3';
// Buyer-facing documents (backend/legal/buyer-terms-*.md, privacy-*.md),
// shown at /terms and /privacy. Same rule: a change is a new file + a bump.
// v2 (2026-09-30): the delivery clause — each piece shows its own estimate
// (the maker's stated make/pack time + the courier's 1–4 days) instead of a
// fixed 3–6 days. Nothing else changed.
// v3 (2026-10-02): names the contracting company, adds the 18+ eligibility
// line, and states the returns rules exactly as the code applies them (at
// least one photo; delivery charge refunded when the whole order comes back
// for a fault).
// v4 (2026-10-27): section 3 — Trove delivers to Dubai, Abu Dhabi and
// Sharjah (checkout accepts those three emirates). Nothing else changed;
// delivery is still AED 30 on orders of AED 200 and below, free above.
const BUYER_TERMS_VERSION = 'v4';
// v2 (2026-10-02): names the controller (Serein Consultancy LLC) and the
// payer of provider fees, drops the saved-card line (there is no saved card),
// lists the Emirates ID digits and dates, and states retention periods and
// the export / close-and-anonymise process exactly as src/privacy.js runs them.
// v3 (2026-10-15): the Didit identity check — what Didit does, what Trove
// keeps from it (name on the ID, last four digits, dates, pass/fail and
// reasons; never the images, selfie, full number or date of birth), explicit
// consent as the basis, Didit among the services we share with, retention.
const PRIVACY_VERSION = 'v3';
// One number (fees.RETURN_WINDOW_DAYS, 15 by default) is both the buyer's
// return window and the maker's settlement hold — the two names are kept so
// older readers keep working, but they can no longer drift apart.
const RETURN_WINDOW_DAYS = require('./fees').RETURN_WINDOW_DAYS;
const BUYER_RETURN_DAYS = RETURN_WINDOW_DAYS;

module.exports = {
  AGREEMENT_VERSION,
  AGREEMENT_MIN_SELLING_VERSION,
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
