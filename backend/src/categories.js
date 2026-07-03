'use strict';
/**
 * Product category policy. Trove purchases and resells everything on the
 * consignment rail, so anything ingestible or applied to skin is out — that
 * class of goods carries regulatory duties (municipality registration,
 * labelling, liability) a reseller of handmade goods must not take on.
 *
 * The allowlist is the single source of truth; the PROHIBITED patterns exist
 * to give a clear, specific error for the categories we deliberately refuse.
 */
const ALLOWED = [
  'Ceramics',
  'Home',        // decor, trays, planters, candles WITHOUT skin-contact claims
  'Apparel',
  'Textiles',
  'Art',
  'Woodwork',
  'Jewelry',     // non-piercing
  'Stationery',
  'Accessories',
];

// Case-insensitive patterns for goods Trove will not purchase for resale.
const PROHIBITED = [
  /food|beverage|drink|snack|edible|ingest/i,
  /cosmetic|skincare|skin\s*care|soap|balm|lotion|perfume|beauty/i,
  /supplement|vitamin|remedy|medicin/i,
];

/**
 * Returns null when the category is acceptable, otherwise an Error with
 * .status = 422 and a buyer-safe message.
 */
function categoryError(category) {
  const cat = String(category || '').trim();
  const err = (msg) => Object.assign(new Error(msg), { status: 422 });
  if (!cat) return err('A product category is required.');
  if (PROHIBITED.some((re) => re.test(cat))) {
    return err(`Trove doesn't stock ${cat.toLowerCase()} — nothing ingestible or applied to the skin can be listed. See the seller agreement for the full policy.`);
  }
  if (!ALLOWED.includes(cat)) {
    return err(`"${cat}" isn't one of Trove's categories. Choose one of: ${ALLOWED.join(', ')}.`);
  }
  return null;
}

module.exports = { ALLOWED, categoryError };
