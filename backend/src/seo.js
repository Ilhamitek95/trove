'use strict';
/**
 * Server-rendered addresses for the storefront and the Services Marketplace.
 *
 * The storefront (docs/trove.html) and the Services page (trove-services.html)
 * are single pages that build every view in the browser. Search engines, AI
 * answer engines and link previews mostly do not run that script, so each
 * public view has its own clean address and the server sends the page with:
 *
 *   - its own <title>, meta description, canonical, Open Graph + Twitter tags
 *   - JSON-LD (Product + Offer, BreadcrumbList, the maker, the provider…)
 *   - the view already switched on and its key text written into the markup
 *     the page's own script fills later (name, price, description, maker…),
 *     so a crawler without JavaScript reads the same page a shopper sees
 *   - exactly one <h1>: the active view's
 *
 * Addresses (slugs come from slugify(), mirrored in the two pages' scripts):
 *   /                          home
 *   /shop, /shop/<category>    shop all, one category (/shop/trove-collection = the house line)
 *   /pieces/<id>-<slug>        a piece (a wrong slug 301s to the right one)
 *   /makers/<shop-slug>        a maker's shop
 *   /sell-on-trove             the maker pitch
 *   /services, /services/<slug>  the directory, a provider
 * The old query addresses (/?p=, /?shop=, /?view=) 301 here (see app.js).
 * Anything unknown, delisted or unapproved is a real 404 (noindex).
 */
const fs = require('fs');
const path = require('path');
const { esc } = require('./markdown');
const sitePages = require('./site-pages');
const content = require('./content');
const fees = require('./fees');
const tax = require('./service-taxonomy');
const i18n = require('./i18n');
const tr = require('./translate');

const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');
const OG_IMAGE = '/img/og-default.jpg';
const OG_IMAGE_ALT = 'trove, curated homeware by independent makers in Dubai and Abu Dhabi';

/* ---------------- addresses ---------------- */

/** URL slug of a name. The storefront and Services scripts carry the same function. */
function slugify(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}
const HOUSE_SLUG = 'trove-collection';
const catSlug = (name) => (name === 'House' ? HOUSE_SLUG : slugify(name));
const catLabel = (name) => (name === 'House' ? 'Trove Collection' : name);
// The slug is always made from the English name (an Arabic page's piece carries it as nameEn).
function pieceUrl(p) { const s = slugify(p.nameEn || p.name); return `/pieces/${p.id}${s ? '-' + s : ''}`; }
const makerUrl = (slug) => `/makers/${encodeURIComponent(slug)}`;
/** Where a shop lives: a maker at /makers/<slug>; the Trove Collection is its own shelf. */
const shopHref = (shop) => (shop && shop.isHouse ? `/shop/${HOUSE_SLUG}` : makerUrl(shop.slug));
const shopUrl = (cat) => (!cat || cat === 'all' ? '/shop' : `/shop/${catSlug(cat)}`);
const providerUrl = (slug) => `/services/${encodeURIComponent(slug)}`;

/* ---------------- data (the public API's own shapes) ---------------- */
const products = () => require('./routes/products.routes').publicData;
const shops = () => require('./routes/shops.routes').publicData;
const servicesData = () => require('./routes/services.routes').publicData;

const liveProducts = () => products().liveProducts();
const approvedShops = () => shops().approvedShops();

/* ---------------- small helpers ---------------- */
function money(amount, lang = 'en') {
  const n = Number(amount) || 0;
  return i18n.iso(lang, 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
}
const moneyCents = (c, lang = 'en') => money((Number(c) || 0) / 100, lang);
/** Lookups bound to a language: T(key, vars) and TN(n, one, other, vars), keys in docs/i18n/ar/server.json. */
const tFor = (lang) => [(k, v) => i18n.t(lang, k, v), (n, a, b, v) => i18n.tn(lang, n, a, b, v)];
/** The noun after a separately printed count ('3' + 'pieces'): Arabic takes the plural only for 3–10. */
const noun = (lang, n, one, other) => (lang === 'ar'
  ? i18n.t(lang, n >= 3 && n <= 10 ? other : one)
  : (n === 1 ? one : other));
const abs = (base, u) => (!u ? '' : /^https?:\/\//.test(u) ? u : base + (u.startsWith('/') ? u : '/' + u));
const clip = (s, n = 158) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20)).replace(/[\s,;:.–—-]+$/, '') + '…';
};
/** A meta description: the facts first, then as much of the prose as fits. */
function compose(head, body, tail, n = 158) {
  const room = n - head.length - tail.length;
  const mid = body && room > 24 ? clip(body, room) : '';
  const out = (head + mid).trim() + (mid && !/[.!?…]$/.test(mid) && tail ? '.' : '') + tail;
  return out.trim();
}
const safeImg = (u) => { u = String(u || ''); return /^(\/(?!\/)|https:\/\/)[^"'()\\\s<>]*$/.test(u) ? u : ''; };
const safeColor = (c) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || '')) ? String(c) : '#DBC7BD');
/** A piece's cover: the maker's first photo, else the matched stock shot. */
const coverOf = (p) => safeImg((p.images || [])[0]) || safeImg(p.stockImage) || '';
/** The cover is a stand-in stock shot, not the maker's own photo: the page says so. */
const isStock = (p) => !safeImg((p.images || [])[0]) && !!safeImg(p.stockImage);
const illus = (lang) => `<span class="illus">${esc(i18n.t(lang, 'Illustrative photo'))}</span>`;
const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...obj }).replace(/</g, '\\u003c')}</script>`;

function readDoc(file, cache) {
  const f = path.join(DOCS_DIR, file);
  const stamp = fs.statSync(f).mtimeMs;
  if (cache.stamp !== stamp) { cache.stamp = stamp; cache.html = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); }
  return cache.html;
}
const storeCache = { stamp: 0, html: '' };
const servicesCache = { stamp: 0, html: '' };

/* ---------------- <head> ---------------- */

/** The social + canonical tags every public page carries. */
function socialTags({ base, url, title, description, image, imageAlt, type = 'website', robots, lang = 'en' }) {
  const img = image || base + OG_IMAGE;
  const isDefault = !image;
  return [
    url ? `<link rel="canonical" href="${esc(url)}">` : '',
    robots ? `<meta name="robots" content="${esc(robots)}">` : '',
    `<meta property="og:type" content="${esc(type)}">`,
    '<meta property="og:site_name" content="Trove">',
    '<meta property="og:locale" content="en_GB">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    url ? `<meta property="og:url" content="${esc(url)}">` : '',
    `<meta property="og:image" content="${esc(img)}">`,
    isDefault ? '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">' : '',
    `<meta property="og:image:alt" content="${esc(imageAlt || i18n.t(lang, OG_IMAGE_ALT))}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(img)}">`,
    '<link rel="manifest" href="/site.webmanifest">',
  ].filter(Boolean).join('\n');
}

/** Swap the title + description and add the head tags (+ JSON-LD). */
function setHead(html, opts) {
  const { title, description, ld = [] } = opts;
  let out = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  const meta = `<meta name="description" content="${esc(description)}">`;
  out = /<meta name="description"[^>]*>/.test(out) ? out.replace(/<meta name="description"[^>]*>/, meta) : out.replace('</title>', `</title>\n${meta}`);
  // Trove itself rides along on every page: offers, pages and makers point at it by @id.
  const graph = ldScript({ '@graph': [sitePages.organizationLd(opts.base, content.company()), ...ld] });
  return out.replace('</head>', `${socialTags(opts)}\n${graph}\n</head>`);
}

/**
 * Default social tags for a page served as a static file (apply, sign-in…):
 * added only when the page has none of its own, never replacing anything.
 */
const PAGE_DESCRIPTIONS = {
  '/apply': 'Apply to sell your handmade pieces or offer your services on Trove. A real person reviews every application; makers keep 60% of every sale, delivered across Dubai and Abu Dhabi.',
};
function withDefaultSocial(html, { base, url, noindex = false, path: pagePath }) {
  if (/property="og:title"/.test(html)) return html;
  const fallback = PAGE_DESCRIPTIONS[pagePath] || DEFAULT_DESCRIPTION;
  const t = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Trove';
  const d = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  const title = t.replace(/&amp;/g, '&');
  const description = d ? d.replace(/&amp;/g, '&') : fallback;
  let out = html;
  if (!d) out = out.replace('</title>', `</title>\n<meta name="description" content="${esc(fallback)}">`);
  return out.replace('</head>', `${socialTags({ base, url: noindex ? null : url, title, description })}\n</head>`);
}

/* ---------------- storefront views ---------------- */
const HOME_TITLE = 'Trove · Curated homeware by independent makers in Dubai & Abu Dhabi';
const DEFAULT_DESCRIPTION = 'Handcrafted homeware from independent makers, each piece chosen by hand, delivered across Dubai and Abu Dhabi. Free delivery on orders over AED 200.';

/** Switch the storefront's active view and make its title the page's one <h1>. */
function activate(html, view) {
  let out = html.replace('<div class="view active" id="view-home">', '<div class="view" id="view-home">')
    .replace(`<div class="view" id="view-${view}">`, `<div class="view active" id="view-${view}">`);
  out = out.replace(/<(h1|h2)(\s[^>]*?\bdata-vh="([a-z]+)"[^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, v, inner) => {
    const t = v === view ? 'h1' : 'h2';
    return `<${t}${attrs}>${inner}</${t}>`;
  });
  return out;
}
/** Fill an element (found by id, empty in the source) with server markup. */
function fill(html, id, inner) {
  const re = new RegExp(`(<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>)(</\\2>)`);
  if (!re.test(html)) throw new Error(`seo: #${id} is missing or not empty in the page source`);
  return html.replace(re, (m, open, tag, close) => open + inner + close);
}
/** Replace the plain text of the element with this id (its source may hold a placeholder). */
function text(html, id, value) {
  const re = new RegExp(`(<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>)[^<]*(</\\2>)`);
  if (!re.test(html)) throw new Error(`seo: #${id} is missing or not plain text in the page source`);
  return html.replace(re, (m, open, tag, close) => open + esc(value) + close);
}
/** Set (or add) one attribute on the element with this id. */
function attr(html, id, name, value) {
  const re = new RegExp(`<([a-z0-9]+)\\b([^>]*\\bid="${id}"[^>]*)>`);
  const m = html.match(re);
  if (!m) throw new Error(`seo: #${id} is missing in the page source`);
  let attrs = m[2];
  const a = new RegExp(`\\s${name}="[^"]*"`);
  attrs = a.test(attrs) ? attrs.replace(a, ` ${name}="${esc(value)}"`) : `${attrs} ${name}="${esc(value)}"`;
  return html.replace(m[0], `<${m[1]}${attrs}>`);
}

