'use strict';
/**
 * Product category policy — the 2026 brand taxonomy, two pillars:
 *   - COLLECTION: the Trove Collection house line (designed by Trove)
 *   - MARKETPLACE: independent makers
 *
 * Trove purchases and resells everything on the consignment rail, so anything
 * ingestible or applied to skin is out — that class of goods carries
 * regulatory duties (municipality registration, labelling, liability) a
 * reseller of handmade goods must not take on. "Wellness & Self-Care" and
 * "Candles & Home Fragrance" therefore cover non-ingestible, non-skin-contact
 * goods only; the PROHIBITED patterns below still refuse the banned classes.
 */
const COLLECTION = [
  'Kitchen & Dining',
  'Decorative Accessories',
  'Storage & Organisation',
  'Textiles',
  'Candles & Home Fragrance',
  'Seasonal Collections',
];

const MARKETPLACE = [
  'Home & Living',
  'Wall Art & Prints',
  'Ceramics',
  'Stationery',
  'Jewellery',      // non-piercing
  'Personalised Gifts',
  "Children's",
  'Pet Accessories',
  'Wellness & Self-Care', // eye pillows, wheat bags — never skincare or ingestibles
  'Accessories',
  'Seasonal',
  'Handmade Crafts',
];

const ALLOWED = [...COLLECTION, ...MARKETPLACE];

// Case-insensitive patterns for goods Trove will not purchase for resale.
const PROHIBITED = [
  /food|beverage|drink|snack|edible|ingest/i,
  /cosmetic|skincare|skin\s*care|soap|balm|lotion|perfume|beauty/i,
  /supplement|vitamin|remedy|medicin/i,
];

/**
 * Returns null when the category is acceptable, otherwise an Error with
 * .status = 422 and a buyer-safe message. Pass { house: true } for the
 * Trove Collection house line — each pillar validates against its own list.
 */
function categoryError(category, opts) {
  const cat = String(category || '').trim();
  const err = (msg) => Object.assign(new Error(msg), { status: 422 });
  if (!cat) return err('A product category is required.');
  if (PROHIBITED.some((re) => re.test(cat))) {
    return err(`Trove doesn't stock ${cat.toLowerCase()} — nothing ingestible or applied to the skin can be listed. See the seller agreement for the full policy.`);
  }
  const list = opts && opts.house === true ? COLLECTION
    : opts && opts.house === false ? MARKETPLACE
    : ALLOWED;
  if (!list.includes(cat)) {
    const which = opts && opts.house === true ? 'the Trove Collection' : opts && opts.house === false ? 'the Trove Marketplace' : 'Trove';
    return err(`"${cat}" isn't one of ${which}'s categories. Choose one of: ${list.join(', ')}.`);
  }
  return null;
}

module.exports = { ALLOWED, COLLECTION, MARKETPLACE, categoryError };
