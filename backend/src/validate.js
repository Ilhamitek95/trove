'use strict';
/**
 * Input rules for everything a seller, provider or applicant writes that is
 * later shown to other people (the storefront, the admin panel, emails).
 *
 * The frontend escapes what it renders, but the server is the one place every
 * write passes through, so the dangerous shapes are refused here too:
 *   • short display fields (names, locations, titles) may not carry < or >
 *   • colours are strictly #RRGGBB (they are interpolated into CSS)
 *   • every free-text field has a length cap
 *   • money is finite, whole fils and inside a sane range
 *
 * Each checker returns an error message (UK English, ready for the UI) or
 * null when the value is fine.
 */

const MARKUP = /[<>]/;

const LIMITS = {
  shopName: 80,
  personName: 80,
  location: 80,
  bio: 2000,          // the application form already allows 2,000 characters
  productName: 120,
  description: 5000,
  pickupAddress: 240,
  serviceTitle: 90,
};

// AED 1 to AED 100,000, in fils.
const MIN_PRICE_CENTS = 100;
const MAX_PRICE_CENTS = 100000 * 100;
const MAX_STOCK = 100000;
const PRODUCT_STATUSES = ['live', 'draft', 'hidden'];

const hasMarkup = (v) => MARKUP.test(String(v == null ? '' : v));

/**
 * A short display text: trimmed, required unless `optional`, capped, no < >.
 * Returns { value } or { error }.
 */
function shortText(raw, { label, max, optional = false } = {}) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return optional ? { value: '' } : { error: `${label} can't be empty` };
  if (value.length > max) return { error: `${label} must be ${max} characters or fewer` };
  if (hasMarkup(value)) return { error: `${label} can't contain < or >` };
  return { value };
}

/** A longer free text: trimmed and capped (markup is escaped on output). */
function longText(raw, { label, max } = {}) {
  const value = String(raw == null ? '' : raw).trim();
  if (value.length > max) return { error: `${label} must be ${max.toLocaleString('en-GB')} characters or fewer` };
  return { value };
}

const isHexColour = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/**
 * AED amount (as the seller types it, e.g. "45" or 45.5) → fils.
 * Returns { cents } or { error }. `required: false` lets null/'' through as null.
 */
function priceCents(raw, { label = 'Price', required = true } = {}) {
  if (raw == null || raw === '') return required ? { error: `${label} is required` } : { cents: null };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (typeof raw === 'boolean' || !Number.isFinite(n)) return { error: `${label} must be a number` };
  const cents = Math.round(n * 100);
  if (cents < MIN_PRICE_CENTS) return { error: `${label} must be at least AED 1` };
  if (cents > MAX_PRICE_CENTS) return { error: `${label} can't be more than AED 100,000` };
  return { cents };
}

/** Whole units in stock: an integer from 0 to MAX_STOCK. */
function stockError(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (raw === '' || typeof raw === 'boolean' || !Number.isInteger(n)) return 'Stock must be a whole number';
  if (n < 0) return "Stock can't be negative";
  if (n > MAX_STOCK) return `Stock can't be more than ${MAX_STOCK.toLocaleString('en-GB')}`;
  return null;
}

/** Variant rows as the seller sends them: stock whole ≥ 0, an optional price override in range. */
function variantsError(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return 'Variants must be a list';
  for (const v of raw) {
    if (!v || typeof v !== 'object') return 'Each variant needs a stock number';
    if (v.stock != null && v.stock !== '') {
      const err = stockError(v.stock);
      if (err) return err;
    }
    if (v.priceCents != null && v.priceCents !== '' && Number(v.priceCents) !== 0) {
      const p = Math.round(Number(v.priceCents));
      if (!Number.isFinite(p) || p < MIN_PRICE_CENTS || p > MAX_PRICE_CENTS)
        return 'A variant price must be between AED 1 and AED 100,000';
    }
  }
  return null;
}

/** Option group names/values and extra names are shown to buyers: no < >. */
function optionsMarkupError(options) {
  if (!Array.isArray(options)) return null;
  for (const g of options) {
    if (!g || typeof g !== 'object') continue;
    if (hasMarkup(g.name)) return "Option names can't contain < or >";
    if (Array.isArray(g.values) && g.values.some(hasMarkup)) return "Option choices can't contain < or >";
  }
  return null;
}
function extrasMarkupError(extras) {
  if (!Array.isArray(extras)) return null;
  for (const e of extras) {
    if (!e || typeof e !== 'object') continue;
    if (hasMarkup(e.name)) return "Extra names can't contain < or >";
    const p = Number(e.priceCents);
    if (e.priceCents != null && e.priceCents !== '' && Number.isFinite(p) && p > MAX_PRICE_CENTS)
      return `The price for an extra can't be more than AED 100,000`;
  }
  return null;
}

const MIN_PASSWORD = 8;
const PASSWORD_ERROR = `Choose a password of at least ${MIN_PASSWORD} characters`;
const passwordError = (pw) => (typeof pw !== 'string' || pw.length < MIN_PASSWORD ? PASSWORD_ERROR : null);

/**
 * UAE IBAN: AE + 2 check digits + 3-digit bank code + 16-digit account
 * (23 characters), and the ISO 13616 mod-97 checksum must come out at 1.
 */
function ibanError(raw) {
  const iban = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!/^AE\d{21}$/.test(iban)) return 'Enter a valid UAE IBAN (AE followed by 21 digits)';
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  if (rem !== 1) return "That IBAN doesn't add up — please check it against your bank details";
  return null;
}

module.exports = {
  LIMITS, MIN_PRICE_CENTS, MAX_PRICE_CENTS, MAX_STOCK, PRODUCT_STATUSES, MIN_PASSWORD, PASSWORD_ERROR,
  hasMarkup, shortText, longText, isHexColour, priceCents, stockError, variantsError,
  optionsMarkupError, extrasMarkupError, passwordError, ibanError,
};
