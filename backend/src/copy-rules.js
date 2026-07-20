'use strict';
/**
 * Banned-language rules, shared by two enforcers:
 *   - test/copy-guardrails.test.js  (CI — scans checked-in copy)
 *   - src/content.js                (runtime — rejects admin-edited site copy)
 * Trove's payment model is purchase-and-resale; it never aggregates payments,
 * and it makes no sustainability claims it can't substantiate. Keeping the
 * rules in one place means the admin CMS can't drift where the repo can't.
 */

const BANNED_MONEY = [
  ['on behalf of', /on behalf of/i],                             // copy-ok: the list itself
  ["on sellers' behalf", /on sellers.{0,2}behalf/i],             // copy-ok: the list itself
  ['remit', /\bremit/i],                                         // copy-ok: the list itself
  ['transfer buyer funds', /transfer (?:the )?buyer(?:s'?)? funds/i], // copy-ok: the list itself
  ['payment processing for sellers', /payment processing for sellers/i], // copy-ok: the list itself
  ['we collect payments for', /we collect payments? for/i],      // copy-ok: the list itself
  ['collects your sales', /collects? your sales/i],              // copy-ok: the list itself
  ['split to each shop', /split (?:to|across) each shop/i],      // copy-ok: the list itself
  ['collecting funds', /collect(?:ing|s)? (?:seller |sellers'? )?funds/i], // copy-ok: the list itself
  ['we handle payments', /we handle payments/i],                 // copy-ok: the list itself
];

const BANNED_CLAIMS = [
  ['carbon-neutral', /carbon[- ]?neutral/i],   // copy-ok: the list itself
  ['carbon-free', /carbon[- ]?free/i],         // copy-ok: the list itself
  ['climate-neutral', /climate[- ]?neutral/i], // copy-ok: the list itself
  ['net zero', /\bnet[- ]?zero\b/i],           // copy-ok: the list itself
];

/** First banned phrase found in the text, or null. */
function copyViolation(text) {
  for (const [label, re] of [...BANNED_MONEY, ...BANNED_CLAIMS]) {
    if (re.test(text)) return label;
  }
  return null;
}

module.exports = { BANNED_MONEY, BANNED_CLAIMS, copyViolation };
