'use strict';
/**
 * Sell on Trove — 'Choose your path' (the owner's pick, 2026-10-12) — and
 * /apply carrying the choice:
 *   - one question first (a real radio group), every path's copy in the
 *     server HTML, ?for= renders that path; the canonical stays
 *     /sell-on-trove and the page has one <h1>
 *   - every figure from the server: the example sums from fees.js, and the
 *     services split (10% / 90%) now follows SERVICE_COMMISSION_PERCENT in
 *     the copy like the other figures (src/figures.js)
 *   - Site content: the path keys; each question's topic and audience are
 *     fixed choices, validated and never machine-translated
 *   - migration 027-S moves a saved older override onto the new page
 *   - brand: brand-palette colours only (no new colours), no italics, the
 *     Orange accent only in the hero headline
 *   - /apply reads ?for= or the remembered choice and offers Change
 *   - Arabic: the new copy has Modern Standard Arabic
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8').replace(/\r\n/g, '\n');
const store = read('trove.html');
const applyPage = read('trove-apply.html');
const sellView = store.slice(store.indexOf('<div class="view" id="view-sell">'), store.indexOf('<!-- CHECKOUT -->'));
const style = store.slice(store.indexOf('<style>'), store.indexOf('</style>', store.indexOf('<style>')));
const sellCss = style.split('\n').filter((l) => /\.sp[\s.\-[{:,>]|\.sp-|#sellPage/.test(l)).join('\n');

let ctx; let content;
before(async () => {
  ctx = await startApp();
  content = require('../src/content');
});
after(async () => { await ctx.close(); });

const html = async (p) => (await ctx.api('GET', p, { headers: { accept: 'text/html' } })).text;
const noScripts = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ');
const textOf = (h, id) => (h.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`)) || [])[1];

/* ---------------- the page ---------------- */

