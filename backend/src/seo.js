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
function pieceUrl(p) { const s = slugify(p.name); return `/pieces/${p.id}${s ? '-' + s : ''}`; }
const makerUrl = (slug) => `/makers/${encodeURIComponent(slug)}`;
const shopUrl = (cat) => (!cat || cat === 'all' ? '/shop' : `/shop/${catSlug(cat)}`);
const providerUrl = (slug) => `/services/${encodeURIComponent(slug)}`;

/* ---------------- data (the public API's own shapes) ---------------- */
const products = () => require('./routes/products.routes').publicData;
const shops = () => require('./routes/shops.routes').publicData;
const servicesData = () => require('./routes/services.routes').publicData;

const liveProducts = () => products().liveProducts();
const approvedShops = () => shops().approvedShops();

/* ---------------- small helpers ---------------- */
function money(amount) {
  const n = Number(amount) || 0;
  return 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
const moneyCents = (c) => money((Number(c) || 0) / 100);
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
const ILLUS = '<span class="illus">Illustrative photo</span>';
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
function socialTags({ base, url, title, description, image, imageAlt, type = 'website', robots }) {
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
    `<meta property="og:image:alt" content="${esc(imageAlt || OG_IMAGE_ALT)}">`,
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
function cardHtml(p, vendor) {
  const cover = coverOf(p);
  const color = safeColor(p.shop && p.shop.color);
  return `<article class="card">
    <div class="ph"><div class="grad" style="background:${color}"></div>${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">` : ''}${p.compareAt ? '<span class="sale">Sale</span>' : ''}${isStock(p) ? ILLUS : ''}
      <button class="add" onclick="event.stopPropagation();addToCart(${Number(p.id)},this)">Add to basket</button></div>
    <div class="vrow ${vendor && vendor.isHouse ? 'is-house' : ''}"><span class="gem"></span>${esc(p.shop.name)}</div>
    <h3><a class="card-link" href="${esc(pieceUrl(p))}">${esc(p.name)}</a></h3>
    <div class="foot"><span class="price">${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ''}${money(p.price)}</span></div>
    <button class="add add-row" onclick="event.stopPropagation();addToCart(${Number(p.id)},this)">Add to basket</button>
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
 * the first paint (so nothing moves): no Trove Collection yet → html.no-house
 * and the Marketplace link becomes the hero's button.
 */
function storefront() {
  let html = readDoc('trove.html', storeCache);
  if (!sitePages.hasHousePieces()) {
    html = html.replace('<html lang="en">', '<html lang="en" class="no-house">')
      .replace('<a class="txt-link" id="heroMarketLink"', '<a class="btn btn-dark" id="heroMarketLink"');
  }
  return html;
}
const addHtmlClass = (html, cls) => html.replace(/<html lang="en"( class="([^"]*)")?>/, (m, a, c) => `<html lang="en" class="${c ? c + ' ' : ''}${cls}">`);

/** The one-piece hero, as the storefront's heroSoloHTML() draws it. */
function heroSoloHtml(p, vendor) {
  const meta = p.shop.isHouse ? 'The Trove Collection' : (vendor && vendor.location ? `Made in ${vendor.location}` : '');
  const cover = coverOf(p);
  return `<a class="hsolo" href="${esc(pieceUrl(p))}"><span class="hs-img"><span class="grad" style="background:${safeColor(p.shop.color)}"></span>${cover ? `<img src="${esc(cover)}" alt="${esc(p.name)}" fetchpriority="high" decoding="async">` : ''}${p.compareAt ? '<span class="sale">Sale</span>' : ''}${isStock(p) ? ILLUS : ''}</span><span class="hs-cap">${meta ? `<span class="hs-meta">${esc(meta)}</span>` : ''}<span class="hs-name">${esc(p.name)}</span><span class="hs-by">by ${esc(p.shop.name)}</span><span class="hc-foot"><span class="price">${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ''}${money(p.price)}</span><span class="hc-go">View piece →</span></span></span></a>`;
}
/** One of 'The first pieces', as the storefront's firstPieceHTML() draws it. */
function firstPieceHtml(p, vendor) {
  const where = p.shop.isHouse ? 'The Trove Collection' : [p.shop.name, vendor && vendor.location].filter(Boolean).join(' · ');
  const u = esc(pieceUrl(p));
  const cover = coverOf(p);
  return `<article class="fcard">
    <a class="fc-img" href="${u}" tabindex="-1" aria-hidden="true"><span class="grad" style="background:${safeColor(p.shop.color)}"></span>${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">` : ''}${p.compareAt ? '<span class="sale">Sale</span>' : ''}${isStock(p) ? ILLUS : ''}</a>
    <div class="fc-body">
      <div class="vrow ${p.shop.isHouse ? 'is-house' : ''}"><span class="gem"></span>${esc(where)}</div>
      <h3><a href="${u}">${esc(p.name)}</a></h3>
      ${p.description ? `<p class="fc-desc">${esc(clip(p.description, 220))}</p>` : ''}
      <span class="price">${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ''}${money(p.price)}</span>
      <div class="fc-acts"><a class="btn btn-dark" href="${u}">See the piece</a>${p.shop.isHouse ? '' : `<a class="txt-link" href="${esc(makerUrl(p.shop.slug))}">More from ${esc(p.shop.name)}</a>`}</div>
    </div>
  </article>`;
}

function renderHome(base) {
  const list = liveProducts();
  const byShop = Object.fromEntries(approvedShops().map((s) => [s.slug, s]));
  let html = activate(storefront(), 'home');
  // One piece: the editorial hero, drawn now so the first paint is final.
  const heroPicks = (content.getPublic().home || {}).hero;
  if (list.length === 1 && !(heroPicks && Array.isArray(heroPicks.productIds) && heroPicks.productIds.length > 1)) {
    html = html.replace('<div class="hstage" id="heroStage" tabindex="0" aria-roledescription="carousel" aria-label="Featured pieces">', '<div class="hstage solo" id="heroStage" aria-label="Featured piece">');
    html = fill(html, 'heroDeck', heroSoloHtml(list[0], byShop[list[0].shop.slug]));
  }
  if (list.length > 0 && list.length < 3) {
    // A small catalogue: 'The first pieces' instead of one tile + one card.
    html = addHtmlClass(html, 'few-pieces');
    html = html.replace('<div class="pgrid" id="trendingGrid"></div>', `<div class="firsts n${list.length}" id="trendingGrid"></div>`);
    html = text(html, 'weeklyEyebrow', 'Just arrived');
    html = text(html, 'weeklyHeading', list.length === 1 ? 'The first piece' : 'The first pieces');
    html = fill(html, 'trendingGrid', list.map((p) => firstPieceHtml(p, byShop[p.shop.slug])).join(''));
  } else {
    // The newest pieces as real links (the page's script swaps in the curated picks).
    html = fill(html, 'trendingGrid', list.slice(0, 8).map((p) => cardHtml(p, byShop[p.shop.slug])).join(''));
  }
  const website = {
    '@type': 'WebSite', '@id': `${base}/#website`, url: `${base}/`, name: 'Trove', alternateName: 'Trove at Home',
    publisher: orgRef(base), inLanguage: 'en',
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${base}/shop?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
  };
  return setHead(html, {
    base, url: `${base}/`, title: HOME_TITLE, description: DEFAULT_DESCRIPTION,
    ld: [website],
  });
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

/** Mirrors the storefront's syncFilterGroups(): is any filter group worth showing? */
function hasFilters(all) {
  const makers = new Set(all.filter((p) => !p.shop.isHouse).map((p) => p.shop.slug));
  const house = all.some((p) => p.shop.isHouse);
  const bands = [[0, 80], [80, 200], [200, 9999]].filter(([a, b]) => all.some((p) => p.price >= a && p.price <= b)).length;
  return new Set(all.map((p) => p.category)).size > 1 || makers.size > 1 || (house && makers.size > 0)
    || all.some((p) => p.compareAt) || bands > 1;
}

/**
 * /shop and /shop/<category>. Returns { html } or { notFound }. A search
 * (?q=) is the same page, canonical to the shelf and kept out of the index.
 */
function renderShop(base, slug, { search } = {}) {
  const all = liveProducts();
  const cat = slug ? categoryFromSlug(slug, all) : 'all';
  if (!cat) return { notFound: true };
  const byShop = Object.fromEntries(approvedShops().map((s) => [s.slug, s]));
  const list = cat === 'all' ? all : cat === 'House' ? all.filter((p) => p.shop.isHouse) : all.filter((p) => p.category === cat);
  const label = cat === 'all' ? 'Shop all' : catLabel(cat);
  let html = activate(storefront(), 'shop');
  html = html.replace(/(<h[12] id="browseTitle"[^>]*>)[^<]*(<\/h[12]>)/, `$1${esc(label)}$2`);
  html = html.replace(/(<div class="crumb" id="shopCrumb">)[\s\S]*?(<\/div>)/, `$1<a href="/">Trove</a> &nbsp;/&nbsp; ${cat === 'all' ? '<span>Shop all</span>' : `<a href="/shop">Shop all</a> &nbsp;/&nbsp; <span>${esc(label)}</span>`}$2`);
  html = fill(html, 'shopGrid', list.map((p) => cardHtml(p, byShop[p.shop.slug])).join(''));
  if (list.length && list.length <= 3) html = html.replace('<div class="pgrid" id="shopGrid">', `<div class="pgrid few${list.length === 1 ? ' one' : ''}" id="shopGrid">`);
  if (cat === 'all' && !search && !hasFilters(all)) html = html.replace('<body>', '<body class="no-filters">');
  const shopN = new Set(list.map((p) => p.shop.slug)).size;
  html = text(html, 'resCount', String(list.length));
  html = text(html, 'resNoun', list.length === 1 ? 'piece' : 'pieces');
  html = text(html, 'shopCount', String(shopN));
  html = text(html, 'shopNoun', shopN === 1 ? 'shop' : 'shops');
  const u = shopUrl(cat);
  const title = cat === 'all' ? 'Shop all homeware · Trove' : `${label} · Trove`;
  const description = cat === 'all'
    ? `Every piece on Trove: ${list.length} handmade and designed ${list.length === 1 ? 'piece' : 'pieces'} from independent makers, delivered across Dubai and Abu Dhabi.`
    : cat === 'House'
      ? 'The Trove Collection: homeware designed by Trove, made with quality materials, delivered across Dubai and Abu Dhabi.'
      : `${label} on Trove: ${list.length ? `${list.length} ${list.length === 1 ? 'piece' : 'pieces'} ` : 'pieces '}handmade by independent makers, delivered across Dubai and Abu Dhabi.`;
  const itemList = {
    '@type': 'ItemList', name: label, numberOfItems: list.length,
    itemListElement: list.slice(0, 50).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: base + pieceUrl(p), name: p.name })),
  };
  const crumbs = [['Trove', '/'], ['Shop all', '/shop']];
  if (cat !== 'all') crumbs.push([label, u]);
  return {
    html: setHead(html, {
      base, url: base + u, title: search != null ? `Search results · Trove` : title, description,
      // An empty shelf or a search result is not a page worth indexing.
      robots: search != null || !list.length ? 'noindex, follow' : '',
      ld: [itemList, crumbLd(base, crumbs)],
    }),
  };
}

