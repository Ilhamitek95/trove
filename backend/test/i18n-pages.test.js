'use strict';
/**
 * The Arabic edition of the server-rendered pages (src/seo.js,
 * src/site-pages.js, src/i18n.js):
 *   - every public address has an /ar twin: 200, <html lang="ar" dir="rtl">,
 *     one <h1>, Arabic text, its own canonical, hreflang en/ar/x-default;
 *   - the English pages are unchanged (lang="en", no dir) and name the twin;
 *   - private pages carry no hreflang; misses are an Arabic 404;
 *   - the /ar prefix survives redirects, the reader's choice is remembered
 *     (cookie) and ?hl=en forgets it;
 *   - sitemap + robots cover both languages;
 *   - the legal pages serve the Arabic translation with its note, while
 *     acceptance keeps pointing at the English text's hash;
 *   - what people wrote shows in Arabic only while its translation is current.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com', DEMO_PROVIDERS: '1' });

const BASE = 'https://troveathome.com';
const LEGAL_DIR = path.join(__dirname, '..', 'legal');
let ctx; let seo; let db;
before(async () => {
  ctx = await startApp();
  require('../src/seed');
  seo = require('../src/seo');
  db = ctx.db;
});
after(async () => { await ctx.close(); });

const get = (p, headers = {}) => ctx.api('GET', p, { headers: { accept: 'text/html', ...headers } });
const noScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ');
const h1s = (html) => (noScripts(html).match(/<h1[\s>][\s\S]*?<\/h1>/g) || []);
const canonical = (html) => (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
const alt = (html, lang) => (html.match(new RegExp(`<link rel="alternate" hreflang="${lang}" href="([^"]*)"`)) || [])[1];
const ld = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .flatMap((m) => { const o = JSON.parse(m[1]); return o['@graph'] || [o]; });
const ARABIC = /[؀-ۿ]{3,}/;

const livePiece = () => db.prepare(`SELECT p.id, p.name, p.description, s.slug FROM products p
  JOIN shops s ON s.id = p.shop_id WHERE p.status = 'live' AND s.status = 'approved' AND s.is_house = 0 ORDER BY p.id LIMIT 1`).get();
const provider = () => db.prepare("SELECT slug FROM service_providers WHERE status = 'approved' ORDER BY id LIMIT 1").get();

function publicPaths() {
  const p = livePiece();
  return ['/', '/shop', '/shop/ceramics', seo.pieceUrl(p), `/makers/${p.slug}`, '/services', `/services/${provider().slug}`,
    '/sell-on-trove', '/about', '/faq', '/contact', '/returns', '/terms', '/privacy', '/seller-agreement', '/provider-agreement', '/services-terms'];
}

test('every public address has an Arabic twin: rtl, one h1, Arabic text, its own canonical and hreflang', async () => {
  for (const en of publicPaths()) {
    const arPath = en === '/' ? '/ar' : `/ar${en}`;
    const res = await get(arPath);
    assert.equal(res.status, 200, arPath);
    const html = res.text;
    assert.match(html, /<html lang="ar" dir="rtl"/, `${arPath}: lang + dir`);
    assert.equal(h1s(html).length, 1, `${arPath}: exactly one h1`);
    assert.match(noScripts(h1s(html)[0]).replace(/<[^>]+>/g, ''), /\S/, `${arPath}: the h1 has text`);
    assert.match(html.match(/<title>([^<]*)<\/title>/)[1], /[؀-ۿ]{2,}/, `${arPath}: an Arabic title`);
    assert.equal(canonical(html), BASE + arPath, `${arPath}: canonical is the Arabic address`);
    assert.equal(alt(html, 'ar'), BASE + arPath, `${arPath}: hreflang ar`);
    assert.equal(alt(html, 'en'), BASE + en, `${arPath}: hreflang en`);
    assert.equal(alt(html, 'x-default'), BASE + en, `${arPath}: x-default is English`);
    assert.match(html, /<meta property="og:locale" content="ar_AE">/);
    assert.match(html, /<link rel="stylesheet" href="\/rtl\.css(\?v=[a-f0-9]+)?">/, `${arPath}: the rtl stylesheet`);
    assert.match(html, /window\.TROVE_I18N=/, `${arPath}: the dictionary for the page's script`);
    for (const node of ld(html)) if (node.inLanguage) assert.equal(node.inLanguage, 'ar', `${arPath}: JSON-LD inLanguage`);
    // local links keep the reader in Arabic (assets and the API never get the prefix)
    assert.doesNotMatch(noScripts(html), /\shref="\/(shop|about|faq|services|returns)"/, `${arPath}: no English menu links`);
    assert.match(html, /<script src="\/api\.js(\?v=[a-f0-9]+)?"><\/script>/);
  }
});

test('the English pages are unchanged and name their Arabic twin', async () => {
  for (const en of publicPaths()) {
    const res = await get(en);
    assert.equal(res.status, 200, en);
    const html = res.text;
    assert.match(html, /<html lang="en"/, en);
    assert.doesNotMatch(html.match(/<html[^>]*>/)[0], /dir="rtl"/, en);
    assert.equal(canonical(html), BASE + en, `${en}: canonical`);
    assert.equal(alt(html, 'ar'), BASE + (en === '/' ? '/ar' : `/ar${en}`), `${en}: hreflang ar`);
    assert.equal(alt(html, 'x-default'), BASE + en);
    assert.doesNotMatch(html, /href="\/rtl\.css|window\.TROVE_I18N=/,`${en}: nothing Arabic loaded`);
    assert.match(html, /data-lang-switch href="\/ar[^"]*"/, `${en}: the switch points at the twin`);
  }
});

test('Arabic pages say it in Arabic: titles, prices isolated, the switch back to English', async () => {
  const about = (await get('/ar/about')).text;
  assert.match(about, /<h1>عن Trove<\/h1>/);
  assert.match(about, /id="curation"/, 'anchors match the English page');
  assert.match(about, /data-lang-switch href="\/about\?hl=en"[^>]*>English</);
  const faq = (await get('/ar/faq')).text;
  const faqLd = ld(faq).find((n) => n['@type'] === 'FAQPage');
  assert.ok(faqLd.mainEntity.length > 10);
  for (const q of faqLd.mainEntity) { assert.match(q.name, ARABIC); assert.match(q.acceptedAnswer.text, ARABIC); }
  assert.match(faq, /id="makers"/);
  const returns = (await get('/ar/returns')).text;
  assert.match(returns, /⁦AED 30⁩/, 'prices sit in a left-to-right isolate');
  const contact = (await get('/ar/contact')).text;
  assert.match(contact, /الخصوصية وبياناتي/, 'the privacy topic label the Arabic legal text names');
  assert.match(contact, /m\.textContent="شكراً لك/, 'the form script answers in Arabic');
  const shop = (await get('/ar/shop')).text;
  assert.match(shop, /تسوّق الكل/);
  const p = livePiece();
  const piece = (await get(`/ar${seo.pieceUrl(p)}`)).text;
  assert.match(piece, /أضف إلى السلة|تصل خلال/);
  const services = (await get('/ar/services')).text;
  assert.match(services, /سوق الخدمات/);
});

test('private pages carry no hreflang; misses are an Arabic 404; old addresses are untouched', async () => {
  for (const p of ['/ar/account', '/ar/login', '/ar/sell']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(res.text, /hreflang=/, `${p}: no hreflang on a private page`);
    assert.match(res.text, /<html lang="ar" dir="rtl"/);
  }
  const miss = await get('/ar/no-such-page');
  assert.equal(miss.status, 404);
  assert.match(miss.text, /<html lang="ar" dir="rtl"/);
  assert.match(miss.text, ARABIC);
  assert.equal((await get('/ar/admin')).status, 404, 'the admin has no Arabic twin');
  assert.equal((await get('/ar/xyz')).status, 404);
  for (const p of ['/', '/shop', '/about', '/terms']) assert.equal((await get(p)).status, 200, p);
});

test('redirects keep the /ar prefix; the reader’s choice is remembered and ?hl=en forgets it', async () => {
  let r = await get('/ar/Shop');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/ar/shop');
  r = await get('/ar/shop/');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/ar/shop');
  const p = livePiece();
  r = await get(`/ar/pieces/${p.id}-wrong-slug`);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), `/ar${seo.pieceUrl(p)}`);
  r = await get('/ar/help');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/ar/faq');
  // an Arabic page remembers the choice
  r = await get('/ar/about');
  assert.match(r.headers.get('set-cookie') || '', /trove_lang=ar/);
  // …so an English page asked for with it goes to the twin
  r = await get('/shop', { cookie: 'trove_lang=ar' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/ar/shop');
  r = await get('/shop?q=vase', { cookie: 'trove_lang=ar' });
  assert.equal(r.headers.get('location'), '/ar/shop?q=vase');
  // ?hl=en switches back and forgets it
  r = await get('/shop?hl=en', { cookie: 'trove_lang=ar' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/shop');
  assert.match(r.headers.get('set-cookie') || '', /trove_lang=en/);
  r = await get('/shop', { cookie: 'trove_lang=en' });
  assert.equal(r.status, 200);
  // the API is never redirected
  r = await ctx.api('GET', '/api/products', { cookie: 'trove_lang=ar' });
  assert.equal(r.status, 200);
});

test('the sitemap lists both languages with their alternates; robots covers the Arabic twins', async () => {
  const map = (await ctx.api('GET', '/sitemap.xml')).text;
  assert.match(map, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.match(map, new RegExp(`<loc>${BASE}/ar</loc>`));
  assert.match(map, new RegExp(`<loc>${BASE}/ar/about</loc>`));
  assert.match(map, new RegExp(`<xhtml:link rel="alternate" hreflang="ar" href="${BASE}/ar/faq"/>`));
  assert.match(map, new RegExp(`<xhtml:link rel="alternate" hreflang="x-default" href="${BASE}/faq"/>`));
  const en = [...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((l) => !l.startsWith(`${BASE}/ar`));
  const ar = [...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((l) => l.startsWith(`${BASE}/ar`));
  assert.equal(en.length, ar.length, 'one Arabic address per English one');
  const robots = (await ctx.api('GET', '/robots.txt')).text;
  for (const line of ['Disallow: /ar/account', 'Disallow: /ar/sell', 'Allow: /ar/sell-on-trove', 'Disallow: /ar/services/booking/']) assert.ok(robots.includes(line), line);
});

const LEGAL = [['/terms', 'buyer-terms', 'buyer-terms'], ['/privacy', 'privacy', 'privacy'], ['/seller-agreement', 'seller-agreement', 'seller-agreement'],
  ['/provider-agreement', 'provider-agreement', 'provider-agreement'], ['/services-terms', 'services-terms', 'services-terms']];

test('the legal pages serve the Arabic translation with its note; the English stays the version that applies', async () => {
  const sitePages = require('../src/site-pages');
  for (const [p, file, api] of LEGAL) {
    const d = sitePages.legalDoc(api);
    const arFile = path.join(LEGAL_DIR, `${file}-${d.version}-ar.md`);
    const html = (await get(`/ar${p}`)).text;
    assert.match(html, /<html lang="ar" dir="rtl"/);
    assert.ok(html.includes(d.sha256), `${p}: the English hash is shown`);
    assert.match(html, new RegExp(`href="/api/legal/${api}"`), `${p}: the machine-readable English copy`);
    assert.match(html, new RegExp(`data-lang-switch href="${p}\\?hl=en"`), `${p}: a way back to the English version`);
    const json = (await ctx.api('GET', `/api/legal/${api}?lang=ar`)).data;
    assert.equal(json.sha256, d.sha256, `${p}: acceptance keeps the English hash`);
    assert.equal(json.markdown, d.markdown);
    if (fs.existsSync(arFile)) {
      assert.match(html, /class="tr-note"/, `${p}: the translation note`);
      assert.match(html, /الإنجليزي/, `${p}: the note names the English text as the one that prevails`);
      assert.doesNotMatch(noScripts(html), /<h2 id="">/, `${p}: every section heading has an anchor`);
      assert.ok(json.arabic && json.arabic.markdown.length > 500, `${p}: the API carries the Arabic`);
      assert.equal(json.arabic.translationOf, d.sha256);
    } else {
      assert.match(html, /tr-note/);
    }
    const plain = (await ctx.api('GET', `/api/legal/${api}`)).data;
    assert.equal(plain.arabic, undefined, 'English callers get the English only');
  }
});

test('what people wrote shows in Arabic only while its translation is current', async () => {
  const tr = require('../src/translate');
  const p = livePiece();
  const row = db.prepare('SELECT name, description FROM products WHERE id = ?').get(p.id);
  const put = db.prepare(`INSERT OR REPLACE INTO translations (entity, entity_id, field, lang, text, source_hash, source_text)
    VALUES ('product', ?, ?, 'ar', ?, ?, ?)`);
  put.run(String(p.id), 'name', 'كوب خزفي مضلّع', tr.sha(row.name), row.name);
  put.run(String(p.id), 'description', 'وصف عربي للقطعة', tr.sha(row.description), row.description);
  let html = (await get(`/ar${seo.pieceUrl(p)}`)).text;
  assert.match(html, /كوب خزفي مضلّع/);
  assert.match(html, /وصف عربي للقطعة/);
  // the English page never shows it
  assert.doesNotMatch((await get(seo.pieceUrl(p))).text, /كوب خزفي مضلّع/);
  // the maker changes the English: the Arabic page falls back to it
  db.prepare('UPDATE products SET description = description || ? WHERE id = ?').run(' Now in sand.', p.id);
  html = (await get(`/ar${seo.pieceUrl(p)}`)).text;
  assert.doesNotMatch(html, /وصف عربي للقطعة/);
  assert.ok(html.includes('Now in sand.'));
  assert.match(html, /كوب خزفي مضلّع/, 'the unchanged name keeps its Arabic');
  db.prepare("DELETE FROM translations WHERE entity = 'product' AND entity_id = ?").run(String(p.id));
});

test('Arabic pages give the cookie banner Arabic text (iubenda has no Arabic)', async () => {
  const html = (await get('/ar/about')).text;
  const cfg = html.match(/_iub\.csConfiguration=\{lang:"ar",banner:(\{.*?\}),/);
  assert.ok(cfg, 'banner config present');
  const banner = JSON.parse(cfg[1]);
  assert.equal(banner.acceptButtonCaption, 'قبول');
  assert.equal(banner.rejectButtonCaption, 'رفض');
  assert.match(banner.content, /\/ar\/privacy/);
  assert.doesNotMatch(banner.content, /تسويق|إعلانات مخصصة/, 'no marketing purpose');
  const en = (await get('/about')).text;
  assert.doesNotMatch(en, /banner:\{/, 'English pages keep the dashboard text');
});