/** A product card, as the storefront's productCard() draws it (it re-renders over this). */
function cardHtml(p, vendor, lang = 'en') {
  const [T] = tFor(lang);
  const cover = coverOf(p);
  const color = safeColor(p.shop && p.shop.color);
  return `<article class="card">
    <div class="ph"><div class="grad" style="background:${color}"></div>${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">` : ''}${p.compareAt ? `<span class="sale">${esc(T('Sale'))}</span>` : ''}${isStock(p) ? illus(lang) : ''}
      <button class="add" onclick="event.stopPropagation();addToCart(${Number(p.id)},this)">${esc(T('Add to basket'))}</button></div>
    <div class="vrow ${vendor && vendor.isHouse ? 'is-house' : ''}"><span class="gem"></span>${esc(p.shop.name)}</div>
    <h3><a class="card-link" href="${esc(pieceUrl(p))}">${esc(p.name)}</a></h3>
    <div class="foot"><span class="price">${p.compareAt ? `<s>${money(p.compareAt, lang)}</s>` : ''}${money(p.price, lang)}</span></div>
    <button class="add add-row" onclick="event.stopPropagation();addToCart(${Number(p.id)},this)">${esc(T('Add to basket'))}</button>
  </article>`;
}

function crumbLd(base, items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, u], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(u ? { item: base + u } : {}) })),
  };
}
const orgRef = (base) => ({ '@id': `${base}/#organization` });

/**
 * The storefront page, with the facts its script would otherwise apply after
 * the first paint (so nothing moves): no Trove Collection pieces yet →
 * html.house-soon, which swaps the Collection band to its coming-soon copy.
 * The Collection is never hidden (owner, 2026-09-30).
 */
function storefront() {
  let html = readDoc('trove.html', storeCache);
  if (!sitePages.hasHousePieces()) html = html.replace('<html lang="en">', '<html lang="en" class="house-soon">');
  return html;
}
const addHtmlClass = (html, cls) => html.replace(/<html lang="en"( class="([^"]*)")?>/, (m, a, c) => `<html lang="en" class="${c ? c + ' ' : ''}${cls}">`);

