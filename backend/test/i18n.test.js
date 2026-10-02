'use strict';
/**
 * The language core (src/i18n.js + docs/api.js):
 *   - the /ar address rules are the same in the server and the browser
 *   - the static-text translator: text nodes, attributes, data-i18n blocks,
 *     never inside scripts or translate="no", /ar links, prices isolated
 *   - plurals, the browser's _t/_tn and its /ar-aware history
 *   - the remembered choice: cookie and account (users.lang), ?hl=en
 */
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const i18n = require('../src/i18n');
const API_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'api.js'), 'utf8');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

test('the browser and the server agree on which addresses have an Arabic twin', () => {
  const m = API_JS.match(/var LOCALIZED_RE = (\/.*\/i);/);
  assert.ok(m, 'api.js carries LOCALIZED_RE');
  assert.equal(m[1], String(i18n.LOCALIZED_RE));
  for (const p of ['/', '/shop', '/shop/ceramics', '/pieces/12-mug', '/makers/kiln', '/services', '/services/noor', '/services/booking/AB-12', '/sell-on-trove', '/about', '/terms', '/apply', '/login', '/account', '/sell', '/provider', '/returns']) {
    assert.ok(i18n.isLocalizable(p), p);
  }
  for (const p of ['/admin', '/api/products', '/uploads/x.jpg', '/api.js', '/sitemap.xml', '/robots.txt', '/img/og-default.jpg']) {
    assert.ok(!i18n.isLocalizable(p), p);
  }
});

test('arUrl / stripAr', () => {
  assert.equal(i18n.arUrl('/'), '/ar');
  assert.equal(i18n.arUrl('/?q=mug'), '/ar?q=mug');
  assert.equal(i18n.arUrl('/#vendors'), '/ar#vendors');
  assert.equal(i18n.arUrl('/shop/ceramics?x=1#top'), '/ar/shop/ceramics?x=1#top');
  assert.equal(i18n.arUrl('/ar/shop'), '/ar/shop', 'never twice');
  assert.equal(i18n.arUrl('/api/products'), '/api/products');
  assert.equal(i18n.arUrl('/admin'), '/admin');
  assert.equal(i18n.arUrl('//evil.example/shop'), '//evil.example/shop');
  assert.equal(i18n.arUrl('https://x.com/shop'), 'https://x.com/shop');
  assert.equal(i18n.stripAr('/ar'), '/');
  assert.equal(i18n.stripAr('/ar?x=1'), '/?x=1');
  assert.equal(i18n.stripAr('/ar/pieces/1-a'), '/pieces/1-a');
  assert.equal(i18n.stripAr('/arabic'), '/arabic');
});

test('the static-text translator', () => {
  const d = {
    'Shop all': 'تسوّق الكل',
    'Search Trove': 'ابحث في Trove',
    'Free on orders over AED 200': 'مجاني للطلبات التي تتجاوز AED 200',
    'Curated<br>for <em>Living</em>.': 'مختارة<br>لـ<em>حياة</em> أجمل.',
    'Hidden': 'مخفي',
  };
  const html = `<html lang="en"><head><title>Shop all</title><script>var s='Shop all';</script><style>.a:after{content:"Shop all"}</style></head>
<body><a href="/shop">  Shop all </a><input placeholder="Search Trove" aria-label="Search Trove" value="Shop all">
<p>Free on orders over AED 200</p><h1 data-i18n>Curated<br>for <em>Living</em>.</h1>
<span translate="no">Shop all<b>Hidden</b></span><svg><text>Shop all</text></svg>
<a href="/api/legal/terms">x</a><a href="/admin">x</a><a href="https://ex.com/shop">x</a><a href="/uploads/a.jpg">x</a><form action="/shop"></form></body></html>`;
  const out = i18n.translateHtml(html, d, { links: true });
  assert.match(out, /<title>تسوّق الكل<\/title>/);
  assert.match(out, /var s='Shop all';/, 'scripts are never touched');
  assert.match(out, /content:"Shop all"/, 'styles are never touched');
  assert.match(out, /<a href="\/ar\/shop">  تسوّق الكل <\/a>/, 'surrounding whitespace kept, link to the twin');
  assert.match(out, /placeholder="ابحث في Trove" aria-label="ابحث في Trove" value="Shop all"/, 'value of a text input is data, not a label');
  assert.match(out, /<p>مجاني للطلبات التي تتجاوز ⁦AED 200⁩<\/p>/, 'prices are isolated');
  assert.match(out, /<h1 data-i18n>مختارة<br>لـ<em>حياة<\/em> أجمل.<\/h1>/);
  assert.match(out, /<span translate="no">Shop all<b>Hidden<\/b><\/span>/, 'translate="no" is respected, nested tags included');
  assert.match(out, /<svg><text>Shop all<\/text><\/svg>/);
  for (const u of ['/api/legal/terms', '/admin', 'https://ex.com/shop', '/uploads/a.jpg']) assert.ok(out.includes(`href="${u}"`), u);
  assert.match(out, /<form action="\/ar\/shop">/);
});

