'use strict';
/**
 * Clean, crawlable addresses (src/seo.js): every public view of the
 * storefront and the Services Marketplace has its own URL, served with its
 * own head tags, JSON-LD and real text; the old query addresses 301 there;
 * anything unknown or unapproved is a real 404 with noindex. The sitemap
 * lists only clean URLs with real last-modified dates, and robots.txt never
 * blocks what the sitemap submits.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });

const BASE = 'https://troveathome.com';
const DOCS = path.join(__dirname, '..', '..', 'docs');
let ctx; let seo; let db;
before(async () => {
  ctx = await startApp();
  require('../src/seed');
  seo = require('../src/seo');
  db = ctx.db;
});
after(async () => { await ctx.close(); });

const get = (p) => ctx.api('GET', p, { headers: { accept: 'text/html' } });
const noScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ');
const visible = (html) => noScripts(html).replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const h1s = (html) => (noScripts(html).match(/<h1[\s>][\s\S]*?<\/h1>/g) || []);
const ld = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .flatMap((m) => { const o = JSON.parse(m[1]); return o['@graph'] || [o]; });
const meta = (html, re) => { const m = html.match(re); return m ? m[1] : null; };
const title = (html) => meta(html, /<title>([^<]*)<\/title>/);
const canonical = (html) => meta(html, /<link rel="canonical" href="([^"]*)"/);
const description = (html) => meta(html, /<meta name="description" content="([^"]*)"/);
const typeOf = (node) => [].concat(node['@type']);

const livePiece = () => db.prepare(`SELECT p.id, p.name, p.description, p.price_cents, s.name AS shop, s.slug FROM products p
  JOIN shops s ON s.id = p.shop_id WHERE p.status = 'live' AND s.status = 'approved' ORDER BY p.id LIMIT 1`).get();

/* ---------------- pieces ---------------- */
test('a piece has its own server-rendered page: head tags, JSON-LD and its text in the HTML', async () => {
  const p = livePiece();
  const url = seo.pieceUrl(p);
  assert.match(url, new RegExp(`^/pieces/${p.id}-[a-z0-9-]+$`));
  const res = await get(url);
  assert.equal(res.status, 200);
  const html = res.text;
  assert.equal(title(html).replace(/&amp;/g, '&'), `${p.name} by ${p.shop} · Trove`);
  assert.equal(canonical(html), BASE + url);
  assert.match(description(html), /^AED \d/);
  assert.match(html, /<meta property="og:type" content="product">/);
  assert.match(html, new RegExp(`<meta property="og:url" content="${BASE}${url}">`));
  assert.match(html, /<meta property="og:image" content="https:\/\/[^"]+">/, 'an absolute image');
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  // the view is on, and its text is real HTML for a crawler without JavaScript
  assert.match(html, /<div class="view active" id="view-pdp">/);
  assert.doesNotMatch(html, /<div class="view active" id="view-home">/);
  const text = visible(html);
  for (const t of [p.name, p.shop, `AED ${p.price_cents / 100}`, p.description.slice(0, 40)]) assert.ok(text.includes(t), `the page text includes ${t}`);
  assert.equal(h1s(html).length, 1);
  assert.match(h1s(html)[0], new RegExp(p.name));
  assert.match(html, new RegExp(`href="/makers/${p.slug}"`), 'the maker is a real link');
  // structured data: Product + Offer in AED (Trove sells, the maker made it) and breadcrumbs
  const nodes = ld(html);
  const prod = nodes.find((n) => typeOf(n).includes('Product'));
  assert.ok(prod, 'Product');
  assert.equal(prod.name, p.name);
  assert.equal(prod.url, BASE + url);
  assert.equal(prod.brand.name, p.shop);
  assert.equal(prod.offers.priceCurrency, 'AED');
  assert.equal(prod.offers.price, (p.price_cents / 100).toFixed(2));
  assert.match(prod.offers.availability, /^https:\/\/schema\.org\/(InStock|OutOfStock)$/);
  assert.equal(prod.offers.seller['@id'], `${BASE}/#organization`);
  assert.ok(nodes.some((n) => n['@id'] === `${BASE}/#organization`), 'the seller it points at is on the page');
  const crumbs = nodes.find((n) => typeOf(n).includes('BreadcrumbList'));
  assert.deepEqual(crumbs.itemListElement.map((i) => i.name).slice(0, 2), ['Trove', 'Shop all']);
  assert.equal(crumbs.itemListElement.at(-1).item, BASE + url);
});