function productLd(base, p, url) {
  const images = (p.images || []).map(safeImg).filter(Boolean).map((u) => abs(base, u));
  if (!images.length && safeImg(p.stockImage)) images.push(p.stockImage);
  const f = require('./pages/facts').facts();
  const ld = {
    '@type': 'Product',
    '@id': `${url}#product`,
    name: p.name,
    url,
    sku: `TRV-${p.id}`,
    description: p.description || undefined,
    category: catLabel(p.category) || undefined,
    image: images.length ? images : undefined,
    keywords: (p.tags || []).join(', ') || undefined,
    brand: { '@type': 'Brand', name: p.shop.name },
    // The maker made it; Trove sells it (merchant of record — the Terms of Sale).
    manufacturer: { '@type': 'Organization', name: p.shop.name, url: base + makerUrl(p.shop.slug) },
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
        deliveryTime: {
          '@type': 'ShippingDeliveryTime',
          handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 2, unitCode: 'DAY' },
          transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 6, unitCode: 'DAY' },
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

/** /pieces/<ref>. Returns { html } | { redirect } | { notFound }. */
function renderPiece(base, ref) {
  const m = String(ref || '').match(/^(\d{1,12})(?:-([a-z0-9-]*))?$/i);
  if (!m) return { notFound: true };
  const p = products().liveProduct(Number(m[1]));
  if (!p) return { notFound: true };
  const canonical = pieceUrl(p);
  if (`/pieces/${ref}` !== canonical) return { redirect: canonical };
  const url = base + canonical;
  const vendor = approvedShops().find((s) => s.slug === p.shop.slug) || {};
  const cover = coverOf(p);
  const catName = catLabel(p.category);
  let html = activate(storefront(), 'pdp');
  html = fill(html, 'pdpCrumb', `<a href="${esc(shopUrl(p.category))}">${esc(catName)}</a> &nbsp;/&nbsp; <span>${esc(p.name)}</span>`);
  html = attr(html, 'pdpGrad', 'style', `background:${safeColor(p.shop.color)}`);
  if (cover) html = attr(attr(html, 'pdpImg', 'src', cover), 'pdpImg', 'alt', p.name);
  html = attr(html, 'pdpVendorLink', 'href', makerUrl(p.shop.slug));
  html = fill(html, 'pdpVendorLink', esc(p.shop.name));
  html = fill(html, 'pdpName', esc(p.name));
  html = fill(html, 'pdpPrice', `${p.compareAt ? `<s style="color:var(--muted);font-weight:400;font-size:18px;margin-right:8px">${money(p.compareAt)}</s>` : ''}${money(p.price)}`);
  html = fill(html, 'pdpDesc', esc(p.description || ''));
  html = fill(html, 'pdpSoldName', `<a href="${esc(makerUrl(p.shop.slug))}">${esc(p.shop.name)}</a>`);
  const title = `${p.name} by ${p.shop.name} · Trove`;
  const description = compose(`${money(p.price)} from ${p.shop.name}${vendor.location ? `, ${vendor.location}` : ''}. `,
    p.description || '', ' Delivered across Dubai and Abu Dhabi.');
  const crumbs = [['Trove', '/'], ['Shop all', '/shop'], [catName, shopUrl(p.category)], [p.name, canonical]];
  return {
    html: setHead(html, {
      base, url, title, description, type: 'product',
      image: cover ? abs(base, cover) : '', imageAlt: p.name,
      ld: [productLd(base, p, url), crumbLd(base, crumbs)],
    }).replace('</head>', `<meta property="product:price:amount" content="${Number(p.price).toFixed(2)}">\n<meta property="product:price:currency" content="AED">\n</head>`),
  };
}

/** /makers/<slug>. Returns { html } | { redirect } | { notFound }. */
function renderMaker(base, slug) {
  const s = approvedShops().find((x) => x.slug === slug) || approvedShops().find((x) => x.slug.toLowerCase() === String(slug).toLowerCase());
  if (!s) return { notFound: true };
  // (Slugs are made lowercase; a legacy capitalised one is served where it is,
  // never redirected, so it cannot loop with the lowercase fold in app.js.)
  if (s.slug !== slug && s.slug === s.slug.toLowerCase()) return { redirect: makerUrl(s.slug) };
  const u = makerUrl(s.slug);
  const url = base + u;
  const list = liveProducts().filter((p) => p.shop.slug === s.slug);
  let html = activate(storefront(), 'vendor');
  html = fill(html, 'vName', esc(s.name));
  html = fill(html, 'vLoc', esc(s.location || ''));
  html = fill(html, 'vBio', esc(s.bio || ''));
  html = fill(html, 'vProds', String(list.length));
  html = html.replace(/(<span id="vProdsLbl">)[^<]*(<\/span>)/, `$1${list.length === 1 ? 'Piece' : 'Pieces'}$2`);
  html = fill(html, 'vLav', s.image ? '' : esc((s.name || '?')[0]));
  html = fill(html, 'vendorProducts', list.length ? list.map((p) => cardHtml(p, s)).join('')
    : '<p style="color:var(--muted);font-weight:400">This shop is restocking — check back soon.</p>');
  const title = `${s.name}${s.location ? `, ${s.location}` : ''} · Maker on Trove`;
  const description = compose(`${list.length} ${list.length === 1 ? 'piece' : 'pieces'} by ${s.name}${s.location ? `, ${s.location}` : ''}. `,
    s.bio || '', ' Delivered across Dubai and Abu Dhabi.');
  const image = safeImg(s.image) ? abs(base, s.image) : (list[0] && coverOf(list[0]) ? abs(base, coverOf(list[0])) : '');
  const maker = {
    '@type': 'Organization',
    '@id': `${url}#maker`,
    name: s.name,
    url,
    description: s.bio || undefined,
    image: image || undefined,
    address: s.location ? { '@type': 'PostalAddress', addressLocality: s.location.split(',')[0].trim(), addressCountry: 'AE' } : undefined,
    memberOf: orgRef(base),
  };
  const itemList = {
    '@type': 'ItemList', name: `Pieces by ${s.name}`, numberOfItems: list.length,
    itemListElement: list.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: base + pieceUrl(p), name: p.name })),
  };
  const page = { '@type': 'ProfilePage', '@id': `${url}#page`, url, name: title, mainEntity: { '@id': `${url}#maker` }, isPartOf: { '@id': `${base}/#website` } };
  return {
    html: setHead(html, {
      base, url, title, description, image, imageAlt: s.name, type: 'profile',
      ld: [JSON.parse(JSON.stringify(maker)), itemList, page, crumbLd(base, [['Trove', '/'], ['Makers', '/#vendors'], [s.name, u]])],
    }),
  };
}