test('plurals and placeholders, server and browser', () => {
  assert.equal(i18n.tn('en', 1, '{n} piece', '{n} pieces', null, []), '1 piece');
  assert.equal(i18n.tn('en', 3, '{n} piece', '{n} pieces', null, []), '3 pieces');
  const ar = (n) => i18n.tn('ar', n, '{n} piece', '{n} pieces', null, ['common']);
  assert.equal(ar(1), 'قطعة واحدة');
  assert.equal(ar(2), 'قطعتان');
  assert.equal(ar(5), '5 قطع');
  assert.equal(ar(11), '11 قطعة');
  assert.equal(i18n.t('en', 'Arrives in {label}', { label: '3–6 days' }), 'Arrives in 3–6 days');
  assert.equal(i18n.t('ar', 'Shop all', null, ['common']), 'تسوّق الكل');
  assert.equal(i18n.t('ar', 'Not in any dictionary {x}', { x: 1 }), 'Not in any dictionary 1', 'a missing entry falls back to English');
  assert.equal(i18n.money('en', 1250), 'AED 1,250');
  assert.equal(i18n.money('ar', 120), '⁦AED 120⁩');
  assert.match(i18n.date('ar', '2026-10-02T08:00:00Z'), /2026/, 'Western digits in Arabic dates');

  // docs/api.js in a page served in Arabic
  const dict = i18n.dict('ar', []);
  const sandbox = { console, setTimeout, clearTimeout, Promise, TROVE_LANG: 'ar', TROVE_I18N: dict, Intl, localStorage: { setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(API_JS, sandbox);
  assert.equal(sandbox._t('Shop all'), 'تسوّق الكل');
  assert.equal(sandbox._t('Nope {a}', { a: 2 }), 'Nope 2');
  assert.equal(sandbox._tn(2, '{n} piece', '{n} pieces'), 'قطعتان');
  assert.equal(sandbox._tn(7, '{n} piece', '{n} pieces'), '7 قطع');
  assert.equal(sandbox.troveMoney(64), '⁦AED 64⁩');
  assert.equal(sandbox.troveUrl('/shop'), '/ar/shop');
  assert.equal(sandbox.trovePath('/ar/pieces/3-x'), '/pieces/3-x');
  // …and in English
  const en = { console, setTimeout, clearTimeout, Promise, Intl };
  en.window = en;
  vm.createContext(en);
  vm.runInContext(API_JS, en);
  assert.equal(en._t('Shop all'), 'Shop all');
  assert.equal(en._tn(1, '{n} piece', '{n} pieces'), '1 piece');
  assert.equal(en.troveMoney(64), 'AED 64');
  assert.equal(en.troveUrl('/shop'), '/shop');
});

test('an Arabic page: lang/dir, the dictionary for its script, rtl.css, the switch back to English', async () => {
  const res = await ctx.api('GET', '/ar/shop');
  assert.equal(res.status, 200);
  assert.match(res.text, /<html lang="ar" dir="rtl"/);
  assert.match(res.text, /window\.TROVE_LANG="ar";window\.TROVE_I18N=\{/);
  assert.match(res.text, /<link rel="stylesheet" href="\/rtl\.css(\?v=[a-f0-9]+)?">/);
  assert.match(res.text, /data-lang-switch href="\/shop\?hl=en" hreflang="en" lang="en"[^>]*>English</);
  assert.match(res.headers.get('set-cookie') || '', /trove_lang=ar/);
  const en = await ctx.api('GET', '/shop');
  assert.match(en.text, /<html lang="en"/);
  assert.doesNotMatch(en.text, /<html[^>]*dir="rtl"|window\.TROVE_I18N=|href="\/rtl\.css"/);
  assert.match(en.text, /data-lang-switch href="\/ar\/shop" hreflang="ar" lang="ar"[^>]*>العربية</);
  assert.equal((await ctx.api('GET', '/ar/admin')).status, 404, 'the admin has no Arabic twin');
  assert.equal((await ctx.api('GET', '/ar/')).headers.get('location'), '/ar');
});

test('the choice is remembered: cookie, ?hl=en, and the account', async () => {
  const toAr = await ctx.api('GET', '/shop/ceramics?x=1', { cookie: 'trove_lang=ar' });
  assert.equal(toAr.status, 302);
  assert.equal(toAr.headers.get('location'), '/ar/shop/ceramics?x=1');
  assert.match(toAr.headers.get('vary') || '', /Cookie/);
  const back = await ctx.api('GET', '/shop/ceramics?hl=en&x=1', { cookie: 'trove_lang=ar' });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/shop/ceramics?x=1');
  assert.match(back.headers.get('set-cookie') || '', /trove_lang=en/);
  assert.equal((await ctx.api('GET', '/shop', { cookie: 'trove_lang=en' })).status, 200);
  assert.equal((await ctx.api('GET', '/admin', { cookie: 'trove_lang=ar' })).status, 200, 'English-only pages never redirect');

  const { hashPassword } = require('../src/middleware');
  ctx.db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('reader@test.local',?, 'Reader','buyer')").run(hashPassword('testpass123'));
  const cookie = await ctx.loginAs('reader@test.local', 'testpass123');
  await ctx.api('GET', '/ar/account', { cookie });
  assert.equal(ctx.db.prepare("SELECT lang FROM users WHERE email='reader@test.local'").get().lang, 'ar');
  // a new browser (no language cookie) signed in to that account lands in Arabic
  const fresh = await ctx.api('GET', '/shop', { cookie });
  assert.equal(fresh.status, 302);
  assert.equal(fresh.headers.get('location'), '/ar/shop');
  await ctx.api('GET', '/shop?hl=en', { cookie });
  assert.equal(ctx.db.prepare("SELECT lang FROM users WHERE email='reader@test.local'").get().lang, 'en');
});

test('API calls carry the language: ?lang=ar or X-Trove-Lang', async () => {
  const promo = (r) => r.data.site.promo.text;
  const en = await ctx.api('GET', '/api/content');
  const ar = await ctx.api('GET', '/api/content?lang=ar');
  const hdr = await ctx.api('GET', '/api/content', { headers: { 'X-Trove-Lang': 'ar' } });
  assert.match(promo(en), /Delivering across Dubai/);
  assert.match(promo(ar), /دبي وأبوظبي/);
  assert.equal(promo(hdr), promo(ar));
});
