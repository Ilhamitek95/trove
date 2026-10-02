'use strict';
/**
 * Which Seller Agreement a shop is on, and whether its pieces may be sold.
 *
 * Every Seller Agreement says a new version applies to a maker's future
 * sales only once they accept it. The code applies one set of money terms to
 * everyone (40% margin, fortnightly runs, payable after the buyer's 15-day
 * return window), and those terms first appear in v4
 * (config.AGREEMENT_MIN_SELLING_VERSION). A shop that accepted an OLDER
 * version (v1–v3 promised weekly runs and a 7-day hold) has not agreed to
 * them, so its pieces are off sale — hidden from the catalogue and refused
 * at checkout — until it accepts the current version from its dashboard
 * (POST /api/seller/agreement). A shop on v4 when v5 arrives keeps selling:
 * v5 keeps v4's money terms (margin, fortnightly runs, the hold) and spells
 * out checks v4 already required (identity that is "your own, current and
 * truthful", verified before settlement), so the dashboard asks them to
 * accept without taking their pieces off sale. If a lawyer reads the
 * expired-ID pause as a new payment term, raise the minimum to v5.
 *
 * Not covered here: a shop with no accepted agreement at all (never got to
 * payout setup). That is the onboarding gate's business, not this one.
 * The Trove Collection (house shop) has no agreement and is never paused.
 */
const cfg = require('./config');

/** 'v4' → 4; anything unreadable → 0 (treated as the oldest). */
const versionNumber = (v) => {
  const m = /^v(\d+)$/i.exec(String(v == null ? '' : v).trim());
  return m ? Number(m[1]) : 0;
};

const minSelling = () => versionNumber(cfg.AGREEMENT_MIN_SELLING_VERSION);

/** True when the shop's accepted agreement still lets its pieces be sold. */
function canSell(shop) {
  if (!shop) return false;
  if (shop.is_house) return true;
  if (!shop.agreement_accepted_at) return true;
  return versionNumber(shop.agreement_version) >= minSelling();
}

/**
 * The same rule as SQL, for the catalogue and checkout queries. `alias` is
 * the shops table alias in the query. The minimum is a code constant (never
 * user input), so it is safe to inline.
 */
function sellableSql(alias = 's') {
  return `(${alias}.is_house = 1 OR ${alias}.agreement_accepted_at IS NULL`
    + ` OR CAST(SUBSTR(COALESCE(${alias}.agreement_version, ''), 2) AS INTEGER) >= ${minSelling()})`;
}

// What changed in each version, in a line, for the dashboard's prompt.
const CHANGES = {
  v4: 'pays you fortnightly, every other Tuesday, once the buyer’s return window has closed',
  v5: 'names the company behind Trove (Serein Consultancy LLC), states the licence threshold, and sets out the identity check (settlements pause while an Emirates ID has expired), the pickup details and how long you see a buyer’s address; margin, fortnightly runs and the return window do not change',
};
const changeNote = (version) => CHANGES[version] || '';

module.exports = { versionNumber, canSell, sellableSql, changeNote };