test('one question first: a radio group with arrow keys; every path in the markup; the choice is remembered', () => {
  assert.match(sellView, /<div class="sp-seg" id="sellSeg" role="radiogroup" aria-labelledby="sellQ">/);
  for (const p of ['pieces', 'services', 'both']) {
    assert.match(sellView, new RegExp(`<button type="button" role="radio" aria-checked="(true|false)" tabindex="(0|-1)" data-path="${p}">`));
    assert.match(sellView, new RegExp(`<span data-show="${p}" data-cms-rich="sell\\.hero\\.h1(|Services|Both)" data-i18n>`), `${p} headline`);
  }
  assert.match(store, /e\.key===next\|\|e\.key==='ArrowDown'/, 'arrow keys move the choice');
  assert.match(store, /const SELL_KEY='trove\.sellPath\.v1';/);
  assert.match(sellView, /localStorage\.getItem\('trove\.sellPath\.v1'\)/, 'applied before the first paint');
  assert.match(store, /history\.replaceState\(history\.state,'',trovePath\(location\.pathname\)\+'\?'\+q\.toString\(\)/, '?for= kept in the address');
  assert.match(store, /if\(path==='\/sell-on-trove'\)\{go\('sell'\);sellRoute\(search\);return true;\}/);
  // the CSS that shows one path
  assert.match(style, /\.sp\[data-sellpath=pieces\] \[data-show\]:not\(\[data-show~=pieces\]\)/);
  // accessible pieces: the slider, tap-to-open detail, the jumps
  assert.match(sellView, /<label for="spLead">Your make time for a piece: <output id="spLeadOut" for="spLead">/);
  assert.match(store, /lead\.setAttribute\('aria-valuetext',days\)/);
  assert.match(sellView, /<details class="sp-job" data-show="pieces both"><summary>/);
  const jumps = [...sellView.matchAll(/<a href="#(sp[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(jumps, ['spMoney', 'spHow', 'spJourney', 'spReady', 'spFaq']);
  for (const id of jumps) assert.match(sellView, new RegExp(`id="${id}"`));
  // the arrangement card stops after 'From sold to paid': it spans the first grid's rows only
  assert.ok(sellView.indexOf('class="sp-aside"') < sellView.indexOf('id="spJourney"') && sellView.indexOf('id="spJourney"') < sellView.indexOf('<div class="wrap sp-after">'));
  assert.ok(sellView.indexOf('id="spReady"') > sellView.indexOf('<div class="wrap sp-after">'), "'What you'll need' and the questions run full width");
  // every Apply link carries the path
  assert.equal((sellView.match(/class="btn btn-dark sp-apply" href="\/apply\?for=pieces"/g) || []).length, 3);
  assert.match(store, /a\.setAttribute\('href',troveUrl\('\/apply\?for='\+p\)\)/);
});

test('what you will need lists only what the application and the dashboard really ask for', () => {
  const needs = sellView.slice(sellView.indexOf('id="spReady"'), sellView.indexOf('id="spFaq"'));
  for (const field of ['fShop', 'fAbout', 'fProducts', 'catPicker', 'fInsta', 'fPhone', 'fLic', 'fAgreeSvc']) assert.match(applyPage, new RegExp(`id="${field}"`), field);
  for (const line of ['A name for your shop', 'A few words about you and your work', "Rough ideas of what you'll sell", 'One to three service categories, with rough prices',
    'Your Instagram or a portfolio link, and WhatsApp', 'A UAE trade licence', 'The Provider Agreement, to read and accept', 'The Seller Agreement, to read and accept', 'A pickup address and phone number']) {
    assert.ok(needs.includes(line), line);
  }
  // approval waits for the agreement and the pickup details (routes/admin.routes.js approvalMissing)
  assert.match(needs, /Needed before your shop is approved\./);
});

test('brand: palette colours only, no italics, the Orange accent only in the hero headline', () => {
  const root = style.slice(style.indexOf(':root{'), style.indexOf('}', style.indexOf(':root{')));
  const palette = new Set([...root.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase()));
  const used = [...(sellView + sellCss).matchAll(/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b/g)].map((m) => m[0].toUpperCase());
  assert.ok(used.length > 5);
  for (const c of used) assert.ok(palette.has(c), `${c} is not a brand palette colour`);
  for (const m of sellCss.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) assert.ok(['41,39,39', '253,247,245'].includes(`${m[1]},${m[2]},${m[3]}`), `rgba(${m[1]},${m[2]},${m[3]}) is Charcoal or Cream only`);
  for (const [f, h] of [['trove.html', store], ['trove-apply.html', applyPage]]) assert.doesNotMatch(h, /#A85138|#7E6F67|#5E7E63|#B4502F|--coral-text/i, f);
  assert.doesNotMatch(sellView + sellCss, /font-style:\s*italic|<i>|<i /);
  assert.equal((sellView.match(/<em>/g) || []).length, 3, 'the three hero headlines carry the one accent word');
  assert.match(style, /\.sp-close h2 em\{color:inherit\}/, 'no Orange on the Clay Beige closing band, even from a CMS *word*');
  const shelf = sellView.slice(sellView.indexOf('<div class="sp-shelf"'), sellView.indexOf('</svg>', sellView.indexOf('<div class="sp-shelf"')));
  assert.doesNotMatch(shelf, /#292727/, 'no Charcoal beside the Orange flame');
});

/* ---------------- server rendering ---------------- */

test('the server sends the default path, ?for= another; one h1; the canonical stays /sell-on-trove; the sums are fees.js', async () => {
  const sell = await html('/sell-on-trove');
  assert.match(sell, /<div class="sp" id="sellPage" data-sellpath="pieces" data-commission="40" data-svc="10" data-lead-default="2">/);
  assert.equal((noScripts(sell).match(/<h1[\s>]/g) || []).length, 1);
  assert.match(sell, /<link rel="canonical" href="https:\/\/troveathome\.com\/sell-on-trove">/);
  assert.equal(textOf(sell, 'spYou'), 'AED 150');
  assert.equal(textOf(sell, 'spDirect'), 'AED 400');
  assert.equal(textOf(sell, 'spVia'), 'AED 360');
  assert.equal(textOf(sell, 'spFee'), 'AED 40');
  assert.equal(textOf(sell, 'spLeadOut'), '2 days');
  assert.equal(textOf(sell, 'spEst'), '3–6 days');
  assert.match(sell, /<input id="spLead" type="range" min="1" max="42" step="1" value="2"/);

  const svc = await html('/sell-on-trove?for=services');
  assert.match(svc, /id="sellPage" data-sellpath="services"/);
  assert.match(svc, /aria-checked="true" tabindex="0" data-path="services"/);
  assert.match(svc, /aria-checked="false" tabindex="-1" data-path="pieces"/);
  assert.equal((svc.match(/sp-apply" href="\/apply\?for=services"/g) || []).length, 3);
  assert.match(svc, /<link rel="canonical" href="https:\/\/troveathome\.com\/sell-on-trove">/);
  assert.match(await html('/sell-on-trove?for=nonsense'), /data-sellpath="pieces"/);
  const ar = await html('/ar/sell-on-trove?for=both');
  assert.match(ar, /data-sellpath="both"/);
  assert.match(ar, /sp-apply" href="\/ar\/apply\?for=both"/);
});

test('change the fees and the page follows: example sums, the share, and the services split (10% / 90%) in every language', async () => {
  const fees = require('../src/fees');
  const figures = require('../src/figures');
  const saved = { ...fees };
  assert.equal(figures.refigure('a 10% platform fee, the other 90%, 100% direct'), 'a 10% platform fee, the other 90%, 100% direct', 'identity with the shipped figures');
  Object.assign(fees, { COMMISSION_PERCENT: 35, SERVICE_COMMISSION_PERCENT: 15 });
  try {
    assert.equal(figures.refigure('a 10% platform fee, the other 90%, 100% direct'), 'a 15% platform fee, the other 85%, 100% direct');
    const sell = await html('/sell-on-trove');
    assert.match(sell, /data-commission="35" data-svc="15"/);
    assert.equal(textOf(sell, 'spYou'), 'AED 162.50');
    assert.equal(textOf(sell, 'spVia'), 'AED 340');
    assert.equal(textOf(sell, 'spFee'), 'AED 60');
    assert.match(sell, /Trove keeps a 15% platform fee and pays you the other 85% by bank transfer/);
    assert.match(sell, /Services: 100% of direct bookings, 85% through Trove/);
    assert.match(sell, /Trove's 35% covers the photography/);
    assert.match(sell, /<span class="n">65%<\/span>/);
    assert.doesNotMatch(noScripts(sell), /\b10% platform fee|\b90% (by bank|through|as your)/);
    const apply = await html('/apply');
    assert.match(apply, /a 15% platform fee on bookings paid through Trove/);
    const ar = await html('/ar/sell-on-trove');
    assert.match(ar, /تحتفظ Trove برسوم منصة قدرها 15% وتدفع لك الـ85% الباقية/);
    const api = await ctx.api('GET', '/api/content');
    assert.match(api.data.sell.faq.items.find((i) => /How do customers pay me/.test(i.q)).a, /15% platform fee and pays you the other 85%/);
  } finally {
    Object.assign(fees, saved);
  }
  assert.equal(figures.changed(), false);
});

/* ---------------- Site content ---------------- */

test('Site content: the path keys, and each question has a topic and an audience from fixed choices', async () => {
  const D = content.DEFAULTS;
  for (const k of ['h1Services', 'h1Both', 'introServices', 'introBoth', 'question', 'note', 'factsServices', 'factsBoth']) assert.ok(D['sell.hero'][k], k);
  for (const s of ['sell.money', 'sell.journey', 'sell.needs']) assert.ok(content.SECTIONS.includes(s), s);
  for (const i of D['sell.faq'].items) {
    assert.ok(content.CHOICES.topic.includes(i.topic), i.q);
    assert.ok(content.CHOICES.audience.includes(i.audience), i.q);
  }
  // every path has questions: services ones, and delivery only for pieces
  assert.ok(D['sell.faq'].items.some((i) => i.audience === 'services'));
  assert.ok(D['sell.faq'].items.filter((i) => i.topic === 'delivery').every((i) => i.audience === 'pieces'));
  // no 'you owe nothing' (F317): the maker answers for their pieces
  assert.doesNotMatch(JSON.stringify(D), /you owe nothing/);

  const db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('paths-admin@test.local',?,'Admin','admin')").run(hashPassword('testpass123'));
  const cookie = await ctx.loginAs('paths-admin@test.local', 'testpass123');
  const faq = D['sell.faq'];
  const bad = { ...faq, items: [{ q: 'A question?', a: 'An answer.', topic: 'gossip', audience: 'all' }] };
  assert.equal((await ctx.api('PUT', '/api/admin/content/sell.faq', { cookie, body: bad })).status, 422);
  const bare = { ...faq, items: [{ q: 'A question?', a: 'An answer.' }] };
  const ok = await ctx.api('PUT', '/api/admin/content/sell.faq', { cookie, body: bare });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.data.value.items[0], { q: 'A question?', a: 'An answer.', topic: 'start', audience: 'all' }, 'a missing choice takes the first one');
  // the choices are values, not copy: never sent for translation, never translated
  const translate = require('../src/translate');
  assert.ok(!Object.keys(translate.sources('content', 'sell.faq') || {}).some((k) => /topic|audience/.test(k)));
  const ar = await ctx.api('GET', '/api/content', { headers: { 'x-trove-lang': 'ar' } });
  assert.equal(ar.data.sell.faq.items[0].topic, 'start');
  // the edited lists reach the server HTML, drawn as the page script draws them
  await ctx.api('PUT', '/api/admin/content/sell.faq', { cookie, body: { ...faq, items: [{ q: 'Edited services question?', a: 'Yes.', topic: 'services', audience: 'services' }] } });
  await ctx.api('PUT', '/api/admin/content/sell.hero', { cookie, body: { ...D['sell.hero'], factsServices: ['Edited term one', 'Edited term two'] } });
  await ctx.api('PUT', '/api/admin/content/sell.steps', { cookie, body: { ...D['sell.steps'], itemsServices: [{ title: 'Apply line', text: 'a' }, { title: 'Book line', text: 'b' }] } });
  try {
    const sell = noScripts(await html('/sell-on-trove'));
    assert.match(sell, /<div class="sp-fg" data-topic="services" data-show="services both"><h3>Services<\/h3><details class="faq" data-show="services both"><summary>Edited services question\?/);
    assert.match(sell, /id="sellFactsServices" data-show="services"><li><span class="sp-dot" aria-hidden="true"><\/span><span>Edited term one<\/span><\/li>/);
    assert.match(sell, /<li data-show="services"><b>Apply line<\/b><span>a<\/span><\/li><li data-show="services both"><b>Book line<\/b>/, 'the first services line is left out on Both');
  } finally {
    for (const s of ['sell.faq', 'sell.hero', 'sell.steps']) await ctx.api('DELETE', `/api/admin/content/${s}`, { cookie });
  }
});

test('migration 027-S: a saved older override moves onto the new page; the owner\'s own words stay', () => {
  const db = ctx.db;
  const mig = require('../src/migrations/027-S-sell-paths');
  const put = (s, v) => db.prepare("INSERT INTO site_content (section, value) VALUES (?,?) ON CONFLICT(section) DO UPDATE SET value=excluded.value").run(s, JSON.stringify(v));
  const get = (s) => { const r = db.prepare('SELECT value FROM site_content WHERE section=?').get(s); return r ? JSON.parse(r.value) : null; };
  put('sell.hero', { eyebrow: 'Mine', ctaHow: 'See how it works', facts: ['You keep 60% of every sale', 'Paid every other Tuesday, after the 15-day return window', 'Free to join'] });
  put('sell.faq', { eyebrow: 'Good to know', items: [{ q: 'What does it cost?', a: 'My own answer.' }, { q: 'My own question?', a: 'Mine.' }] });
  put('sell.closing', { eyebrow: 'Ready when you are', heading: 'Give your craft a *shopfront*.', text: 'The application takes about ten minutes, and you can sign in and prepare your shop while a real person reviews it.', cta: 'Start your application' });
  try {
    mig.up(db);
    assert.deepEqual(get('sell.hero'), { eyebrow: 'Mine' }, 'the old shipped facts and the dropped button go; the eyebrow is the owner\'s');
    const faq = get('sell.faq');
    assert.deepEqual(faq.items[0], { q: 'What does it cost?', a: 'My own answer.', topic: 'money', audience: 'pieces' });
    assert.deepEqual(faq.items[1], { q: 'My own question?', a: 'Mine.', topic: 'start', audience: 'pieces' });
    assert.ok(faq.items.some((i) => i.q === 'How do customers pay me?' && i.audience === 'services'), 'the services questions are added');
    assert.equal(faq.eyebrow, 'Good to know');
    assert.equal(get('sell.closing'), null, 'an override left empty is deleted');
    assert.equal(content.getPublic().sell.closing.eyebrow, 'Founding makers wanted');
    const before = JSON.stringify([get('sell.hero'), get('sell.faq')]);
    mig.up(db);
    assert.equal(JSON.stringify([get('sell.hero'), get('sell.faq')]), before, 'running again changes nothing');
  } finally {
    db.prepare("DELETE FROM site_content WHERE section IN ('sell.hero','sell.faq','sell.closing')").run();
  }
});

/* ---------------- /apply ---------------- */

test('/apply: the carried path instead of the question, a Change link, and the doors still work as before', () => {
  assert.match(applyPage, /const PATH_KEY='trove\.sellPath\.v1';/, 'the same key the sell page remembers');
  assert.match(applyPage, /const f=new URLSearchParams\(location\.search\)\.get\('for'\);/);
  assert.match(applyPage, /<div class="carried" id="carried" hidden>.*<button type="button" class="clink" id="changeRole" aria-expanded="false" aria-controls="roles" onclick="openRoles\(\)">Change<\/button><\/div>/);
  for (const w of ['pieces', 'services', 'pieces and services']) assert.ok(applyPage.includes(`_t('Applying with <b>${w}</b>, as chosen on the last page.')`), w);
  for (const r of ['maker', 'provider', 'both']) assert.match(applyPage, new RegExp(`data-role="${r}" onclick="pickRole\\('${r}'\\)"`));
  // the services call and the one-account rules are untouched
  assert.match(applyPage, /TroveAPI\.api\('\/api\/services\/apply',\{method:'POST',body\}\)/);
  assert.match(applyPage, /withShop:wantsShop\(\)/);
  assert.match(applyPage, /if\(carried&&carried!=='pieces'\)openRoles\(false\);/, 'an account that already offers services sees why services is off');
});

/* ---------------- Arabic ---------------- */

test('Arabic: the new sell page reads in Arabic, every path, before the script runs', async () => {
  const ar = noScripts(await html('/ar/sell-on-trove'));
  const view = ar.slice(ar.indexOf('id="view-sell"'), ar.indexOf('<!-- CHECKOUT -->') > 0 ? ar.indexOf('<!-- CHECKOUT -->') : ar.indexOf('id="view-checkout"'))
    .replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
  for (const s of ['ماذا ستقدّم على Trove؟', 'اتفاقك', 'من البيع إلى الدفع.', 'ما ستحتاج إليه.', 'دورك', 'نبحث عن مقدّمي خدمات مؤسسين', 'كم يكلّف إدراج الخدمات؟']) assert.ok(view.includes(s), s);
  const english = view.replace(/Trove|AED|WhatsApp|Instagram|e-Trader/g, '').match(/[A-Za-z]{4,}(?:\s+[A-Za-z]{2,})+/g);
  assert.equal(english, null, `English left: ${english && english.slice(0, 5).join(' | ')}`);
  const apply = await html('/ar/apply?for=services');
  assert.match(apply, /dir="rtl"/);
  const dict = JSON.parse(fs.readFileSync(path.join(DOCS, 'i18n', 'ar', 'apply.json'), 'utf8'));
  assert.equal(dict['Applying with <b>services</b>, as chosen on the last page.'], 'طلبك يشمل <b>الخدمات</b>، كما اخترت في الصفحة السابقة.');
});