/** The one-piece hero, as the storefront's heroSoloHTML() draws it. */
function heroSoloHtml(p, vendor, lang = 'en') {
  const [T] = tFor(lang);
  const meta = p.shop.isHouse ? T('The Trove Collection') : (vendor && vendor.location ? T('Made in {place}', { place: vendor.location }) : '');
  const cover = coverOf(p);
  return `<a class="hsolo" href="${esc(pieceUrl(p))}"><span class="hs-img"><span class="grad" style="background:${safeColor(p.shop.color)}"></span>${cover ? `<img src="${esc(cover)}" alt="${esc(p.name)}" fetchpriority="high" decoding="async">` : ''}${p.compareAt ? `<span class="sale">${esc(T('Sale'))}</span>` : ''}${isStock(p) ? illus(lang) : ''}</span><span class="hs-cap">${meta ? `<span class="hs-meta">${esc(meta)}</span>` : ''}<span class="hs-name">${esc(p.name)}</span><span class="hs-by">${esc(T('by {maker}', { maker: p.shop.name }))}</span><span class="hc-foot"><span class="price">${p.compareAt ? `<s>${money(p.compareAt, lang)}</s>` : ''}${money(p.price, lang)}</span><span class="hc-go">${esc(T('View piece →'))}</span></span></span></a>`;
}
/** One of 'The first pieces', as the storefront's firstPieceHTML() draws it. */
function firstPieceHtml(p, vendor, lang = 'en') {
  const [T] = tFor(lang);
  const where = p.shop.isHouse ? T('The Trove Collection') : [p.shop.name, vendor && vendor.location].filter(Boolean).join(' · ');
  const u = esc(pieceUrl(p));
  const cover = coverOf(p);
  return `<article class="fcard">
    <a class="fc-img" href="${u}" tabindex="-1" aria-hidden="true"><span class="grad" style="background:${safeColor(p.shop.color)}"></span>${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">` : ''}${p.compareAt ? `<span class="sale">${esc(T('Sale'))}</span>` : ''}${isStock(p) ? illus(lang) : ''}</a>
    <div class="fc-body">
      <div class="vrow ${p.shop.isHouse ? 'is-house' : ''}"><span class="gem"></span>${esc(where)}</div>
      <h3><a href="${u}">${esc(p.name)}</a></h3>
      ${p.description ? `<p class="fc-desc">${esc(clip(p.description, 220))}</p>` : ''}
      <span class="price">${p.compareAt ? `<s>${money(p.compareAt, lang)}</s>` : ''}${money(p.price, lang)}</span>
      <div class="fc-acts"><a class="btn btn-dark" href="${u}">${esc(T('See the piece'))}</a>${p.shop.isHouse ? '' : `<a class="txt-link" href="${esc(makerUrl(p.shop.slug))}">${esc(T('More from {maker}', { maker: p.shop.name }))}</a>`}</div>
    </div>
  </article>`;
}

/** The public catalogue in the page's language (Arabic overlays from src/translate.js). */
const productsIn = (lang) => tr.products(liveProducts(), lang);
const shopsIn = (lang) => tr.shops(approvedShops(), lang);

function renderHome(base, lang = 'en') {
  const [T] = tFor(lang);
  const list = productsIn(lang);
  const byShop = Object.fromEntries(shopsIn(lang).map((s) => [s.slug, s]));
  let html = activate(storefront(), 'home');
  // One piece: the editorial hero, drawn now so the first paint is final.
  const heroPicks = (content.getPublic().home || {}).hero;
  if (list.length === 1 && !(heroPicks && Array.isArray(heroPicks.productIds) && heroPicks.productIds.length > 1)) {
    html = html.replace('<div class="hstage" id="heroStage" tabindex="0" aria-roledescription="carousel" aria-label="Featured pieces">', '<div class="hstage solo" id="heroStage" aria-label="Featured piece">');
    html = fill(html, 'heroDeck', heroSoloHtml(list[0], byShop[list[0].shop.slug], lang));
  }
  if (list.length > 0 && list.length < 3) {
    // A small catalogue: 'The first pieces' instead of one tile + one card.
    html = addHtmlClass(html, 'few-pieces');
    html = html.replace('<div class="pgrid" id="trendingGrid"></div>', `<div class="firsts n${list.length}" id="trendingGrid"></div>`);
    html = text(html, 'weeklyEyebrow', T('Just arrived'));
    html = text(html, 'weeklyHeading', list.length === 1 ? T('The first piece') : T('The first pieces'));
    html = fill(html, 'trendingGrid', list.map((p) => firstPieceHtml(p, byShop[p.shop.slug], lang)).join(''));
  } else {
    // The newest pieces as real links (the page's script swaps in the curated picks).
    html = fill(html, 'trendingGrid', list.slice(0, 8).map((p) => cardHtml(p, byShop[p.shop.slug], lang)).join(''));
  }
  const website = {
    '@type': 'WebSite', '@id': `${base}/#website`, url: `${base}/`, name: 'Trove', alternateName: 'Trove at Home',
    publisher: orgRef(base), inLanguage: 'en',
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${base}/shop?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
  };
  return setHead(html, {
    base, url: `${base}/`, title: T(HOME_TITLE), description: T(DEFAULT_DESCRIPTION), lang,
    ld: [website],
  });
}

/** The Collection's shelf before its first piece, as the storefront's emptyStateHTML() draws it. */
function houseSoonShelf(all, byShop, lang = 'en') {
  const [T] = tFor(lang);
  const recs = all.slice(0, 4);
  return `<div class="noresult"><div class="big">${esc(T('Our own line lands soon'))}</div><p>${esc(T('The Trove Collection is still in the workshop. In the meantime, these pieces from our makers are worth a look.'))}</p><div class="nr-actions"><a class="btn btn-dark" href="/shop">${esc(T('Shop everything'))}</a></div></div>`
    + (recs.length ? `<div class="nr-rechead"><span class="eyebrow">${esc(T('You might like'))}</span></div>${recs.map((p) => cardHtml(p, byShop[p.shop.slug], lang)).join('')}` : '');
}

/** Every category name that has a page: the taxonomy plus anything live. */
function categoryNames(list) {
  const { ALLOWED } = require('./categories');
  return [...new Set([...(ALLOWED || []), ...list.map((p) => p.category).filter(Boolean)])];
}
function categoryFromSlug(slug, list) {
  if (slug === HOUSE_SLUG) return 'House';
  return categoryNames(list).find((c) => slugify(c) === slug) || null;
}

/**
 * /shop and /shop/<category>. Returns { html } or { notFound }. A search
 * (?q=) is the same page, canonical to the shelf and kept out of the index.
 */
function renderShop(base, slug, { search, lang = 'en' } = {}) {
  const [T, TN] = tFor(lang);
  const all = productsIn(lang);
  const cat = slug ? categoryFromSlug(slug, all) : 'all';
  if (!cat) return { notFound: true };
  const byShop = Object.fromEntries(shopsIn(lang).map((s) => [s.slug, s]));
  const list = cat === 'all' ? all : cat === 'House' ? all.filter((p) => p.shop.isHouse) : all.filter((p) => p.category === cat);
  const label = cat === 'all' ? T('Shop all') : T(catLabel(cat));
  let html = activate(storefront(), 'shop');
  html = html.replace(/(<h[12] id="browseTitle"[^>]*>)[^<]*(<\/h[12]>)/, `$1${esc(label)}$2`);
  html = html.replace(/(<div class="crumb" id="shopCrumb">)[\s\S]*?(<\/div>)/, `$1<a href="/">Trove</a> &nbsp;/&nbsp; ${cat === 'all' ? `<span>${esc(T('Shop all'))}</span>` : `<a href="/shop">${esc(T('Shop all'))}</a> &nbsp;/&nbsp; <span>${esc(label)}</span>`}$2`);
  html = fill(html, 'shopGrid', list.length || cat !== 'House' ? list.map((p) => cardHtml(p, byShop[p.shop.slug], lang)).join('')
    : houseSoonShelf(all, byShop, lang));
  if (list.length && list.length <= 3) html = html.replace('<div class="pgrid" id="shopGrid">', `<div class="pgrid few${list.length === 1 ? ' one' : ''}" id="shopGrid">`);
  const shopN = new Set(list.map((p) => p.shop.slug)).size;
  html = text(html, 'resCount', String(list.length));
  html = text(html, 'resNoun', noun(lang, list.length, 'piece', 'pieces'));
  html = text(html, 'shopCount', String(shopN));
  html = text(html, 'shopNoun', noun(lang, shopN, 'shop', 'shops'));
  const u = shopUrl(cat);
  const title = cat === 'all' ? T('Shop all homeware · Trove') : T('{label} · Trove', { label });
  const description = cat === 'all'
    ? TN(list.length, 'Every piece on Trove: {n} handmade and designed piece from independent makers, delivered across Dubai and Abu Dhabi.', 'Every piece on Trove: {n} handmade and designed pieces from independent makers, delivered across Dubai and Abu Dhabi.')
    : cat === 'House'
      ? (list.length ? T('The Trove Collection: homeware designed by Trove, made with quality materials, delivered across Dubai and Abu Dhabi.')
        : T('The Trove Collection, Trove’s own line of homeware, is on its way. Until it lands, shop handmade pieces from independent makers across Dubai and Abu Dhabi.'))
      : list.length
        ? TN(list.length, '{label} on Trove: {n} piece handmade by independent makers, delivered across Dubai and Abu Dhabi.', '{label} on Trove: {n} pieces handmade by independent makers, delivered across Dubai and Abu Dhabi.', { label })
        : T('{label} on Trove: pieces handmade by independent makers, delivered across Dubai and Abu Dhabi.', { label });
  const itemList = {
    '@type': 'ItemList', name: label, numberOfItems: list.length,
    itemListElement: list.slice(0, 50).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: base + pieceUrl(p), name: p.name })),
  };
  const crumbs = [['Trove', '/'], [T('Shop all'), '/shop']];
  if (cat !== 'all') crumbs.push([label, u]);
  return {
    html: setHead(html, {
      base, url: base + u, title: search != null ? T('Search results · Trove') : title, description, lang,
      // An empty shelf or a search result is not a page worth indexing.
      // (the Trove Collection's shelf is a real page even before its first piece)
      robots: search != null || (!list.length && cat !== 'House') ? 'noindex, follow' : '',
      ld: [itemList, crumbLd(base, crumbs)],
    }),
  };
}