function renderSell(base) {
  const f = require('./pages/facts').facts();
  const html = activate(storefront(), 'sell');
  return setHead(html, {
    base, url: `${base}/sell-on-trove`, title: 'Sell your handmade pieces on Trove',
    description: `Open a shop on Trove: nothing up front, you set the price and keep ${f.makerShare}%. Trove handles photography, delivery and customer care in Dubai and Abu Dhabi.`,
    ld: [{ '@type': 'WebPage', '@id': `${base}/sell-on-trove#page`, url: `${base}/sell-on-trove`, name: 'Sell on Trove', isPartOf: { '@id': `${base}/#website` }, about: orgRef(base) },
      crumbLd(base, [['Trove', '/'], ['Sell on Trove', '/sell-on-trove']])],
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
function priceLabel(s) {
  if (s.priceType === 'from') return 'From ' + moneyCents(s.priceCents);
  if (s.priceType === 'hourly') return moneyCents(s.priceCents) + ' / hour';
  return moneyCents(s.priceCents);
}
const TILE_TINTS = ['#DBC7BD', '#CAD5CC', '#FCC998', '#BED3DF', '#CFDBBE', '#F8D7E4'];
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
function svTile(s) {
  const seed = hashOf(s.title + s.provider.slug);
  const c = TILE_TINTS[seed % TILE_TINTS.length];
  return `<div class="svtile" style="background:center/cover url(&quot;data:image/svg+xml;utf8,${encodeURIComponent(motifSvg(seed, c, false))}&quot;)"></div>`;
}
const catNames = (slugs) => (slugs || []).map((sl) => { const c = tax.bySlug(sl); return c ? c.name : null; }).filter(Boolean);
function svCardHtml(s) {
  return `<div class="svcard" onclick="openService(${Number(s.id)})">
    ${svTile(s)}
    <div class="svbody">
      <div class="t">${esc(s.title)}</div>
      <div class="who"><a class="wholink" href="${esc(providerUrl(s.provider.slug))}">${esc(s.provider.name)}</a> · ${esc(s.provider.location || 'Dubai')}</div>
      <div class="meta"><span class="price">${priceLabel(s)}</span><span style="flex:1"></span><span class="tagchip">${esc(SETTING_LABEL[s.setting] || '')}</span></div>
    </div>
  </div>`;
}
function provCardHtml(p) {
  return `<article class="pcard" role="link" tabindex="0">
    <div class="cover" style="background:center/cover url(&quot;${esc(motifUrl(hashOf(p.slug), safeColor(p.color)))}&quot;)"></div>
    <div class="av" style="background:${safeColor(p.color)}">${esc((p.name || '?')[0])}</div>
    <h3><a class="pcard-link" href="${esc(providerUrl(p.slug))}">${esc(p.name)}</a></h3>
    <div class="loc">${esc(p.location || 'Dubai')}</div>
    <p>${esc(p.bio)}</p>
    <div class="pmeta"><span><b>${Number(p.serviceCount) || 0}</b> ${p.serviceCount === 1 ? 'service' : 'services'}</span>${p.fromCents ? `<span>from <b>${moneyCents(p.fromCents)}</b></span>` : ''}</div>
    <div class="pcats">${catNames(p.categories).map((n) => `<span class="tagchip">${esc(n)}</span>`).join('')}</div>
    ${p.shop && p.shop.productCount ? `<span class="also">Also sells pieces · ${esc(p.shop.name)}</span>` : ''}
  </article>`;
}
function servicesPage() { return readDoc('trove-services.html', servicesCache); }

/** The directory's first paint, as the page's script draws it for 'At home'. */
function directoryMarkup(html) {
  const services = servicesData().liveServices();
  const providers = servicesData().approvedProviders();
  const audience = 'home';
  const AUD_ICON = {
    home: { tint: '#CAD5CC', svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>' },
    makers: { tint: '#F8D7E4', svg: '<path d="M14 4l6 6-8.5 8.5a3 3 0 0 1-4.2 0l-1.8-1.8a3 3 0 0 1 0-4.2z"/><path d="M4 20c1.4-.3 2.4-1 3-2"/>' },
  };
  const aud = tax.AUDIENCES.map((a) => {
    const ic = AUD_ICON[a.key] || { tint: '#DBC7BD', svg: '<circle cx="12" cy="12" r="7"/>' };
    return `<button class="audbtn ${audience === a.key ? 'on' : ''}" aria-pressed="${audience === a.key}">
      <span class="ofic" style="background:${ic.tint}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ic.svg}</svg></span>
      <span><b>${esc(a.name)}</b><small>${esc(a.sub)}</small></span>
      <span class="arr">→</span>
    </button>`;
  }).join('');
  const cats = tax.SERVICE_CATEGORIES.filter((c) => c.audience === audience);
  const dir = cats.map((c) => {
    const list = services.filter((s) => s.category === c.slug); const n = list.length;
    const min = n ? Math.min(...list.map((s) => s.priceCents || 0)) : 0;
    return `<div class="dcard ${n ? 'live' : ''} ">
      <div class="top"><h3>${esc(c.name)}</h3><span class="cnt ${n ? '' : 'none'}">${n ? `${n} ${n === 1 ? 'service' : 'services'}` : 'Be the first'}</span></div>
      <div class="blurb">${esc(c.blurb)}</div>
      <p class="ex">${c.examples.map(esc).join(' · ')}</p>
      <div class="foot">${n
    ? `<span class="from">${min ? 'From ' + moneyCents(min) : ''}</span><span class="go">See services →</span>`
    : '<span></span><a href="/apply?for=services">Offer this →</a>'}</div>
    </div>`;
  }).join('');
  const all = services.filter((s) => cats.some((c) => c.slug === s.category));
  let results;
  if (!all.length) {
    results = `<div class="empty">No providers offer services ${esc((tax.AUDIENCES.find((a) => a.key === audience) || {}).name.toLowerCase())} yet — the Services Marketplace is just opening. Do one of these beautifully yourself? <a href="/apply?for=services">Become a provider</a> and be the first name here.</div>`;
  } else {
    const CAP = 8; const capped = all.length > CAP;
    results = `<section class="results" id="resultsSec">
    <div class="rhead"><h2>All services</h2><span>${all.length} ${all.length === 1 ? 'service' : 'services'}</span></div>
    <div class="svgrid">${(capped ? all.slice(0, CAP) : all).map(svCardHtml).join('')}</div>
    ${capped ? `<button class="showall">Show all ${all.length} services</button>` : ''}
  </section>`;
  }
  let out = fill(html, 'audSwitch', aud);
  out = fill(out, 'dir', dir);
  out = fill(out, 'results', results);
  if (providers.length) {
    const audSet = new Set(cats.map((c) => c.slug));
    const rel = (p) => ((p.categories || []).some((sl) => audSet.has(sl)) ? 1 : 0);
    out = out.replace('<section class="band" id="providers" hidden>', '<section class="band" id="providers">');
    out = fill(out, 'provGrid', [...providers].sort((a, b) => rel(b) - rel(a)).map(provCardHtml).join(''));
  }
  return { html: out, services, providers };
}

function servicesLd(base) {
  return {
    '@type': 'CollectionPage', '@id': `${base}/services#page`, url: `${base}/services`, name: 'Trove Services Marketplace',
    isPartOf: { '@id': `${base}/#website` }, about: orgRef(base), inLanguage: 'en',
  };
}

function renderServicesDirectory(base) {
  const { html, providers } = directoryMarkup(servicesPage());
  const itemList = {
    '@type': 'ItemList', name: 'Service providers on Trove', numberOfItems: providers.length,
    itemListElement: providers.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: base + providerUrl(p.slug), name: p.name })),
  };
  return setHead(html, {
    base, url: `${base}/services`, title: 'Services Marketplace · Trove',
    description: 'Creative services at your place in Dubai and Abu Dhabi — made-to-order pieces, repair, styling, workshops and photography at home, plus brand and shop support for makers.',
    ld: [servicesLd(base), itemList, crumbLd(base, [['Trove', '/'], ['Services Marketplace', '/services']])],
  });
}

/** /services/<slug>: one approved provider. Returns { html } | { notFound }. */
function renderProvider(base, slug) {
  const page = servicesData().providerPage(slug);
  if (!page) return { notFound: true };
  const { provider: p, services } = page;
  const u = providerUrl(p.slug);
  const url = base + u;
  let html = servicesPage();
  // The provider view is the page; the directory's hero heading steps down.
  html = html.replace('<body>', '<body class="pv">').replace('<section id="pview" hidden>', '<section id="pview">')
    .replace(/<h1 class="hero-t"([^>]*)>([\s\S]*?)<\/h1>/, '<h2 class="hero-t"$1>$2</h2>')
    .replace(/<h2 id="pvName"([^>]*)><\/h2>/, '<h1 id="pvName"$1></h1>');
  html = attr(html, 'pvHero', 'style', `background:center/cover url("${motifUrl(hashOf(p.slug), safeColor(p.color))}")`);
  html = attr(html, 'pvAv', 'style', `background:${safeColor(p.color)}`);
  html = fill(html, 'pvAv', esc((p.name || '?')[0]));
  html = fill(html, 'pvName', esc(p.name));
  html = fill(html, 'pvLoc', esc(p.location || 'Dubai'));
  html = fill(html, 'pvBio', esc(p.bio || ''));
  const emirate = (p.location || 'Dubai').split(',').pop().trim();
  html = fill(html, 'pvStats', `<div><b>${Number(p.serviceCount) || 0}</b><span>${p.serviceCount === 1 ? 'SERVICE' : 'SERVICES'}</span></div><div><b>${esc(emirate)}</b><span>BASED IN</span></div>${p.since ? `<div><b>${esc(p.since)}</b><span>ON TROVE SINCE</span></div>` : ''}`);
  html = fill(html, 'pvCats', catNames(p.categories).map((n) => `<span class="tagchip">${esc(n)}</span>`).join(''));
  html = fill(html, 'pvCount', `${services.length} ${services.length === 1 ? 'service' : 'services'}`);
  html = fill(html, 'pvGrid', services.length ? services.map(svCardHtml).join('')
    : `<div class="empty" style="grid-column:1/-1">${esc(p.name)} hasn't listed a service yet — check back soon.</div>`);
  // Their shop's pieces, when the same account sells on the storefront.
  if (p.shop && p.shop.productCount) {
    const pieces = liveProducts().filter((x) => x.shop.slug === p.shop.slug).slice(0, 8);
    if (pieces.length) {
      html = html.replace('<div class="pv-shop" id="pvShop" hidden>', '<div class="pv-shop" id="pvShop">');
      html = fill(html, 'pvShopCount', `${p.shop.productCount} ${p.shop.productCount === 1 ? 'piece' : 'pieces'} · ${esc(p.shop.name)}`);
      html = attr(html, 'pvShopLink', 'href', makerUrl(p.shop.slug));
      html = fill(html, 'pvPieces', pieces.map((pr) => {
        const img = coverOf(pr) || motifUrl(hashOf(pr.name), safeColor(p.color));
        return `<a class="pc" href="${esc(pieceUrl(pr))}"><div class="pcimg" style="background-image:url(&quot;${esc(img)}&quot;)"></div><div class="pcb"><div class="pct">${esc(pr.name)}</div><div class="pcp">${money(pr.price)}</div></div></a>`;
      }).join(''));
    }
  }
  const title = `${p.name}${p.location ? `, ${p.location}` : ''} · Trove Services Marketplace`;
  const from = services.length ? `, from ${moneyCents(Math.min(...services.map((s) => s.priceCents || 0)))}` : '';
  const description = compose(`${services.length ? `${services.length} ${services.length === 1 ? 'service' : 'services'}${from}, booked` : 'Book'} in Dubai and Abu Dhabi. `,
    p.bio || services.map((s) => s.title).join(', '), '');
  const business = {
    '@type': ['LocalBusiness', 'ProfessionalService'],
    '@id': `${url}#provider`,
    name: p.name,
    url,
    description: p.bio || undefined,
    image: `${base}${OG_IMAGE}`,
    address: { '@type': 'PostalAddress', addressLocality: emirate, addressCountry: 'AE' },
    areaServed: [
      { '@type': 'City', name: 'Dubai', containedInPlace: { '@type': 'Country', name: 'United Arab Emirates' } },
      { '@type': 'City', name: 'Abu Dhabi', containedInPlace: { '@type': 'Country', name: 'United Arab Emirates' } },
    ],
    currenciesAccepted: 'AED',
    priceRange: services.length ? `From ${moneyCents(Math.min(...services.map((s) => s.priceCents || 0)))}` : undefined,
    knowsAbout: catNames(p.categories),
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: `Services by ${p.name}`,
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
          serviceType: (tax.bySlug(s.category) || {}).name,
          provider: { '@id': `${url}#provider` },
          areaServed: s.setting === 'remote' ? 'AE' : ['Dubai', 'Abu Dhabi'],
        },
      })),
    },
  };
  return {
    html: setHead(html, {
      base, url, title, description, type: 'profile',
      ld: [JSON.parse(JSON.stringify(business)), crumbLd(base, [['Trove', '/'], ['Services Marketplace', '/services'], [p.name, u]])],
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
    WHERE p.status = 'live' AND s.status = 'approved' ORDER BY p.id`).all();
  const newest = later(...pieces.map((p) => p.mod));
  add('/', newest, '1.0', 'daily');
  if (pieces.length) add('/shop', newest, '0.8', 'daily');
  // Category shelves with something on them (an empty shelf is thin).
  const cats = new Map();
  for (const p of pieces) {
    const keys = [p.category, p.is_house ? 'House' : null].filter(Boolean);
    for (const k of keys) cats.set(k, later(cats.get(k), p.mod));
  }
  for (const [c, mod] of cats) add(shopUrl(c), mod, '0.6');
  add('/sell-on-trove', null, '0.6', 'monthly');
  for (const s of db.prepare(`SELECT s.slug, COALESCE(s.updated_at, s.created_at) AS mod,
      (SELECT MAX(COALESCE(p.updated_at, p.created_at)) FROM products p WHERE p.shop_id = s.id AND p.status = 'live') AS pmod
    FROM shops s WHERE s.status = 'approved' ORDER BY s.id`).all()) {
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