test('a sold-out piece says so in its Offer', async () => {
  const p = livePiece();
  const before = db.prepare('SELECT stock FROM products WHERE id = ?').get(p.id).stock;
  db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(p.id);
  try {
    const prod = ld((await get(seo.pieceUrl(p))).text).find((n) => typeOf(n).includes('Product'));
    assert.equal(prod.offers.availability, 'https://schema.org/OutOfStock');
  } finally { db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(before, p.id); }
});

test('a wrong or missing slug 301s to the canonical piece address, query kept', async () => {
  const p = livePiece();
  const url = seo.pieceUrl(p);
  for (const variant of [`/pieces/${p.id}`, `/pieces/${p.id}-not-the-name`, `/pieces/${p.id}-not-the-name?utm_source=wa`]) {
    const res = await get(variant);
    assert.equal(res.status, 301, variant);
    assert.equal(res.headers.get('location'), url + (variant.includes('?') ? '?utm_source=wa' : ''), variant);
  }
});

test('unknown, delisted and unapproved pieces are a real 404 with noindex', async () => {
  const draft = db.prepare("SELECT p.id, p.name FROM products p WHERE p.status != 'live' LIMIT 1").get();
  const pending = db.prepare(`SELECT p.id, p.name FROM products p JOIN shops s ON s.id = p.shop_id WHERE s.status != 'approved' LIMIT 1`).get();
  const misses = ['/pieces/99999-nothing', '/pieces/99999', '/pieces/abc', '/pieces/1.5'];
  if (draft) misses.push(seo.pieceUrl(draft));
  if (pending) misses.push(seo.pieceUrl(pending));
  for (const u of misses) {
    const res = await get(u);
    assert.equal(res.status, 404, u);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, u);
    assert.match(res.text, /<meta name="robots" content="noindex">/, u);
  }
});