function productLd(base, p, url, lang = 'en') {
  const images = (p.images || []).map(safeImg).filter(Boolean).map((u) => abs(base, u));
  if (!images.length && safeImg(p.stockImage)) images.push(p.stockImage);
  const f = require('./pages/facts').facts();
  const est = p.estimate || require('./lead-times').estimate(p.leadDays);
  const ld = {
    '@type': 'Product',
    '@id': `${url}#product`,
    name: p.name,
    url,
    sku: String(p.id),
    description: p.description || undefined,
    category: (p.category && i18n.t(lang, catLabel(p.category))) || undefined,
    image: images.length ? images : undefined,
    keywords: (p.tags || []).join(', ') || undefined,
    // The maker made it; Trove sells it (merchant of record — the Terms of Sale).
    // A Trove Collection piece is Trove's own: Trove is the brand and the maker.
    ...(p.shop.isHouse
      ? { brand: { '@type': 'Brand', name: 'Trove' }, manufacturer: orgRef(base) }
      : { brand: { '@type': 'Brand', name: p.shop.name }, manufacturer: { '@type': 'Organization', name: p.shop.name, url: base + makerUrl(p.shop.slug) } }),
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'AED',
      price: Number(p.price).toFixed(2),
      availability: Number(p.stock) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', '@id': `${base}/#organization`, name: 'Trove' },
      areaServed: [{ '@type': 'City', name: 'Dubai' }, { '@type': 'City', name: 'Abu Dhabi' }],
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'AE' },
        shippingRate: { '@type': 'MonetaryAmount', currency: 'AED', value: Number(p.price) > fees.FREE_DELIVERY_THRESHOLD_CENTS / 100 ? 0 : fees.DELIVERY_FEE_CENTS / 100 },
        // Handling = this piece's make/pack time (the maker sets it);
        // transit = the courier's window. Together: the estimate the page shows.
        deliveryTime: {
          '@type': 'ShippingDeliveryTime',
          handlingTime: { '@type': 'QuantitativeValue', minValue: est.leadDays, maxValue: est.leadDays, unitCode: 'DAY' },
          transitTime: { '@type': 'QuantitativeValue', minValue: est.transitMinDays, maxValue: est.transitMaxDays, unitCode: 'DAY' },
        },
      },
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy', applicableCountry: 'AE',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: f.returnDays, url: `${base}/returns`,
      },
    },
  };
  if (p.rating && p.rating.count) ld.aggregateRating = { '@type': 'AggregateRating', ratingValue: p.rating.avg, reviewCount: p.rating.count, bestRating: 5, worstRating: 1 };
  return JSON.parse(JSON.stringify(ld)); // drops the undefined keys
}

