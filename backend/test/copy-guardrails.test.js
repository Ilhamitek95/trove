'use strict';
/**
 * Copy guardrail — CI-enforced language police.
 *
 * Trove's payment model is purchase-and-resale: Trove BUYS goods from
 * suppliers and resells them. It never "collects money on behalf of sellers"
 * — that phrasing describes payment aggregation, a licensed activity Trove
 * deliberately does not perform. This test fails the build if any
 * user-facing copy, docs, legal text or code comment drifts back into that
 * framing. Allowed vocabulary: purchase, purchase price, settlement,
 * supplier payout.
 *
 * A line containing the marker copy-ok: is exempt (for lines that must quote
 * a banned phrase, like this file's own list).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const BANNED = [
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

function* targetFiles() {
  const docs = path.join(ROOT, 'docs');
  for (const f of fs.readdirSync(docs)) {
    if (/\.(html|js)$/i.test(f)) yield path.join(docs, f);
  }
  yield path.join(ROOT, 'README.md');
  yield path.join(ROOT, 'backend', 'README.md');
  const legal = path.join(ROOT, 'backend', 'legal');
  if (fs.existsSync(legal)) for (const f of fs.readdirSync(legal)) yield path.join(legal, f);
  const walk = function* (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (/\.js$/.test(entry.name)) yield p;
    }
  };
  yield* walk(path.join(ROOT, 'backend', 'src'));
}

test('no money-transmission language anywhere in the product', () => {
  const violations = [];
  for (const file of targetFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes('copy-ok:')) return;
      for (const [label, re] of BANNED) {
        if (re.test(line)) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1} [${label}] ${line.trim().slice(0, 140)}`);
        }
      }
    });
  }
  assert.deepEqual(violations, [], `Banned money-transmission phrasing found:\n${violations.join('\n')}`);
});

// Sustainability claims Trove can't substantiate — greenwashing is a consumer-
// protection problem, so the build fails if the copy drifts back into it.
const BANNED_CLAIMS = [
  ['carbon-neutral', /carbon[- ]?neutral/i],   // copy-ok: the list itself
  ['carbon-free', /carbon[- ]?free/i],         // copy-ok: the list itself
  ['climate-neutral', /climate[- ]?neutral/i], // copy-ok: the list itself
  ['net zero', /\bnet[- ]?zero\b/i],           // copy-ok: the list itself
];

test('no unverifiable sustainability claims anywhere in the product', () => {
  const violations = [];
  for (const file of targetFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes('copy-ok:')) return;
      for (const [label, re] of BANNED_CLAIMS) {
        if (re.test(line)) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1} [${label}] ${line.trim().slice(0, 140)}`);
        }
      }
    });
  }
  assert.deepEqual(violations, [], `Unverifiable sustainability claims found:\n${violations.join('\n')}`);
});