/* ---------------- makers ---------------- */
test('a maker has its own page with the shop text, and its pieces as links and an ItemList', async () => {
  const s = db.prepare("SELECT id, name, slug, bio FROM shops WHERE status = 'approved' AND is_house = 0 ORDER BY id LIMIT 1").get();
  const pieces = db.prepare("SELECT id, name FROM products WHERE shop_id = ? AND status = 'live'").all(s.id);
  const res = await get(`/makers/${s.slug}`);
  assert.equal(res.status, 200);
  const html = res.text;
  assert.match(title(html).replace(/&amp;/g, '&'), new RegExp(`^${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(canonical(html), `${BASE}/makers/${s.slug}`);
  assert.match(html, /<div class="view active" id="view-vendor">/);
  assert.equal(h1s(html).length, 1);
  assert.ok(visible(h1s(html)[0]).includes(s.name));
  if (s.bio) assert.ok(visible(html).includes(s.bio.slice(0, 30)));
  for (const p of pieces) assert.ok(html.includes(`href="${seo.pieceUrl(p)}"`), `links to ${p.name}`);
  const list = ld(html).find((n) => typeOf(n).includes('ItemList'));
  assert.equal(list.numberOfItems, pieces.length);
  assert.ok(list.itemListElement.every((i) => i.url.startsWith(`${BASE}/pieces/`)));
  assert.ok(ld(html).some((n) => typeOf(n).includes('Organization') && n.name === s.name));
});

test('unknown and unapproved makers are a real 404; a capitalised slug folds to lowercase', async () => {
  const pending = db.prepare("SELECT slug FROM shops WHERE status != 'approved' LIMIT 1").get();
  assert.ok(pending, 'the seed has a shop under review');
  for (const u of ['/makers/no-such-maker', `/makers/${pending.slug}`]) {
    const res = await get(u);
    assert.equal(res.status, 404, u);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  }
  const s = db.prepare("SELECT slug FROM shops WHERE status = 'approved' AND is_house = 0 LIMIT 1").get(); // (the Collection's page is its shelf)
  const res = await get(`/Makers/${s.slug.toUpperCase()}/`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), `/makers/${s.slug}`);
});

/* ---------------- shop, categories, sell ---------------- */
test('/shop and /shop/<category> are real pages; an unknown category is a 404; a search is noindex', async () => {
  let res = await get('/shop');
  assert.equal(res.status, 200);
  assert.equal(title(res.text), 'Shop all homeware · Trove');
  assert.match(res.text, /<div class="view active" id="view-shop">/);
  assert.equal(h1s(res.text).length, 1);
  const live = db.prepare(`SELECT p.id, p.name, p.category FROM products p JOIN shops s ON s.id = p.shop_id
    WHERE p.status = 'live' AND s.status = 'approved'`).all();
  for (const p of live) assert.ok(res.text.includes(`href="${seo.pieceUrl(p)}"`), `/shop links to ${p.name}`);

  const cat = live[0].category;
  res = await get(seo.shopUrl(cat));
  assert.equal(res.status, 200);
  assert.equal(canonical(res.text), BASE + seo.shopUrl(cat));
  assert.ok(visible(h1s(res.text)[0]).includes(cat));
  for (const p of live) assert.equal(res.text.includes(`href="${seo.pieceUrl(p)}"`), p.category === cat, p.name);

  res = await get('/shop/trove-collection');
  assert.equal(res.status, 200);
  assert.ok(visible(h1s(res.text)[0]).includes('Trove Collection'));

  res = await get('/shop/not-a-category');
  assert.equal(res.status, 404);
  res = await get('/shop?q=mug');
  assert.equal(res.status, 200);
  assert.match(res.text, /<meta name="robots" content="noindex, follow">/);
  assert.equal(canonical(res.text), `${BASE}/shop`);
});

test('the maker pitch has its own crawlable address: /sell-on-trove', async () => {
  const res = await get('/sell-on-trove');
  assert.equal(res.status, 200);
  assert.match(res.text, /<div class="view active" id="view-sell">/);
  assert.equal(canonical(res.text), `${BASE}/sell-on-trove`);
  assert.equal(h1s(res.text).length, 1);
  assert.match(visible(h1s(res.text)[0]), /You make the pieces/);
  assert.match(description(res.text), /keep 60%/);
});

/* ---------------- old addresses ---------------- */
test('the old query addresses 301 to the clean ones, keeping the parameters that matter', async () => {
  const p = livePiece();
  const s = db.prepare("SELECT slug FROM shops WHERE status = 'approved' AND is_house = 0 LIMIT 1").get(); // (the Collection's page is its shelf)
  const cases = [
    [`/?p=${p.id}`, seo.pieceUrl(p)],
    [`/?p=${p.id}&utm_source=wa`, `${seo.pieceUrl(p)}?utm_source=wa`],
    ['/?p=99999', '/pieces/99999'],
    [`/?shop=${s.slug}&utm_campaign=x`, `/makers/${s.slug}?utm_campaign=x`],
    ['/?view=shop', '/shop'],
    ['/?view=shop&cat=House', '/shop/trove-collection'],
    ['/?view=shop&cat=Ceramics', '/shop/ceramics'],
    ['/?view=sell', '/sell-on-trove'],
    ['/?view=shop&cart=1', '/shop?cart=1'],
  ];
  for (const [from, to] of cases) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
  assert.equal((await get('/pieces/99999')).status, 404, 'an unknown old piece id ends in a real 404, never a soft one');
  // the header's search and basket links are not old addresses
  assert.equal((await get('/?q=mug')).status, 200);
  assert.equal((await get('/?cart=1')).status, 200);
});

/* ---------------- Services Marketplace ---------------- */
test('a provider page is server-rendered: name, bio, location, services with AED prices, LocalBusiness JSON-LD', async () => {
  const pr = db.prepare("SELECT id, name, slug, bio, location FROM service_providers WHERE status = 'approved' ORDER BY id LIMIT 1").get();
  const services = db.prepare("SELECT title, price_cents, price_type FROM services WHERE provider_id = ? AND status = 'live'").all(pr.id);
  assert.ok(services.length, 'the seed gives the provider live services');
  const res = await get(`/services/${pr.slug}`);
  assert.equal(res.status, 200);
  const html = res.text;
  assert.equal(canonical(html), `${BASE}/services/${pr.slug}`);
  assert.match(title(html).replace(/&amp;/g, '&'), new RegExp(`Trove Services Marketplace$`));
  assert.ok(title(html).replace(/&amp;/g, '&').startsWith(pr.name));
  assert.match(html, /<body class="pv">/);
  assert.match(html, /<section id="pview">/, 'the provider view is shown, not hidden');
  assert.equal(h1s(html).length, 1);
  assert.ok(visible(h1s(html)[0]).includes(pr.name));
  const text = visible(html);
  assert.ok(text.includes(pr.bio.slice(0, 30)));
  assert.ok(text.includes(pr.location));
  for (const s of services) assert.ok(text.includes(s.title), s.title);
  if (services.some((s) => s.price_type === 'from')) assert.match(text, /From AED \d/);
  assert.doesNotMatch(text, / 's own/, 'no sentence with an empty name');
  assert.match(text, /Every price here is the provider's own/);
  const biz = ld(html).find((n) => typeOf(n).includes('LocalBusiness'));
  assert.ok(typeOf(biz).includes('ProfessionalService'));
  assert.equal(biz.name, pr.name);
  assert.deepEqual(biz.areaServed.map((a) => a.name), ['Dubai', 'Abu Dhabi']);
  assert.equal(biz.hasOfferCatalog.itemListElement.length, services.length);
  for (const o of biz.hasOfferCatalog.itemListElement) {
    assert.equal(o['@type'], 'Offer');
    assert.equal(o.priceCurrency, 'AED');
    assert.equal(o.itemOffered['@type'], 'Service');
  }
});

test('unknown and unapproved providers are a real 404; /services variants 301 to one address', async () => {
  const pending = db.prepare("SELECT slug FROM service_providers WHERE status != 'approved' LIMIT 1").get();
  assert.ok(pending, 'the seed has a provider under review');
  for (const u of ['/services/no-such-provider', `/services/${pending.slug}`]) {
    const res = await get(u);
    assert.equal(res.status, 404, u);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  }
  for (const [from, to] of [['/Services', '/services'], ['/services/', '/services'], ['/SERVICES/', '/services'], ['/Services?x=1', '/services?x=1'], ['/Shop/Ceramics/', '/shop/ceramics'], ['/about/', '/about']]) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
  // booking links keep their case: the code in them is case-sensitive
  assert.notEqual((await get('/services/booking/SRV-ABC123')).status, 301);
});

test('the services directory is server-rendered: categories, services and providers as links', async () => {
  const res = await get('/services');
  assert.equal(res.status, 200);
  const html = res.text;
  assert.equal(h1s(html).length, 1);
  assert.match(visible(h1s(html)[0]), /Skilled hands/);
  const providers = db.prepare("SELECT slug FROM service_providers WHERE status = 'approved'").all();
  for (const p of providers) assert.ok(html.includes(`href="/services/${p.slug}"`), p.slug);
  assert.match(html, /<section class="band" id="providers">/, 'the providers band is shown');
  assert.match(visible(html), /Made to order & personalisation/);
  assert.ok(ld(html).some((n) => typeOf(n).includes('ItemList') && n.numberOfItems === providers.length));
});

/* ---------------- site-wide head tags ---------------- */
const PUBLIC = () => {
  const p = livePiece();
  const s = db.prepare("SELECT slug FROM shops WHERE status = 'approved' AND is_house = 0 LIMIT 1").get(); // (the Collection's page is its shelf)
  const pr = db.prepare("SELECT slug FROM service_providers WHERE status = 'approved' LIMIT 1").get();
  return ['/', '/shop', '/shop/ceramics', seo.pieceUrl(p), `/makers/${s.slug}`, '/sell-on-trove', '/services', `/services/${pr.slug}`,
    '/about', '/faq', '/returns', '/contact', '/terms', '/privacy', '/seller-agreement', '/apply'];
};

test('every public page: Open Graph + Twitter tags, a canonical, a unique title and description, one h1', async () => {
  const titles = new Map(); const descs = new Map();
  for (const u of PUBLIC()) {
    const res = await get(u);
    assert.equal(res.status, 200, u);
    const html = res.text;
    for (const re of [/<meta property="og:title" content="[^"]+">/, /<meta property="og:description" content="[^"]+">/,
      /<meta property="og:image" content="https?:\/\/[^"]+">/, /<meta property="og:url" content="https?:\/\/[^"]+">/,
      /<meta name="twitter:card" content="summary_large_image">/, /<link rel="canonical" href="https?:\/\/[^"]+">/]) {
      assert.match(html, re, `${u}: ${re}`);
    }
    assert.equal((html.match(/<title>/g) || []).length, 1, `${u}: one title`);
    assert.equal((html.match(/<meta name="description"/g) || []).length, 1, `${u}: one description`);
    assert.equal(h1s(html).length, 1, `${u}: one h1`);
    if (u !== '/apply') { // the application form is its own page (not the shared header)
      assert.match(html, /<main[^>]*id="main"/, `${u}: a main landmark`);
      assert.match(html, /<a class="skip" href="#main">/, `${u}: a skip link`);
    }
    const t = title(html); const d = description(html);
    assert.ok(!titles.has(t), `${u}: title also used by ${titles.get(t)}`);
    assert.ok(!descs.has(d), `${u}: description also used by ${descs.get(d)}`);
    titles.set(t, u); descs.set(d, u);
  }
});

test('the default share image, favicon.ico and web manifest are served; no page asks for the missing wordmark', async () => {
  const og = await fetch(ctx.baseUrl + '/img/og-default.jpg');
  assert.equal(og.status, 200);
  assert.match(og.headers.get('content-type'), /image\/jpeg/);
  const buf = Buffer.from(await og.arrayBuffer());
  assert.ok(buf.length < 150 * 1024, `og-default.jpg is ${buf.length} bytes`);
  // JPEG SOF0 frame: 1200 x 630
  const sof = buf.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0);
  assert.deepEqual([buf.readUInt16BE(sof + 7), buf.readUInt16BE(sof + 5)], [1200, 630]);
  const ico = await fetch(ctx.baseUrl + '/favicon.ico');
  assert.equal(ico.status, 200);
  assert.deepEqual([...Buffer.from(await ico.arrayBuffer()).subarray(0, 4)], [0, 0, 1, 0], 'an ICO file');
  const man = await fetch(ctx.baseUrl + '/site.webmanifest');
  assert.equal(man.status, 200);
  const m = JSON.parse(await man.text());
  assert.equal(m.name, 'Trove');
  for (const i of m.icons) assert.equal((await fetch(ctx.baseUrl + i.src)).status, 200, i.src);
  for (const u of ['/', '/services', '/about', seo.pieceUrl(livePiece())]) {
    assert.doesNotMatch((await get(u)).text, /trove-wordmark/, `${u} requests no wordmark file`);
  }
});

/* ---------------- sitemap + robots ---------------- */
test('the sitemap lists clean addresses only, with real last-modified dates', async () => {
  const p = livePiece();
  db.prepare("UPDATE products SET updated_at = '2026-01-02 10:00:00' WHERE id = ?").run(p.id);
  let map = (await get('/sitemap.xml')).text;
  const entry = (loc) => { const m = map.match(new RegExp(`<url><loc>${loc.replace(/[.?]/g, '\\$&')}</loc>(?:<lastmod>([^<]+)</lastmod>)?`)); return m && { lastmod: m[1] }; };
  assert.equal(entry(BASE + seo.pieceUrl(p)).lastmod, '2026-01-02', 'lastmod is the piece\'s updated_at');
  // an edit stamps it (the trigger), so the next crawl sees the change
  db.prepare('UPDATE products SET description = description || ? WHERE id = ?').run(' ', p.id);
  const stamped = db.prepare('SELECT updated_at FROM products WHERE id = ?').get(p.id).updated_at;
  assert.notEqual(stamped, '2026-01-02 10:00:00');
  map = (await get('/sitemap.xml')).text;
  assert.equal(entry(BASE + seo.pieceUrl(p)).lastmod, stamped.slice(0, 10));
  // the maker's lastmod follows its newest piece
  assert.equal(entry(`${BASE}/makers/${p.slug}`).lastmod >= stamped.slice(0, 10), true);

  for (const u of ['/', '/shop', '/sell-on-trove', '/services', '/about', '/faq', '/returns', '/terms', '/privacy']) assert.ok(entry(BASE + u), `lists ${u}`);
  for (const pr of db.prepare("SELECT slug FROM service_providers WHERE status = 'approved'").all()) assert.ok(entry(`${BASE}/services/${pr.slug}`), pr.slug);
  const locs = [...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(new Set(locs).size, locs.length, 'no duplicates');
  for (const l of locs) {
    assert.doesNotMatch(l, /\?/, `${l}: no query strings`);
    assert.doesNotMatch(l, /\/apply|\/delivery-returns|\/login|\/account|\/sell$|\/admin/, `${l}: nothing thin, duplicate or private`);
  }
  // every submitted address answers 200 (no redirects, no 404s)
  for (const l of locs) assert.equal((await get(l.replace(BASE, ''))).status, 200, l);
});

/** robots.txt as Google reads it: longest matching rule wins, Allow wins a tie. */
function robotsAllows(robots, p) {
  let best = { len: -1, allow: true };
  for (const line of robots.split('\n')) {
    const m = line.match(/^(Allow|Disallow):\s*(\S*)/);
    if (!m || !m[2]) continue;
    if (p.startsWith(m[2]) && (m[2].length > best.len || (m[2].length === best.len && m[1] === 'Allow'))) best = { len: m[2].length, allow: m[1] === 'Allow' };
  }
  return best.allow;
}

test('robots.txt blocks the private paths and nothing the sitemap submits', async () => {
  const robots = (await get('/robots.txt')).text;
  for (const p of ['/admin', '/account', '/sell', '/sell?connect=done', '/provider', '/login', '/api/products', '/services/booking/SRV-1', '/reset']) {
    assert.equal(robotsAllows(robots, p), false, `${p} is blocked`);
  }
  const map = (await get('/sitemap.xml')).text;
  for (const [, loc] of map.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    assert.equal(robotsAllows(robots, loc.replace(BASE, '')), true, `${loc} is submitted AND allowed`);
  }
  assert.equal(robotsAllows(robots, '/sell-on-trove'), true);
});

/* ---------------- one slug everywhere ---------------- */
test('the storefront and Services pages build the same addresses as the server', () => {
  const grab = (file) => {
    const src = fs.readFileSync(path.join(DOCS, file), 'utf8');
    const m = src.match(/function slugify\(s\)\{[^\n]*\}/);
    assert.ok(m, `${file} has slugify()`);
    const sandbox = {};
    vm.runInNewContext(`${m[0]}; this.slugify = slugify;`, sandbox);
    return sandbox.slugify;
  };
  const names = ['Reeded Stoneware Mug', 'Kitchen & Dining', "Children's", 'Café Crème — Large', '  Trailing -- dashes!! ', 'كوب فخار', 'A'.repeat(120), 'Wellness & Self-Care'];
  for (const file of ['trove.html', 'trove-services.html']) {
    const client = grab(file);
    for (const n of names) assert.equal(client(n), seo.slugify(n), `${file}: ${n}`);
  }
  assert.equal(seo.slugify('Kitchen & Dining'), 'kitchen-and-dining');
  assert.equal(seo.slugify("Children's"), 'childrens');
  assert.equal(seo.pieceUrl({ id: 7, name: 'كوب فخار' }), '/pieces/7', 'a name with no latin letters keeps a bare id');
});

test('the storefront routes clean addresses in the page: pushState, popstate and real links', () => {
  const store = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8');
  assert.match(store, /history\.pushState\(/);
  assert.match(store, /addEventListener\('popstate'/);
  assert.ok(!store.includes("q.get('cart'))history.replaceState({},'',location.pathname)"), 'the address is no longer stripped back to /');
  assert.doesNotMatch(store, /onclick="openPDP\(|onclick="openVendor\(/, 'cards are links, not click handlers');
  assert.doesNotMatch(store, /href="#" onclick="go\(/, 'no href="#" navigation left');
  assert.match(store, /<script src="\/config\.js"><\/script>/, 'scripts load from the root at nested addresses');
  for (const f of ['trove.html', 'trove-services.html']) {
    const html = fs.readFileSync(path.join(DOCS, f), 'utf8');
    assert.doesNotMatch(html, /(href="|'|`)\/\?(p|shop|view)=/, `${f} links only to clean addresses`);
  }
});

test('the storefront and every Services view send exactly one <h1> in the raw page, scripts included', async () => {
  // A crawler that reads the source (or a naive audit) counts <h1 anywhere, so
  // not even the page's own script may carry a literal one.
  const pr = db.prepare("SELECT slug FROM service_providers WHERE status = 'approved' LIMIT 1").get();
  for (const u of ['/services', `/services/${pr.slug}`, '/', '/shop', seo.pieceUrl(livePiece())]) {
    const html = (await get(u)).text;
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${u}: raw <h1> count`);
    assert.equal(h1s(html).length, 1, `${u}: rendered <h1> count`);
  }
  const dir = (await get('/services')).text;
  assert.match(h1s(dir)[0], /Skilled hands/);
  const one = (await get(`/services/${pr.slug}`)).text;
  assert.match(one, /<h1 id="pvName"[^>]*>[^<]+<\/h1>/, 'the provider name is the page heading');
});
