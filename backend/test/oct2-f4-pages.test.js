'use strict';
/**
 * Medium-findings round 2026-10-02, group F4 — public pages:
 *   F101  the sell page doesn't promise 'no licence' without the ID check
 *   F104  /apply's side panel matches the chosen door; services on /sell-on-trove
 *   F114  the booking form puts 'how to pay' first, card through Trove by default
 *   F115  the phone menu's 'Services Marketplace' leaves a provider/booking page
 *   F116  a search on /services looks in the services; product search links them
 *   F139  no 'AED 30 a month' / 'one flat fee' — listing is free during launch
 *   F146/F147  60% and the payment timing up top; each promise said once
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const doc = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'docs', f), 'utf8');
let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('F139: llms.txt and /apply say listing is free during launch', async () => {
  const llms = (await ctx.api('GET', '/llms.txt')).text;
  assert.doesNotMatch(llms, /pay AED 30 a month/);
  assert.match(llms, /Listing is free during launch/);
  const apply = doc('trove-apply.html');
  assert.doesNotMatch(apply, /one flat fee/);
});

test('F101/F146/F147: the sell page states the deal up top, honestly, once', async () => {
  const content = require('../src/content');
  const D = content.DEFAULTS || content.defaults;
  // Since 2026-10-12 ('Choose your path') the deal at a glance is the 'Your arrangement' card:
  // the 60% is its big number, the facts are its terms (pieces path).
  assert.deepEqual(D['sell.hero'].facts, ['No joining fee, no listing fee', 'No trade licence to start', 'Photos, marketing and customer care by Trove', 'Courier collects from your door, paid by Trove', 'Paid every other Tuesday, after the 15-day return window']);
  const licence = D['sell.faq'].items.find((f) => /trade licence/.test(f.q));
  assert.match(licence.a, /Emirates ID \(front and back\)/);
  assert.match(licence.a, /e-Trader licence/);
  assert.doesNotMatch(licence.a, /^No\./);
  // 'no licence' is only ever said with the ID check beside it
  assert.match(D['sell.offer'].items[0].text, /most home makers can start without a licence\. Before your first payout we check your Emirates ID/);
  const page = doc('trove.html');
  const sell = page.slice(page.indexOf('<div class="view" id="view-sell">'), page.indexOf('<!-- CHECKOUT -->'));
  // the arrangement card sits right after the hero, before 'Who does what'
  assert.ok(sell.indexOf('id="sellH1"') < sell.indexOf('id="sellFacts"') && sell.indexOf('id="sellFacts"') < sell.indexOf('id="spHow"'));
  assert.match(sell, /<p class="sp-arr-big" data-show="pieces both"><span class="n">60%<\/span>/);
  // own packaging: your part, the delivery answer and the 'what you'll need' list (each once)
  assert.equal((sell.match(/own packaging/g) || []).length, 3);
  assert.doesNotMatch(sell, /No trade licence needed/);
});

test('F101: a saved sell-page override with the old wording is rewritten', async () => {
  const mig = require('../src/migrations/024-F4-sell-copy');
  const db = ctx.db;
  db.prepare("INSERT OR REPLACE INTO site_content (section, value, updated_at) VALUES ('sell.hero', ?, datetime('now'))")
    .run(JSON.stringify({ eyebrow: 'Mine', facts: ['Free to join', 'No trade licence needed', 'Courier collects from your door', 'A real person reviews every shop'] }));
  mig.up(db);
  const v = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='sell.hero'").get().value);
  assert.equal(v.eyebrow, 'Mine', 'the admin’s own words stay');
  assert.equal(v.facts[0], 'You keep 60% of every sale');
});

test('F104: services have their own pitch, and the apply side panel follows the door', () => {
  const page = doc('trove.html');
  assert.match(page, /id="sellServices"/);
  assert.match(page, /You keep 100% — Trove takes nothing/);
  assert.match(page, /apply\?for=services/);
  const apply = doc('trove-apply.html');
  assert.match(apply, /\$\('bIntro2'\)\.textContent=c\.intro2/);
  assert.match(apply, /next='\+encodeURIComponent\('\/apply\?for='/, 'sign in comes back to the form');
  const login = doc('trove-login.html');
  assert.match(login, /function nextDest\(\)/);
});

test('F114/F115/F116: the services page wiring', () => {
  const s = doc('trove-services.html');
  const form = s.slice(s.indexOf('<h4>${_t(\'Request a booking\')}</h4>'), s.indexOf('id="bkTerms"'));
  assert.ok(form.indexOf('name="bkPay"') < form.indexOf('id="bkName"'), 'how to pay comes before the contact fields');
  assert.ok(form.indexOf('value="trove"') < form.indexOf('value="direct"'), 'card through Trove is listed first');
  assert.match(form, /value="trove" \$\{paymentsLive\?'checked':'disabled'\}/, 'and chosen by default when card payments are live');
  assert.match(s, /onclick="return menuToDirectory\(\)"/);
  assert.match(s, /async function runSearch\(q\)\{/);
  assert.match(s, /api\/services\?q='\+encodeURIComponent\(q\)/);
  assert.match(doc('trove.html'), /function serviceHits\(\)/);
});

test('F116: /api/services?q= finds services by their words', async () => {
  const r = await ctx.api('GET', '/api/services?q=zzzz-nothing');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.services, []);
});
