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

/**
 * The first of `keys` whose value (in `obj`) carries markup, or null. For
 * the short free-text fields other people see: application answers in the
 * admin review queue, a delivery address in the shop's order view, a
 * booking request in the provider's inbox.
 */
function markupField(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  return keys.find((k) => obj[k] != null && typeof obj[k] !== 'object' && hasMarkup(obj[k])) || null;
}

const MIN_PASSWORD = 8;
const PASSWORD_ERROR = `Choose a password of at least ${MIN_PASSWORD} characters`;
/*
 * New passwords may not be one of the first guesses every password-guessing
 * script tries (F208): the most common 8+ character passwords from public
 * breach lists, plus one character repeated or a straight run of keys.
 * Existing passwords keep working; this applies when one is chosen.
 */
const COMMON_PASSWORD_ERROR = 'That password is one of the most common ones — choose something harder to guess';
const COMMON_PASSWORDS = new Set(`
12345678 123456789 1234567890 12345678910 123123123 1234512345 11223344 12341234 87654321 98765432 0123456789
password password1 password12 password123 password1234 passw0rd p@ssword p@ssw0rd pa55word password! password01
qwertyui qwertyuiop qwerty12 qwerty123 qwerty1234 1qaz2wsx 1q2w3e4r 1q2w3e4r5t zaq12wsx asdfghjk asdfasdf
iloveyou iloveyou1 sunshine sunshine1 princess princess1 football football1 baseball welcome1 welcome123
trustno1 superman letmein1 letmein123 whatever starwars dragon123 monkey123 master123 shadow123 michael1
computer internet abcdefgh abcd1234 abc12345 abc123456 aa123456 a1234567 a12345678 changeme changeme1
admin123 admin1234 administrator 11111111 00000000 88888888 66666666 12121212 password2 qwerty11 test1234
trove123 trove1234 troveathome dubai123 dubai2026 uae12345 emirates abudhabi sharjah1 marhaba123
`.trim().split(/\s+/));
function weakPassword(pw) {
  const p = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(p)) return true;
  if (/^(.)\1+$/.test(p)) return true; // aaaaaaaa
  const runs = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl'];
  return runs.some((r) => r.includes(p));
}
const passwordError = (pw) => {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return PASSWORD_ERROR;
  if (weakPassword(pw)) return COMMON_PASSWORD_ERROR;
  return null;
};

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

/**
 * Account holder + bank name for payout details (makers and providers). Both
 * end up in the bank transfer files the owner opens in a spreadsheet, so
 * besides < > they may not start like a formula (= + - @). Returns an error
 * message or null.
 */
function payoutNamesError(accountName, bankName) {
  if (hasMarkup(accountName) || hasMarkup(bankName)) return 'Names cannot contain < or >';
  const { startsLikeFormula } = require('./csv');
  if (startsLikeFormula(accountName) || startsLikeFormula(bankName)) return 'Names cannot start with = + - or @';
  return null;
}

/**
 * A new account's email address (sign-up, provider enrolment): a simple
 * shape check — something@something.tld, no spaces, at most 254 characters.
 * A typo like 'layla@gmailcom' or 'not-an-email' would otherwise create an
 * account whose receipts and reset links go nowhere (and, with no '@', one
 * that can never sign in again — login reads it as a phone number).
 * Returns an error message or null. Common domain slips get a suggestion.
 */
const EMAIL_SHAPE = /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)*\.[^\s@<>.]{2,}$/;
const EMAIL_ERROR = "That email address doesn't look right — check it and try again";
function emailError(email) {
  const e = String(email == null ? '' : email).trim();
  if (!e || e.length > 254 || !EMAIL_SHAPE.test(e)) return EMAIL_ERROR;
  return null;
}

module.exports = {
  emailError, EMAIL_ERROR,
  payoutNamesError,
  LIMITS, MIN_PRICE_CENTS, MAX_PRICE_CENTS, MAX_STOCK, PRODUCT_STATUSES, MIN_PASSWORD, PASSWORD_ERROR, COMMON_PASSWORD_ERROR,
  hasMarkup, shortText, longText, isHexColour, priceCents, stockError, variantsError,
  optionsMarkupError, extrasMarkupError, markupField, passwordError, ibanError,
};