/** 'September 2026' from a shop's joined month ('YYYY-MM'), or ''. */
function sinceLabel(joined, lang = 'en') {
  if (!/^\d{4}-\d{2}$/.test(joined || '')) return '';
  return new Date(`${joined}-01T00:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-AE-u-nu-latn-ca-gregory' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
/** Arabic counted noun for days: 1 يوم, 2 يومان, 3–10 أيام, 11+ يوماً. */
const daysAr = (n) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوماً`);
/** '3–6 days' in the page's language. */
function rangeLabel(est, lang) {
  if (lang !== 'ar') return est.label;
  const max = Number(est.maxDays);
  return `${est.minDays}–${max} ${max >= 3 && max <= 10 ? 'أيام' : 'يوماً'}`;
}
/* Per-piece delivery lines — the storefront's shipLine()/leadLine() say
 * exactly the same (test/lead-times.test.js pins both). */
function leadLine(lead, lang = 'en') {
  const n = Number(lead) || fees.LEAD_DAYS_DEFAULT;
  if (lang === 'ar') return i18n.t(lang, '{days} after your order', { days: daysAr(n) });
  return `${n} day${n === 1 ? '' : 's'} after your order`;
}
function shipLine(p, lang = 'en') {
  const est = p.estimate || require('./lead-times').estimate(p.leadDays);
  if (lang === 'ar') {
    const [T] = tFor(lang);
    const label = rangeLabel(est, lang);
    return est.leadDays > fees.LEAD_DAYS_DEFAULT
      ? T('Arrives in {label} · made for you, ready to send in {lead}', { label, lead: daysAr(est.leadDays) })
      : T('Arrives in {label} across Dubai & Abu Dhabi', { label });
  }
  return est.leadDays > fees.LEAD_DAYS_DEFAULT
    ? `Arrives in ${est.label} · made for you, ready to send in ${est.leadDays} days`
    : `Arrives in ${est.label} across Dubai & Abu Dhabi`;
}
/** The PDP's Details + About the maker, as the storefront's pdpAccHTML() draws them (real fields only). */
function pdpAccHtml(p, v, lang = 'en') {
  const [T] = tFor(lang);
  const aed = (n) => Number(n).toLocaleString('en-US');
  const ol = p.optionLabels || {};
  const el = p.extraLabels || {};
  const rows = [[T('Category'), T(catLabel(p.category))]];
  (p.options || []).forEach((g) => rows.push([ol[g.name] || g.name, g.values.map((x) => ol[`${g.name}:${x}`] || x).join(lang === 'ar' ? '، ' : ', ')]));
  if ((p.extras || []).length) rows.push([T('Extras'), p.extras.map((e) => (el[e.name] || e.name) + (e.price ? ` (${i18n.iso(lang, `+AED ${aed(e.price)}`)})` : '')).join(lang === 'ar' ? '، ' : ', ')]);
  const per = p.personalization;
  if (per) rows.push([T('Personalisation'), per.required ? T('Required, up to {n} characters', { n: per.maxLen }) : T('Optional, up to {n} characters', { n: per.maxLen })]);
  rows.push([T('Ready to send in'), leadLine(p.leadDays, lang)]);
  const house = !!p.shop.isHouse;
  const since = sinceLabel(v.joined, lang);
  const meta = [house ? '' : v.location, since ? T('On Trove since {date}', { date: since }) : ''].filter(Boolean).join(' · ');
  return `<details class="acc" open><summary>${esc(T('Details'))}<span class="faq-tg" aria-hidden="true">+</span></summary><dl class="acc-dl">${rows.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl></details>`
    + `<details class="acc"><summary>${esc(house ? T('About the Trove Collection') : T('About the maker'))}<span class="faq-tg" aria-hidden="true">+</span></summary><div class="acc-body"><b class="acc-mk">${esc(p.shop.name)}</b>${meta ? `<div class="acc-meta">${esc(meta)}</div>` : ''}${v.bio ? `<p>${esc(v.bio)}</p>` : ''}<a class="link-more" href="${esc(shopHref(p.shop))}">${esc(T('Visit {maker} →', { maker: p.shop.name }))}</a></div></details>`;
}

/** /pieces/<ref>. Returns { html } | { redirect } | { notFound }. */
function renderPiece(base, ref, lang = 'en') {
  const [T] = tFor(lang);
  const m = String(ref || '').match(/^(\d{1,12})(?:-([a-z0-9-]*))?$/i);
  if (!m) return { notFound: true };
  const en = products().liveProduct(Number(m[1]));
  if (!en) return { notFound: true };
  // the address is the English name's slug in both languages
  const canonical = pieceUrl(en);
  if (`/pieces/${ref}` !== canonical) return { redirect: canonical };
  const p = tr.product(en, lang);
  const url = base + canonical;
  const vendor = shopsIn(lang).find((s) => s.slug === p.shop.slug) || {};
  const cover = coverOf(en);
  const catName = T(catLabel(p.category));
  let html = activate(storefront(), 'pdp');
  html = fill(html, 'pdpCrumb', `<a href="${esc(shopUrl(p.category))}">${esc(catName)}</a> &nbsp;/&nbsp; <span>${esc(p.name)}</span>`);
  html = attr(html, 'pdpGrad', 'style', `background:${safeColor(p.shop.color)}`);
  if (cover) html = attr(attr(html, 'pdpImg', 'src', cover), 'pdpImg', 'alt', p.name);
  // one picture: no thumbnail rail; a stock stand-in says so
  if ((p.images || []).length < 2) html = html.replace('<div class="gallery" id="pdpGallery">', '<div class="gallery one" id="pdpGallery">');
  if (isStock(en)) html = html.replace('<span class="illus" id="pdpIllus" hidden>', '<span class="illus" id="pdpIllus">');
  html = attr(html, 'pdpVendorLink', 'href', shopHref(p.shop));
  html = fill(html, 'pdpVendorLink', esc(p.shop.name));
  html = fill(html, 'pdpName', esc(p.name));
  html = fill(html, 'pdpPrice', `${p.compareAt ? `<s style="color:var(--muted);font-weight:400;font-size:18px;margin-inline-end:8px">${money(p.compareAt, lang)}</s>` : ''}${money(p.price, lang)}`);
  html = fill(html, 'pdpDesc', esc(p.description || ''));
  html = fill(html, 'pdpAcc', pdpAccHtml(p, vendor, lang));
  html = text(html, 'pdpShipLine', shipLine(p, lang));
  const title = T('{name} by {maker} · Trove', { name: p.name, maker: p.shop.name });
  const description = compose(T('{price} from {maker}{where}. ', { price: money(p.price, lang), maker: p.shop.name, where: vendor.location ? `${lang === 'ar' ? '، ' : ', '}${vendor.location}` : '' }),
    p.description || '', T(' Delivered across Dubai and Abu Dhabi.'));
  const crumbs = [['Trove', '/'], [T('Shop all'), '/shop'], [catName, shopUrl(p.category)], [p.name, canonical]];
  return {
    html: setHead(html, {
      base, url, title, description, type: 'product', lang,
      image: cover ? abs(base, cover) : '', imageAlt: p.name,
      ld: [productLd(base, p, url, lang), crumbLd(base, crumbs)],
    }).replace('</head>', `<meta property="product:price:amount" content="${Number(p.price).toFixed(2)}">\n<meta property="product:price:currency" content="AED">\n</head>`),
  };
}

/** /makers/<slug>. Returns { html } | { redirect } | { notFound }. */
function renderMaker(base, slug, lang = 'en') {
  const [T, TN] = tFor(lang);
  const all = shopsIn(lang);
  const s = all.find((x) => x.slug === slug) || all.find((x) => x.slug.toLowerCase() === String(slug).toLowerCase());
  // The Trove Collection is not a maker: its page is its shelf.
  if ((s && s.isHouse) || String(slug).toLowerCase() === HOUSE_SLUG) return { redirect: shopUrl('House') };
  if (!s) return { notFound: true };
  // (Slugs are made lowercase; a legacy capitalised one is served where it is,
  // never redirected, so it cannot loop with the lowercase fold in app.js.)
  if (s.slug !== slug && s.slug === s.slug.toLowerCase()) return { redirect: makerUrl(s.slug) };
  const u = makerUrl(s.slug);
  const url = base + u;
  const list = productsIn(lang).filter((p) => p.shop.slug === s.slug);
  let html = activate(storefront(), 'vendor');
  html = fill(html, 'vName', esc(s.name));
  const since = sinceLabel(s.joined, lang);
  const rating = s.rating ? TN(s.rating.count, '{avg}★ from {n} review', '{avg}★ from {n} reviews', { avg: s.rating.avg }) : '';
  html = fill(html, 'vMeta', esc([s.isHouse ? '' : s.location, since ? T('On Trove since {date}', { date: since }) : '', TN(list.length, '{n} piece', '{n} pieces'), rating].filter(Boolean).join(' · ')));
  html = fill(html, 'vBio', esc(s.bio || ''));
  html = text(html, 'vPiecesHead', T('Pieces by {maker}', { maker: s.name }));
  // the maker's own photo, else the calm colour panel (a stock stand-in reads as unrelated)
  const own = safeImg(s.image) && !/^https:\/\/images\.unsplash\.com\//.test(s.image) ? s.image : '';
  const c = safeColor(s.color);
  html = own ? attr(html, 'vheroGrad', 'style', `background:center/cover no-repeat url("${own}")`)
    : attr(attr(html, 'vheroGrad', 'class', 'grad vpanel'), 'vheroGrad', 'style', `--t0:${c};--t1:${shade(c, 24)}`);
  html = attr(html, 'vLav', 'style', own ? `background:center/cover no-repeat url("${own}")` : `background:${c}`);
  html = fill(html, 'vLav', own ? '' : esc((s.name || '?')[0]));
  if (list.length && list.length <= 3) html = html.replace('<div class="pgrid" id="vendorProducts">', `<div class="pgrid few${list.length === 1 ? ' one' : ''}" id="vendorProducts">`);
  html = fill(html, 'vendorProducts', list.length ? list.map((p) => cardHtml(p, s, lang)).join('')
    : `<p style="color:var(--muted);font-weight:400">${esc(T('This shop is restocking — check back soon.'))}</p>`);
  const where = s.location ? `${lang === 'ar' ? '، ' : ', '}${s.location}` : '';
  const title = T('{maker}{where} · Maker on Trove', { maker: s.name, where });
  const description = compose(TN(list.length, '{n} piece by {maker}{where}. ', '{n} pieces by {maker}{where}. ', { maker: s.name, where }),
    s.bio || '', T(' Delivered across Dubai and Abu Dhabi.'));
  const image = own ? abs(base, own) : (list[0] && coverOf(list[0]) ? abs(base, coverOf(list[0])) : '');
  const maker = {
    '@type': 'Organization',
    '@id': `${url}#maker`,
    name: s.name,
    url,
    description: s.bio || undefined,
    image: image || undefined,
    address: s.location ? { '@type': 'PostalAddress', addressLocality: s.location.split(/[,،]/)[0].trim(), addressCountry: 'AE' } : undefined,
    memberOf: orgRef(base),
  };
  const itemList = {
    '@type': 'ItemList', name: T('Pieces by {maker}', { maker: s.name }), numberOfItems: list.length,
    itemListElement: list.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: base + pieceUrl(p), name: p.name })),
  };
  const page = { '@type': 'ProfilePage', '@id': `${url}#page`, url, name: title, mainEntity: { '@id': `${url}#maker` }, isPartOf: { '@id': `${base}/#website` } };
  return {
    html: setHead(html, {
      base, url, title, description, image, imageAlt: s.name, type: 'profile', lang,
      ld: [JSON.parse(JSON.stringify(maker)), itemList, page, crumbLd(base, [['Trove', '/'], [T('Makers'), '/#vendors'], [s.name, u]])],
    }),
  };
}

function renderSell(base, lang = 'en') {
  const [T] = tFor(lang);
  const f = require('./pages/facts').facts();
  const html = activate(storefront(), 'sell');
  return setHead(html, {
    base, url: `${base}/sell-on-trove`, title: T('Sell your handmade pieces on Trove'), lang,
    description: T('Open a shop on Trove: nothing up front, you set the price and keep {share}%. Trove handles photography, delivery and customer care in Dubai and Abu Dhabi.', { share: f.makerShare }),
    ld: [{ '@type': 'WebPage', '@id': `${base}/sell-on-trove#page`, url: `${base}/sell-on-trove`, name: T('Sell on Trove'), isPartOf: { '@id': `${base}/#website` }, about: orgRef(base) },
      crumbLd(base, [['Trove', '/'], [T('Sell on Trove'), '/sell-on-trove']])],
  });
}

