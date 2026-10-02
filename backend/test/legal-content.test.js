'use strict';
/**
 * Legal and policy copy that must say what the code does (third review,
 * 2026-10-02): the /returns examples and photo rule, the Terms of Sale v3
 * (18+, photos, delivery refund), the licence threshold the Seller Agreement
 * points to, the Provider Agreement v3 liability cap and payer, and the
 * Services pages naming both payment routes.
 */
const fs = require('fs');
const path = require('path');
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const legal = (doc) => ctx.api('GET', `/api/legal/${doc}`).then((r) => r.data.markdown.replace(/\s+/g, ' '));
const aed = (c) => 'AED ' + (c / 100).toLocaleString('en-GB');

test('/returns: the worked examples match the refund the code pays', async () => {
  const fees = require('../src/fees');
  const piece = Math.round((fees.FREE_DELIVERY_THRESHOLD_CENTS * 0.75) / 1000) * 1000;
  const text = visible((await ctx.api('GET', '/returns')).text);
  // Changed mind, single piece: the collection fee comes off, delivery is kept.
  assert.ok(text.includes(`you receive ${aed(piece - fees.DELIVERY_FEE_CENTS)}`), 'change of mind');
  // The same piece chipped: the whole order came back for a fault, so delivery is refunded too.
  assert.ok(text.includes(`The same vase arrives chipped: you receive ${aed(piece + fees.DELIVERY_FEE_CENTS)}`), text.slice(text.indexOf('Examples'), text.indexOf('Examples') + 600));
  assert.ok(!text.includes(`The same vase arrives chipped: you receive ${aed(piece)} `) && !text.includes(`The same vase arrives chipped: you receive ${aed(piece)}.`), 'the old example is gone');
  // Part of an order back for a fault: delivery is kept.
  assert.ok(text.includes(`only the vase arrives chipped: you receive ${aed(piece)} . The delivery charge is kept`), 'part-order example');
  // Photos: required by the code, so required by the page.
  assert.match(text, /add at least one photo/);
  assert.doesNotMatch(text, /A photo helps|we may ask for one/);
  const returnsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'returns.js'), 'utf8');
  assert.match(returnsSrc, /if \(!imgs\.length\) return \{ error: 'Add at least one photo/, 'the code still requires a photo');
});

test('Terms of Sale v3: 18+, photos required, delivery refunded on a whole-order fault', async () => {
  assert.equal(require('../src/config').BUYER_TERMS_VERSION, 'v3');
  const md = await legal('terms');
  assert.match(md, /## 2\. Who can buy You must be \*\*18 or over\*\* to open an account or place an order/);
  assert.match(md, /\*\*add at least one photo\*\* of what you are sending back/);
  assert.doesNotMatch(md, /we may ask for a photo/);
  assert.match(md, /\*\*The original delivery charge is refunded when the whole order comes back because it arrived faulty or damaged, was the wrong item or was not as described\.\*\*/);
  assert.match(md, /Your contract is with \*\*Serein Consultancy LLC\*\*/);
  // v2 is untouched.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'legal', 'buyer-terms-v2.md'), 'utf8'), /we may ask for a photo/);
});

test('the licence threshold the Seller Agreement points to is published in the Help centre', async () => {
  const cfg = require('../src/config');
  const md = await legal('seller-agreement');
  assert.match(md, /maker section of the \[Help centre\]\(\/faq#makers\)/);
  const faq = visible((await ctx.api('GET', '/faq')).text);
  assert.ok(faq.includes(`settlements Trove pays you in any 30 days reach ${aed(cfg.graduationThresholdCents())}`), 'the figure is on the page');
  assert.ok(md.includes(aed(cfg.graduationThresholdCents())), 'and matches the agreement as published');
});

test('Provider Agreement v3: the payer is named and the liability cap is never zero', async () => {
  const md = await legal('provider-agreement');
  assert.match(md, /bank transfer from Serein Consultancy LLC\*\*/);
  assert.match(md, /Trove will always pay you the fees it has collected for your services\*\*/);
  assert.match(md, /greater of \(a\) the subscription fees you paid Trove and \(b\) the platform fees Trove kept on your bookings/);
  assert.match(md, /no less than AED 1,000/);
  assert.doesNotMatch(md, /limited to the subscription fees you paid Trove in the three months/);
  assert.equal(require('../src/service-credits').payerName(), 'Serein Consultancy LLC');
  // Payout timing and bank-detail rules (group B, 2026-10-02).
  assert.match(md, /mark a booking done only \*\*on or after its service date\*\*/);
  assert.match(md, /\*\*provisional\*\* until the service date plus a \*\*3-day complaint window\*\*/);
  assert.match(md, /\*\*fortnightly payout days, every other Tuesday\*\*/);
  assert.match(md, /needs your \*\*account password\*\*/);
  assert.match(md, /next payout is \*\*held until Trove has confirmed the change\*\*/);
  assert.match(md, /\*\*VAT at 5%\*\*/);
  assert.doesNotMatch(md, /three days after the service date if you have not/);
  const terms = await legal('services-terms');
  assert.match(terms, /within \*\*3 days\*\* of the service date/);
  assert.match(terms, /\*\*VAT at 5%\*\*, always shown with the amount before you pay/);
});

test('Services pages name both payment routes instead of saying Trove only lists the service', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove-services.html'), 'utf8');
  assert.doesNotMatch(html, /Trove lists it/);
  assert.doesNotMatch(html, /Trove lists the service and passes on the request/);
  assert.match(html, /Pay through Trove and Trove is your contracting party, refunding you in full if it isn't delivered; settle directly and the arrangement is between you and the provider\./);
  assert.match(html, /Pay through Trove by card and Trove is your contracting party for that booking/);
});