/**
 * The old query addresses → the clean ones (301). Returns a path + query or
 * null. Other parameters (utm_*, cart…) ride along.
 */
function legacyTarget(query) {
  const q = query || {};
  const one = (k) => (Array.isArray(q[k]) ? q[k][0] : q[k]);
  let target = null;
  const drop = new Set();
  const pid = one('p');
  if (pid != null && /^\d{1,12}$/.test(String(pid))) {
    const p = products().liveProduct(Number(pid));
    target = p ? pieceUrl(p) : `/pieces/${Number(pid)}`;
    drop.add('p');
  } else if (typeof one('shop') === 'string' && one('shop')) {
    target = makerUrl(one('shop'));
    drop.add('shop');
  } else if (one('view') === 'shop') {
    const c = one('cat');
    target = shopUrl(typeof c === 'string' && c ? c : 'all');
    drop.add('view'); drop.add('cat');
  } else if (one('view') === 'sell') {
    target = '/sell-on-trove';
    drop.add('view');
  }
  if (!target) return null;
  const rest = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (drop.has(k)) continue;
    for (const x of [].concat(v)) rest.append(k, String(x));
  }
  const s = rest.toString();
  return target + (s ? `?${s}` : '');
}

/* ---------------- Services Marketplace ---------------- */
// Ports of trove-services.html's own card markup, so the page's script
// re-renders over identical content (no layout shift) and a crawler reads it.
const SETTING_LABEL = { home: 'At your place', studio: "At the provider's studio", remote: 'Remote' };
function priceLabel(s, lang = 'en') {
  if (s.priceType === 'from') return i18n.t(lang, 'From {price}', { price: moneyCents(s.priceCents, lang) });
  if (s.priceType === 'hourly') return i18n.t(lang, '{price} / hour', { price: moneyCents(s.priceCents, lang) });
  return moneyCents(s.priceCents, lang);
}
function shade(hex, p) {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v) => Math.max(0, Math.min(255, v));
  return '#' + ((cl((n >> 16) + p) << 16) | (cl(((n >> 8) & 255) + p) << 8) | cl((n & 255) + p)).toString(16).padStart(6, '0');
}
function hashOf(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; }
function motifSvg(seed, c, slice) {
  const c2 = shade(c, 16); const c3 = shade(c, -14);
  const cx = 30 + (seed % 40); const cy = 35 + ((seed >> 3) % 30); const r = 34 + ((seed >> 5) % 18);
  const cx2 = 100 + ((seed >> 7) % 50); const cy2 = 60 + ((seed >> 9) % 40); const r2 = 24 + ((seed >> 11) % 16);
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 100'${slice ? " preserveAspectRatio='xMidYMid slice'" : ''}><rect width='160' height='100' fill='${c}'/><ellipse cx='${cx}' cy='${cy}' rx='${r}' ry='${Math.round(r * 0.72)}' fill='${c2}' opacity='0.85'/><ellipse cx='${cx2}' cy='${cy2}' rx='${r2}' ry='${Math.round(r2 * 1.2)}' fill='${c3}' opacity='0.55'/><ellipse cx='${(cx + cx2) >> 1}' cy='${100 - cy}' rx='${Math.round(r2 * 0.8)}' ry='${Math.round(r2 * 0.5)}' fill='${shade(c, 28)}' opacity='0.7'/></svg>`;
}
const motifUrl = (seed, c) => `data:image/svg+xml;utf8,${encodeURIComponent(motifSvg(seed, c, true))}`;
/** A service category in the page's language (src/service-taxonomy.js carries the Arabic). */
const svcCat = (slug, lang) => tax.bySlug(slug, lang);
function svTile(s, lang = 'en') {
  const cat = svcCat(s.category, lang);
  return `<div class="svtile" aria-hidden="true"><span class="svt-cat">${esc(cat ? cat.name : i18n.t(lang, 'Service'))}</span></div>`;
}
const catNames = (slugs, lang = 'en') => (slugs || []).map((sl) => { const c = svcCat(sl, lang); return c ? c.name : null; }).filter(Boolean);
function svCardHtml(s, lang = 'en') {
  const [T] = tFor(lang);
  return `<div class="svcard" onclick="openService(${Number(s.id)})">
    ${svTile(s, lang)}
    <div class="svbody">
      <div class="t">${esc(s.title)}</div>
      <div class="who"><a class="wholink" href="${esc(providerUrl(s.provider.slug))}">${esc(s.provider.name)}</a> · ${esc(s.provider.location || T('Dubai'))}</div>
      <div class="meta"><span class="price">${priceLabel(s, lang)}</span><span style="flex:1"></span><span class="tagchip">${esc(SETTING_LABEL[s.setting] ? T(SETTING_LABEL[s.setting]) : '')}</span><button type="button" class="sv-req" aria-label="${esc(T('Request {title}', { title: s.title }))}" onclick="event.stopPropagation();openService(${Number(s.id)})">${esc(T('Request'))}</button></div>
    </div>
  </div>`;
}
function provCardHtml(p, lang = 'en') {
  const [T, TN] = tFor(lang);
  const n = Number(p.serviceCount) || 0;
  return `<article class="pcard" role="link" tabindex="0">
    <div class="cover vpanel" style="--t0:${safeColor(p.color)};--t1:${shade(safeColor(p.color), 24)}"></div>
    <div class="av" style="background:${safeColor(p.color)}">${esc((p.name || '?')[0])}</div>
    <h3><a class="pcard-link" href="${esc(providerUrl(p.slug))}">${esc(p.name)}</a></h3>
    <div class="loc">${esc(p.location || T('Dubai'))}</div>
    <p>${esc(p.bio)}</p>
    <div class="pmeta"><span>${lang === 'ar' ? esc(TN(n, '{n} service', '{n} services')) : `<b>${n}</b> ${p.serviceCount === 1 ? 'service' : 'services'}`}</span>${p.fromCents ? `<span>${lang === 'ar' ? esc(T('from {price}', { price: moneyCents(p.fromCents, lang) })) : `from <b>${moneyCents(p.fromCents)}</b>`}</span>` : ''}</div>
    <div class="pcats">${catNames(p.categories, lang).map((c) => `<span class="tagchip">${esc(c)}</span>`).join('')}</div>
    ${p.shop && p.shop.productCount ? `<span class="also">${esc(T('Also sells pieces · {shop}', { shop: p.shop.name }))}</span>` : ''}
  </article>`;
}
function servicesPage() { return readDoc('trove-services.html', servicesCache); }

/** The directory's first paint, as the page's script draws it for 'At home'. */
function directoryMarkup(html, lang = 'en') {
  const [T, TN] = tFor(lang);
  const services = tr.services(servicesData().liveServices(), lang);
  const providers = tr.providers(servicesData().approvedProviders(), lang);
  const audience = 'home';
  const loc = tax.localized ? tax.localized(lang) : { audiences: tax.AUDIENCES, categories: tax.SERVICE_CATEGORIES };
  const AUD_ICON = {
    home: { tint: '#CAD5CC', svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>' },
    makers: { tint: '#F8D7E4', svg: '<path d="M14 4l6 6-8.5 8.5a3 3 0 0 1-4.2 0l-1.8-1.8a3 3 0 0 1 0-4.2z"/><path d="M4 20c1.4-.3 2.4-1 3-2"/>' },
  };
  const aud = loc.audiences.map((a) => {
    const ic = AUD_ICON[a.key] || { tint: '#DBC7BD', svg: '<circle cx="12" cy="12" r="7"/>' };
    return `<button class="audbtn ${audience === a.key ? 'on' : ''}" aria-pressed="${audience === a.key}">
      <span class="ofic" style="background:${ic.tint}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ic.svg}</svg></span>
      <span><b>${esc(a.name)}</b><small>${esc(a.sub)}</small></span>
      <span class="arr">${lang === 'ar' ? '←' : '→'}</span>
    </button>`;
  }).join('');
  const cats = loc.categories.filter((c) => c.audience === audience);
  const live = cats.filter((c) => services.some((s) => s.category === c.slug));
  const empty = cats.filter((c) => !live.includes(c));
  const dir = live.map((c) => {
    const list = services.filter((s) => s.category === c.slug); const n = list.length;
    const min = n ? Math.min(...list.map((s) => s.priceCents || 0)) : 0;
    return `<div class="dcard ${n ? 'live' : ''} ">
      <div class="top"><h3>${esc(c.name)}</h3><span class="cnt ${n ? '' : 'none'}">${n ? esc(TN(n, '{n} service', '{n} services')) : esc(T('Be the first'))}</span></div>
      <div class="blurb">${esc(c.blurb)}</div>
      <p class="ex">${c.examples.map(esc).join(' · ')}</p>
      <div class="foot">${n
    ? `<span class="from">${min ? esc(T('From {price}', { price: moneyCents(min, lang) })) : ''}</span><span class="go">${esc(T('See services →'))}</span>`
    : `<span></span><a href="/apply?for=services">${esc(T('Offer this →'))}</a>`}</div>
    </div>`;
  }).join('') + (empty.length ? `<div class="soon"><div><b>${esc(T('Coming soon'))}</b><p>${empty.map((c) => esc(c.name)).join(' · ')}</p></div><a href="/apply?for=services">${esc(T('Offer a service →'))}</a></div>` : '');
  const all = services.filter((s) => cats.some((c) => c.slug === s.category));
  let results;
  if (!all.length) {
    const audName = ((loc.audiences.find((a) => a.key === audience) || {}).name || '');
    results = lang === 'ar'
      ? `<div class="empty">${esc(T('No providers offer services {audience} yet — the Services Marketplace is just opening. Do one of these beautifully yourself?', { audience: audName }))} <a href="/apply?for=services">${esc(T('Become a provider'))}</a> ${esc(T('and be the first name here.'))}</div>`
      : `<div class="empty">No providers offer services ${esc(audName.toLowerCase())} yet — the Services Marketplace is just opening. Do one of these beautifully yourself? <a href="/apply?for=services">Become a provider</a> and be the first name here.</div>`;
  } else {
    const CAP = 8; const capped = all.length > CAP;
    results = `<section class="results" id="resultsSec">
    <div class="rhead"><h2>${esc(T('All services'))}</h2><span>${esc(TN(all.length, '{n} service', '{n} services'))}</span></div>
    <div class="svgrid">${(capped ? all.slice(0, CAP) : all).map((s) => svCardHtml(s, lang)).join('')}</div>
    ${capped ? `<button class="showall">${esc(T('Show all {n} services', { n: all.length }))}</button>` : ''}
  </section>`;
  }
  let out = fill(html, 'audSwitch', aud);
  if (live.length === 1) out = out.replace('<div class="dir" id="dir">', '<div class="dir one" id="dir">');
  out = fill(out, 'dir', dir);
  out = fill(out, 'results', results);
  if (providers.length) {
    const audSet = new Set(cats.map((c) => c.slug));
    const rel = (p) => ((p.categories || []).some((sl) => audSet.has(sl)) ? 1 : 0);
    out = out.replace('<section class="band" id="providers" hidden>', '<section class="band" id="providers">');
    out = fill(out, 'provGrid', [...providers].sort((a, b) => rel(b) - rel(a)).map((p) => provCardHtml(p, lang)).join(''));
  }
  return { html: out, services, providers };
}

function servicesLd(base, lang = 'en') {
  return {
    '@type': 'CollectionPage', '@id': `${base}/services#page`, url: `${base}/services`, name: i18n.t(lang, 'Trove Services Marketplace'),
    isPartOf: { '@id': `${base}/#website` }, about: orgRef(base), inLanguage: 'en',
  };
}

function renderServicesDirectory(base, lang = 'en') {
  const [T] = tFor(lang);
  const { html, providers } = directoryMarkup(servicesPage(), lang);
  const itemList = {
    '@type': 'ItemList', name: T('Service providers on Trove'), numberOfItems: providers.length,
    itemListElement: providers.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: base + providerUrl(p.slug), name: p.name })),
  };
  return setHead(html, {
    base, url: `${base}/services`, title: T('Services Marketplace · Trove'), lang,
    description: T('Creative services at your place in Dubai and Abu Dhabi — made-to-order pieces, repair, styling, workshops and photography at home, plus brand and shop support for makers.'),
    ld: [servicesLd(base, lang), itemList, crumbLd(base, [['Trove', '/'], [T('Services Marketplace'), '/services']])],
  });
}

/** /services/<slug>: one approved provider. Returns { html } | { notFound }. */
function renderProvider(base, slug, lang = 'en') {
  const [T, TN] = tFor(lang);
  const page = servicesData().providerPage(slug);
  if (!page) return { notFound: true };
  const p = tr.provider(page.provider, lang);
  const services = tr.services(page.services, lang);
  const u = providerUrl(p.slug);
  const url = base + u;
  let html = servicesPage();
  // The provider view is the page; the directory's hero heading steps down.
  html = html.replace('<body>', '<body class="pv">').replace('<section id="pview" hidden>', '<section id="pview">')
    .replace(/<h1 class="hero-t"([^>]*)>([\s\S]*?)<\/h1>/, '<h2 class="hero-t"$1>$2</h2>')
    .replace(/<h2 id="pvName"([^>]*)><\/h2>/, '<h1 id="pvName"$1></h1>');
  html = attr(attr(html, 'pvHero', 'class', 'pv-hero vpanel'), 'pvHero', 'style', `--t0:${safeColor(p.color)};--t1:${shade(safeColor(p.color), 24)}`);
  html = attr(html, 'pvAv', 'style', `background:${safeColor(p.color)}`);
  html = fill(html, 'pvAv', esc((p.name || '?')[0]));
  html = fill(html, 'pvName', esc(p.name));
  html = fill(html, 'pvLoc', esc(p.location || T('Dubai')));
  html = fill(html, 'pvBio', esc(p.bio || ''));
  // the emirate comes from the English location (the Arabic one may use '،')
  const emirateEn = (page.provider.location || 'Dubai').split(',').pop().trim();
  const emirate = (p.location || T('Dubai')).split(/[,،]/).pop().trim();
  const n = Number(p.serviceCount) || 0;
  html = fill(html, 'pvStats', `<div><b>${n}</b><span>${esc(lang === 'ar' ? noun(lang, n, 'SERVICE', 'SERVICES') : (p.serviceCount === 1 ? 'SERVICE' : 'SERVICES'))}</span></div><div><b>${esc(emirate)}</b><span>${esc(T('BASED IN'))}</span></div>${p.since ? `<div><b>${esc(p.since)}</b><span>${esc(T('ON TROVE SINCE'))}</span></div>` : ''}`);
  html = fill(html, 'pvCats', catNames(p.categories, lang).map((c) => `<span class="tagchip">${esc(c)}</span>`).join(''));
  html = fill(html, 'pvCount', esc(TN(services.length, '{n} service', '{n} services')));
  html = fill(html, 'pvGrid', services.length ? services.map((s) => svCardHtml(s, lang)).join('')
    : `<div class="empty" style="grid-column:1/-1">${esc(T("{name} hasn't listed a service yet — check back soon.", { name: p.name }))}</div>`);
  // Their shop's pieces, when the same account sells on the storefront.
  if (p.shop && p.shop.productCount) {
    const pieces = productsIn(lang).filter((x) => x.shop.slug === p.shop.slug).slice(0, 8);
    if (pieces.length) {
      html = html.replace('<div class="pv-shop" id="pvShop" hidden>', '<div class="pv-shop" id="pvShop">');
      html = fill(html, 'pvShopCount', `${esc(TN(p.shop.productCount, '{n} piece', '{n} pieces'))} · ${esc(p.shop.name)}`);
      html = attr(html, 'pvShopLink', 'href', makerUrl(p.shop.slug));
      html = fill(html, 'pvPieces', pieces.map((pr) => {
        const img = coverOf(pr) || motifUrl(hashOf(pr.name), safeColor(p.color));
        return `<a class="pc" href="${esc(pieceUrl(pr))}"><div class="pcimg" style="background-image:url(&quot;${esc(img)}&quot;)"></div><div class="pcb"><div class="pct">${esc(pr.name)}</div><div class="pcp">${money(pr.price, lang)}</div></div></a>`;
      }).join(''));
    }
  }
  const where = p.location ? `${lang === 'ar' ? '، ' : ', '}${p.location}` : '';
  const title = T('{name}{where} · Trove Services Marketplace', { name: p.name, where });
  const minCents = services.length ? Math.min(...services.map((s) => s.priceCents || 0)) : 0;
  const head = services.length
    ? TN(services.length, '{n} service, from {price}, booked in Dubai and Abu Dhabi. ', '{n} services, from {price}, booked in Dubai and Abu Dhabi. ', { price: moneyCents(minCents, lang) })
    : T('Book in Dubai and Abu Dhabi. ');
  const description = compose(head, p.bio || services.map((s) => s.title).join(lang === 'ar' ? '، ' : ', '), '');
  const business = {
    '@type': ['LocalBusiness', 'ProfessionalService'],
    '@id': `${url}#provider`,
    name: p.name,
    url,
    description: p.bio || undefined,
    image: `${base}${OG_IMAGE}`,
    address: { '@type': 'PostalAddress', addressLocality: emirateEn, addressCountry: 'AE' },
    areaServed: [
      { '@type': 'City', name: 'Dubai', containedInPlace: { '@type': 'Country', name: 'United Arab Emirates' } },
      { '@type': 'City', name: 'Abu Dhabi', containedInPlace: { '@type': 'Country', name: 'United Arab Emirates' } },
    ],
    currenciesAccepted: 'AED',
    priceRange: services.length ? `From ${moneyCents(minCents)}` : undefined,
    knowsAbout: catNames(p.categories, lang),
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: T('Services by {name}', { name: p.name }),
      itemListElement: services.map((s) => ({
        '@type': 'Offer',
        url,
        priceCurrency: 'AED',
        price: ((s.priceCents || 0) / 100).toFixed(2),
        priceSpecification: {
          '@type': 'UnitPriceSpecification', priceCurrency: 'AED', price: ((s.priceCents || 0) / 100).toFixed(2),
          ...(s.priceType === 'from' ? { minPrice: ((s.priceCents || 0) / 100).toFixed(2) } : {}),
          ...(s.priceType === 'hourly' ? { unitCode: 'HUR', unitText: 'hour' } : {}),
        },
        itemOffered: {
          '@type': 'Service', name: s.title, description: s.description || undefined,
          serviceType: (svcCat(s.category, lang) || {}).name,
          provider: { '@id': `${url}#provider` },
          areaServed: s.setting === 'remote' ? 'AE' : ['Dubai', 'Abu Dhabi'],
        },
      })),
    },
  };
  return {
    html: setHead(html, {
      base, url, title, description, type: 'profile', lang,
      ld: [JSON.parse(JSON.stringify(business)), crumbLd(base, [['Trove', '/'], [T('Services Marketplace'), '/services'], [p.name, u]])],
    }),
  };
}

/* ---------------- sitemap ---------------- */
const later = (...ds) => ds.filter(Boolean).map(String).sort().pop() || null;

/** Every indexable address with its real last-modified date. */
function sitemapEntries() {
  const db = require('./db');
  const out = [];
  const add = (loc, lastmod, priority = '0.5', changefreq = 'weekly') => out.push({ loc, lastmod: lastmod ? String(lastmod).slice(0, 10) : null, priority, changefreq });
  const pieces = db.prepare(`SELECT p.id, p.name, p.category, s.slug AS shop_slug, s.is_house,
      COALESCE(p.updated_at, p.created_at) AS mod
    FROM products p JOIN shops s ON s.id = p.shop_id
    WHERE p.status = 'live' AND s.status = 'approved' AND ${require('./agreements').sellableSql('s')} ORDER BY p.id`).all();
  const newest = later(...pieces.map((p) => p.mod));
  add('/', newest, '1.0', 'daily');
  if (pieces.length) add('/shop', newest, '0.8', 'daily');
  // Category shelves with something on them (an empty shelf is thin).
  const cats = new Map();
  for (const p of pieces) {
    const keys = [p.category, p.is_house ? 'House' : null].filter(Boolean);
    for (const k of keys) cats.set(k, later(cats.get(k), p.mod));
  }
  // The Trove Collection's shelf is listed as soon as the house shop exists,
  // pieces or not (it says what is coming); its shop never has a maker page.
  const house = db.prepare("SELECT COALESCE(updated_at, created_at) AS mod FROM shops WHERE is_house = 1 AND status = 'approved' ORDER BY id LIMIT 1").get();
  if (house && !cats.has('House')) cats.set('House', house.mod);
  for (const [c, mod] of cats) add(shopUrl(c), mod, '0.6');
  add('/sell-on-trove', null, '0.6', 'monthly');
  for (const s of db.prepare(`SELECT s.slug, COALESCE(s.updated_at, s.created_at) AS mod,
      (SELECT MAX(COALESCE(p.updated_at, p.created_at)) FROM products p WHERE p.shop_id = s.id AND p.status = 'live') AS pmod
    FROM shops s WHERE s.status = 'approved' AND s.is_house = 0 ORDER BY s.id`).all()) {
    add(makerUrl(s.slug), later(s.mod, s.pmod), '0.7');
  }
  for (const p of pieces) add(pieceUrl(p), p.mod, '0.6');
  add('/services', null, '0.8', 'daily');
  for (const pr of db.prepare(`SELECT pr.slug, COALESCE(pr.updated_at, pr.created_at) AS mod,
      (SELECT MAX(COALESCE(sv.updated_at, sv.created_at)) FROM services sv WHERE sv.provider_id = pr.id AND sv.status = 'live') AS smod
    FROM service_providers pr WHERE pr.status = 'approved' ORDER BY pr.id`).all()) {
    add(providerUrl(pr.slug), later(pr.mod, pr.smod), '0.7');
  }
  for (const [p, pr, cf] of [['/about', '0.6', 'monthly'], ['/returns', '0.5', 'monthly'], ['/faq', '0.5', 'monthly'], ['/contact', '0.4', 'yearly'],
    ['/terms', '0.3', 'yearly'], ['/privacy', '0.3', 'yearly'], ['/seller-agreement', '0.2', 'yearly'], ['/provider-agreement', '0.2', 'yearly'], ['/services-terms', '0.2', 'yearly']]) {
    add(p, null, pr, cf);
  }
  return out;
}

module.exports = {
  slugify, catSlug, pieceUrl, makerUrl, shopUrl, providerUrl, HOUSE_SLUG,
  renderHome, renderShop, renderPiece, renderMaker, renderSell, renderServicesDirectory, renderProvider,
  legacyTarget, sitemapEntries, socialTags, withDefaultSocial, OG_IMAGE, DEFAULT_DESCRIPTION, HOME_TITLE,
};
