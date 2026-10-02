'use strict';
/**
 * Server-rendered public pages: About, Contact, the Help centre (FAQ),
 * Delivery & Returns, the buyer Terms of Sale, the Privacy Policy and the
 * three agreements (seller, provider, services). Every page is plain HTML
 * with its real text in the response, so search engines, AI answer engines
 * and link previews read it without running any JavaScript.
 *
 * The header is the storefront's: it is copied at render time from
 * docs/trove-services.html (which test/header-sync.test.js already keeps
 * identical to the storefront), so these pages can never drift from it.
 * The footer is copied the same way: one pattern on every public page.
 *
 * The same sources feed /llms.txt and /llms-full.txt, and the Organization
 * structured data carries the company details the owner fills in at
 * /admin → Site content → Company details (blank until then — never
 * invented).
 */
const fs = require('fs');
const path = require('path');
const md = require('./markdown');
const { esc } = md;
const config = require('./config');
const content = require('./content');
const gtm = require('./gtm');
const { facts } = require('./pages/facts');
const i18n = require('./i18n');

const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');
const LEGAL_DIR = path.join(__dirname, '..', 'legal');

/* ---- the legal documents (also served as JSON by /api/legal/:doc) ---- */
const LEGAL = {
  terms: {
    file: 'buyer-terms', version: () => config.BUYER_TERMS_VERSION, path: '/terms',
    title: 'Terms of Sale',
    description: 'The terms that apply when you buy from Trove: Trove is the seller, delivery across Dubai and Abu Dhabi, card payment via Stripe, 15-day returns.',
  },
  privacy: {
    file: 'privacy', version: () => config.PRIVACY_VERSION, path: '/privacy',
    title: 'Privacy Policy',
    description: 'What personal data Trove collects, why, who it is shared with, how long it is kept and your rights under the UAE Personal Data Protection Law.',
  },
  'seller-agreement': {
    file: 'seller-agreement', version: () => config.AGREEMENT_VERSION, path: '/seller-agreement',
    title: 'Seller Agreement',
    description: 'The agreement between Trove and the makers who sell on it: Trove buys each piece and resells it, the margin, payouts, returns and verification.',
  },
  'provider-agreement': {
    file: 'provider-agreement', version: () => config.PROVIDER_AGREEMENT_VERSION, path: '/provider-agreement',
    title: 'Provider Agreement',
    description: 'The agreement between Trove and the independent providers on the Services Marketplace.',
  },
  'services-terms': {
    file: 'services-terms', version: () => config.SERVICES_TERMS_VERSION, path: '/services-terms',
    title: 'Services Terms',
    description: 'The terms that apply when you book a service on the Trove Services Marketplace. The provider, not Trove, is responsible for the service.',
  },
};
// The API names the buyer terms after its file; both spellings resolve.
const LEGAL_ALIASES = { 'buyer-terms': 'terms' };

/**
 * A legal document, always the English text that governs (its hash is what
 * acceptance records point at). With lang 'ar', `arabic` carries the
 * convenience translation (backend/legal/<file>-<version>-ar.md) when it
 * exists: { markdown, sha256, translationOf: <the English sha256> }.
 */
function legalDoc(name, lang = 'en') {
  const key = LEGAL_ALIASES[name] || name;
  const d = Object.prototype.hasOwnProperty.call(LEGAL, key) ? LEGAL[key] : null;
  if (!d) return null;
  const version = d.version();
  const markdown = fs.readFileSync(path.join(LEGAL_DIR, `${d.file}-${version}.md`), 'utf8');
  const sha256 = require('./crypto').sha256(markdown);
  const out = { key, ...d, version, markdown, sha256 };
  if (lang === 'ar') {
    const f = path.join(LEGAL_DIR, `${d.file}-${version}-ar.md`);
    if (fs.existsSync(f)) {
      const ar = fs.readFileSync(f, 'utf8');
      out.arabic = { markdown: ar, sha256: require('./crypto').sha256(ar), translationOf: sha256 };
    }
  }
  return out;
}

/* ---- the shared header, copied from the Services page ---- */
let _chrome = null;
let _chromeStamp = 0;
function chrome() {
  const file = path.join(DOCS_DIR, 'trove-services.html');
  const stamp = fs.statSync(file).mtimeMs;
  if (_chrome && stamp === _chromeStamp) return _chrome;
  const html = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const cssStart = html.indexOf('  em,i,cite{');
  const cssEnd = html.indexOf('  /* buttons (the provider CTA band) */');
  const hStart = html.indexOf('<div class="promo">');
  const hEnd = html.indexOf('</aside>', hStart);
  if (cssStart < 0 || cssEnd < cssStart || hStart < 0 || hEnd < 0) {
    throw new Error('site-pages: the shared header could not be found in docs/trove-services.html');
  }
  const footer = (html.match(/<footer class="site">[\s\S]*?<\/footer>/) || [])[0];
  if (!footer) throw new Error('site-pages: the shared footer could not be found in docs/trove-services.html');
  const header = html.slice(hStart, hEnd + '</aside>'.length)
    // no "you are here" marker: none of these pages is in the menu
    .replace('<a href="/services" class="on">', '<a href="/services">')
    .replace('<a class="mn-link" href="/services" onclick="closeSheets();return false">', '<a class="mn-link" href="/services">');
  _chrome = { css: html.slice(cssStart, cssEnd), header, footer };
  _chromeStamp = stamp;
  return _chrome;
}

/* ---- site facts shared by every page ---- */
const SITE_NAME = 'Trove';
function hasHousePieces() {
  try {
    const db = require('./db');
    return !!db.prepare(`SELECT 1 FROM products p JOIN shops s ON s.id = p.shop_id
      WHERE s.is_house = 1 AND s.status = 'approved' AND p.status = 'live' LIMIT 1`).get();
  } catch (_) { return true; }
}

/** Company details for display: only the filled ones, with labels. */
function companyRows(c, lang = 'en') {
  const T = (k) => i18n.t(lang, k);
  const rows = [];
  if (c.legalName) {
    rows.push([T('Legal name'), c.legalName]);
    rows.push([T('Trading as'), T('Trove and Trove at Home')]);
  }
  // the licensing authority is the owner's own wording; Shams has a known Arabic name
  const authority = lang === 'ar' && c.licenceAuthority ? T(c.licenceAuthority) : c.licenceAuthority;
  if (c.tradeLicence) rows.push([T('Trade licence'), (lang === 'ar' ? i18n.iso(lang, c.tradeLicence) : c.tradeLicence) + (authority ? `${lang === 'ar' ? '، ' : ', '}${authority}` : '')]);
  else if (c.licenceAuthority) rows.push([T('Licensing authority'), authority]);
  if (c.address) rows.push([T('Registered address'), lang === 'ar' ? T(c.address) : c.address]);
  if (c.vatTrn) rows.push([T('VAT TRN'), c.vatTrn, 'ltr']);
  if (c.email) rows.push([T('Email'), c.email, 'email']);
  if (c.whatsapp) rows.push(['WhatsApp', c.whatsapp, 'whatsapp']);
  return rows;
}
const waLink = (n) => 'https://wa.me/' + String(n).replace(/[^0-9]/g, '');

function companyBlockHtml(c, { heading = 'Company details', id = 'company', lang = 'en' } = {}) {
  const rows = companyRows(c, lang);
  const body = rows.length
    ? `<dl class="co-dl">${rows.map(([k, v, kind]) => {
      let val = esc(v);
      if (kind === 'email') val = `<a href="mailto:${esc(v)}" dir="ltr">${esc(v)}</a>`;
      if (kind === 'whatsapp') val = `<a href="${esc(waLink(v))}" rel="noopener" dir="ltr">${esc(v)}</a>`;
      if (kind === 'ltr' && lang === 'ar') val = `<span dir="ltr">${val}</span>`;
      if (kind === 'email' && lang !== 'ar') val = val.replace(' dir="ltr"', '');
      if (kind === 'whatsapp' && lang !== 'ar') val = val.replace(' dir="ltr"', '');
      return `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`;
    }).join('')}</dl>`
    : lang === 'ar'
      ? `<p class="co-pending">${esc(i18n.t(lang, 'Company details are being finalised — write to us via'))} <a href="/contact">${esc(i18n.t(lang, 'the contact form'))}</a>.</p>`
      : `<p class="co-pending">${esc(content.COMPANY_PENDING.replace(/the contact form\.$/, ''))}<a href="/contact">the contact form</a>.</p>`;
  return `<section class="co-card" id="${id}"><h2>${esc(i18n.t(lang, heading))}</h2>${body}</section>`;
}
function companyText(c) {
  const rows = companyRows(c);
  return rows.length ? rows.map(([k, v]) => `- ${k}: ${v}`).join('\n') : content.COMPANY_PENDING;
}

/* ---- structured data ---- */
function organizationLd(base, c) {
  const org = {
    '@type': ['Organization', 'OnlineStore'],
    '@id': `${base}/#organization`,
    name: SITE_NAME,
    alternateName: 'Trove at Home',
    url: `${base}/`,
    logo: `${base}/apple-touch-icon.png`,
    description: 'A curated online marketplace for homeware and handmade pieces by independent makers, delivering across Dubai and Abu Dhabi.',
    areaServed: [
      { '@type': 'City', name: 'Dubai', containedInPlace: { '@type': 'Country', name: 'United Arab Emirates' } },
      { '@type': 'City', name: 'Abu Dhabi', containedInPlace: { '@type': 'Country', name: 'United Arab Emirates' } },
    ],
    currenciesAccepted: 'AED',
    paymentAccepted: 'Credit card, debit card',
    hasMerchantReturnPolicy: {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'AE',
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      merchantReturnDays: facts().returnDays,
      url: `${base}/returns`,
    },
  };
  if (c.legalName) org.legalName = c.legalName;
  if (c.vatTrn) org.vatID = c.vatTrn;
  if (c.address) org.address = { '@type': 'PostalAddress', streetAddress: c.address, addressCountry: 'AE' };
  if (c.email || c.whatsapp) {
    org.contactPoint = {
      '@type': 'ContactPoint',
      contactType: 'customer service',
      areaServed: 'AE',
      availableLanguage: ['English'],
      url: `${base}/contact`,
    };
    if (c.email) org.contactPoint.email = c.email;
    if (c.whatsapp) org.contactPoint.telephone = c.whatsapp.replace(/[^0-9+]/g, '');
  }
  return org;
}
function ldScript(obj) {
  // </script> can never close the tag early: every < is escaped inside JSON.
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...obj }).replace(/</g, '\\u003c')}</script>`;
}

/* ---- FAQ parsing (page, FAQPage data and llms-full share one source) ---- */
function faqSections(src) {
  const sections = [];
  let sec = null;
  let q = null;
  for (const block of src.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^# /.test(t)) continue;
    if (/^## /.test(t)) { sec = { title: md.plain(t.slice(3)), items: [] }; sections.push(sec); q = null; continue; }
    if (/^### /.test(t)) { q = { q: md.plain(t.slice(4)), a: [] }; if (sec) sec.items.push(q); continue; }
    if (q) q.a.push(t);
  }
  return sections;
}

/* ---- page shell ---- */
const PAGE_CSS = `
  .page{max-width:780px;margin:0 auto;padding:46px 26px 20px}
  .crumb{font-size:12.5px;font-weight:600;color:var(--muted);letter-spacing:.03em}
  .crumb a{text-decoration:underline}
  .page h1{font-size:clamp(38px,5vw,54px);font-weight:500;line-height:1.04;margin:14px 0 10px;letter-spacing:-.005em}
  .page .sub{color:var(--muted);font-weight:600;font-size:13.5px;margin-bottom:8px;line-height:1.6}
  .page .lede{font-size:17px;color:var(--ink-80);font-weight:400;line-height:1.65;margin:14px 0 6px}
  .prose{font-size:15.5px;line-height:1.72;color:var(--ink-80);font-weight:400}
  .prose h2{font-family:var(--font-display);font-size:30px;font-weight:600;color:var(--char);margin:38px 0 10px;line-height:1.1;scroll-margin-top:110px}
  .prose h3{font-family:'Quicksand',system-ui,sans-serif;font-size:16px;font-weight:700;color:var(--char);margin:24px 0 6px;scroll-margin-top:110px}
  .prose p{margin:10px 0}
  .prose ul,.prose ol{margin:10px 0 10px 22px}
  .prose li{margin:6px 0;padding-left:2px}
  .prose strong{font-weight:700;color:var(--char)}
  .prose a{color:var(--accent-ink);text-decoration:underline;text-underline-offset:2px}
  .prose a:hover{color:var(--char)}
  .toc{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 4px}
  .toc a{display:inline-block;padding:8px 14px;border:1.5px dashed rgba(41,39,39,.26);border-radius:999px;font-size:12.5px;font-weight:700;color:var(--char)}
  .toc a:hover{border-style:solid;border-color:var(--char)}
  .co-card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:20px 22px;margin:34px 0 8px}
  .co-card h2{font-family:var(--font-display);font-size:24px;font-weight:600;margin:0 0 10px}
  .co-dl{display:grid;gap:8px}
  .co-dl div{display:grid;grid-template-columns:170px 1fr;gap:12px;font-size:14.5px}
  .co-dl dt{color:var(--muted);font-weight:600}
  .co-dl dd{font-weight:600;color:var(--char);word-break:break-word}
  .co-dl a{text-decoration:underline}
  .co-pending{font-size:14.5px;color:var(--ink-80);font-weight:500;line-height:1.6}
  .co-pending a{text-decoration:underline}
  .hash{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:11.5px;word-break:break-all;line-height:1.6}
  .hash a{text-decoration:underline}
  /* contact form */
  .cform{display:grid;gap:14px;margin-top:22px;background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:24px}
  .cform .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .cform label{display:block;font-size:12px;letter-spacing:.06em;font-weight:700;color:var(--muted);margin-bottom:6px}
  .cform input,.cform select,.cform textarea{width:100%;font-family:inherit;font-size:15px;font-weight:500;color:var(--char);background:var(--cream);border:1px solid var(--line);border-radius:12px;padding:12px 14px;outline:none}
  .cform textarea{min-height:150px;resize:vertical;line-height:1.55}
  .cform input:focus,.cform select:focus,.cform textarea:focus{border-color:var(--char)}
  .cform .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .cform .note{font-size:12.5px;color:var(--muted);font-weight:500;line-height:1.55}
  .cform .note a{text-decoration:underline}
  .cform button{justify-self:start;padding:14px 26px;border-radius:999px;background:var(--char);color:var(--cream);font-weight:600;font-size:14px}
  .cform button:hover{background:#3B3737}
  .cform button[disabled]{opacity:.6;cursor:default}
  .cmsg{display:none;border-radius:14px;padding:13px 16px;font-size:14px;font-weight:600;line-height:1.55}
  .cmsg.ok{display:block;background:var(--sage-tint)}
  .cmsg.err{display:block;background:#FCEBE4}
  .direct{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}
  .direct div{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:14px 16px}
  .direct b{display:block;font-size:12px;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-bottom:4px}
  .direct span,.direct a{font-size:15px;font-weight:600;user-select:all;word-break:break-word}
  .direct a{text-decoration:underline}
  /* the Arabic edition: a translation note, and right-to-left lists and fields */
  .tr-note{background:var(--sage-tint,#EEF2EF);border:1px solid var(--line);border-radius:16px;padding:14px 18px;margin:16px 0 4px;font-size:14.5px;line-height:1.7;color:var(--ink-80);font-weight:500}
  .tr-note p{margin:0}
  .tr-note a{text-decoration:underline;font-weight:600}
  [dir="rtl"] .prose ul,[dir="rtl"] .prose ol{margin:10px 22px 10px 0}
  [dir="rtl"] .prose li{padding-left:0;padding-right:2px}
  [dir="rtl"] .cform .hp{left:auto;right:-9999px}
  [dir="rtl"] .prose{font-size:16px;line-height:1.9}
  [dir="rtl"] .page h1{line-height:1.3}
  [dir="rtl"] .hash{direction:rtl}
  @media(max-width:620px){
    .page{padding:32px 20px 10px}
    .prose h2{font-size:26px;margin-top:32px}
    .co-dl div{grid-template-columns:1fr;gap:1px}
    .cform{padding:18px}
    .cform .row2,.direct{grid-template-columns:1fr}
  }
`;

/** The shared site footer, copied from the Services page with the CMS lines filled in. */
function footerHtml(siteContent) {
  const f = (siteContent && siteContent.site && siteContent.site.footer) || content.DEFAULTS['site.footer'];
  return chrome().footer
    .replace(/(<p class="blurb" data-cms="site\.footer\.blurb">)[^<]*(<\/p>)/, (m, a, b) => a + esc(f.blurb) + b)
    .replace(/(<span data-cms="site\.footer\.legal">)[^<]*(<\/span>)/, (m, a, b) => a + esc(f.legal) + b);
}

function shell({ base, pathName, title, description, h1, sub = '', crumb = '', body, ld = [], extraHead = '', script = '', lang = 'en' }) {
  const ch = chrome();
  // the admin-edited promo + footer lines, in Arabic when the page is (src/translate.js)
  const siteContent = require('./translate').siteContent(content.getPublic(), lang);
  const promo = (siteContent.site && siteContent.site.promo && siteContent.site.promo.text) || '';
  const header = ch.header.replace(
    /(<div class="wrap" data-cms="site\.promo\.text">)[^<]*(<\/div>)/,
    (m, a, b) => a + esc(promo) + b,
  );
  const url = base + pathName;
  const fullTitle = `${title} · Trove`;
  // The Trove Collection link stays in the header and footer even before its
  // first piece (its shelf says what is coming).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${gtm.SNIPPET}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${esc(fullTitle)}</title>
<meta name="trove-i18n" content="server">
<meta name="description" content="${esc(description)}">
${require('./seo').socialTags({ base, url, title: fullTitle, description, lang })}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant:wght@400;500;600&family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${ch.css}${PAGE_CSS}
</style>
${ldScript({ '@graph': [organizationLd(base, content.company()), ...ld] })}
${extraHead}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<!-- HEADER: the storefront's (copied from trove-services.html at render time; test/header-sync.test.js checks it) -->
${header}

<main class="page" id="main">
  <div class="crumb"><a href="/">Trove</a>${crumb ? ` &nbsp;/&nbsp; ${crumb}` : ''} &nbsp;/&nbsp; <span>${esc(h1)}</span></div>
  <h1>${esc(h1)}</h1>
  ${sub ? `<div class="sub">${sub}</div>` : ''}
  ${body}
</main>

${footerHtml(siteContent)}

<script src="/config.js"></script>
<script src="/api.js"></script>
<script src="/site-chrome.js"></script>
${script}
</body>
</html>
`;
}

/* ---- the pages ---- */
function webPageLd(base, pathName, name, type = 'WebPage') {
  return { '@type': type, '@id': `${base}${pathName}#page`, url: `${base}${pathName}`, name, isPartOf: { '@id': `${base}/#organization` }, inLanguage: 'en' };
}

/** Arabic page bodies: prices in a left-to-right isolate; a link back to the English
 *  version (?hl=en) is the language switch, so it keeps its English address. */
function arBody(html, lang) {
  if (lang !== 'ar') return html;
  return i18n.isoPrices(html).replace(/<a href="(\/[^"?#]*)\?hl=en"/g, '<a data-lang-switch href="$1?hl=en" hreflang="en" lang="en"');
}
/** The help sources in the page's language. */
const helpSource = (name, lang) => (lang === 'ar'
  ? require(`./pages/${name}-ar`)(require('./pages/facts-ar').factsAr())
  : require(`./pages/${name}`)(facts()));

function renderAbout(base, lang = 'en') {
  const T = (k, v) => i18n.t(lang, k, v);
  const src = helpSource('about', lang);
  const c = content.company();
  return shell({
    base, pathName: '/about', title: T('About Trove'), h1: T('About Trove'), lang,
    description: T('Trove is a curated marketplace for homeware and handmade pieces by independent makers, delivering across Dubai and Abu Dhabi. How curation works, who it is for, and who we are.'),
    body: arBody(`<div class="toc"><a href="#curation">${esc(T('How curation works'))}</a><a href="#who-trove-is-for">${esc(T('Who Trove is for'))}</a><a href="#company">${esc(T('Company details'))}</a></div>
<div class="prose">${md.toHtml(src)}</div>
${companyBlockHtml(c, { lang })}`, lang),
    ld: [webPageLd(base, '/about', T('About Trove'), 'AboutPage')],
  });
}

function renderReturns(base, lang = 'en') {
  const T = (k, v) => i18n.t(lang, k, v);
  const src = helpSource('delivery-returns', lang);
  const fa = lang === 'ar' ? require('./pages/facts-ar').factsAr() : null;
  return shell({
    base, pathName: '/returns', title: T('Delivery & Returns'), h1: T('Delivery & Returns'), lang,
    description: lang === 'ar'
      ? T('Trove delivers to Dubai and Abu Dhabi, with the delivery time shown on every piece (most arrive in {days}): AED 30 on orders of AED 200 and below, free above. Returns within {returns} of delivery, collected by our courier.', { days: fa.deliveryDays, returns: fa.returnDaysText })
      : `Trove delivers to Dubai and Abu Dhabi, with the delivery time shown on every piece (most arrive in ${facts().deliveryDays}): AED 30 on orders of AED 200 and below, free above. Returns within ${facts().returnDays} days of delivery, collected by our courier.`,
    body: arBody(`<div class="toc"><a href="#delivery">${esc(T('Delivery'))}</a><a href="#returns">${esc(T('Returns'))}</a><a href="#the-collection-fee">${esc(T('Collection fee'))}</a><a href="#personalised">${esc(T('Personalised pieces'))}</a></div>
<div class="prose">${md.toHtml(src)}</div>`, lang),
    ld: [webPageLd(base, '/returns', T('Delivery & Returns'))],
  });
}

function renderFaq(base, lang = 'en') {
  const T = (k, v) => i18n.t(lang, k, v);
  const src = helpSource('faq', lang);
  const sections = faqSections(src);
  const toc = src.match(/^## .*$/gm).map((h) => {
    const m = h.match(/\{#([a-z0-9-]+)\}/);
    return `<a href="#${m ? m[1] : md.slug(h.slice(3))}">${esc(md.plain(h.slice(3)))}</a>`;
  }).join('');
  const faqLd = {
    '@type': 'FAQPage',
    '@id': `${base}/faq#page`,
    url: `${base}/faq`,
    name: T('Trove Help centre'),
    mainEntity: sections.flatMap((s) => s.items.map((it) => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a.map((p) => md.plain(p, base)).join(' ') },
    }))),
  };
  return shell({
    base, pathName: '/faq', title: T('Help centre'), h1: T('Help centre'), lang,
    description: T('Answers about buying on Trove (payment, delivery to Dubai and Abu Dhabi, 15-day returns), selling as a maker (60% to you, fortnightly payouts) and the Services Marketplace.'),
    body: arBody(`<div class="toc">${toc}</div><div class="prose">${md.toHtml(src)}</div>`, lang),
    ld: [faqLd],
  });
}

const TOPICS = [
  ['order', 'An order'],
  ['returns', 'A return or refund'],
  ['selling', 'Selling on Trove'],
  ['services', 'The Services Marketplace'],
  ['privacy', 'Privacy and my data'],
  ['other', 'Something else'],
];

function renderContact(base, { sent = false, error = '', lang = 'en' } = {}) {
  const T = (k, v) => i18n.t(lang, k, v);
  const c = content.company();
  const ltr = lang === 'ar' ? ' dir="ltr"' : '';
  const direct = [];
  if (c.email) direct.push(`<div><b>${esc(T('Email'))}</b><a href="mailto:${esc(c.email)}"${ltr}>${esc(c.email)}</a></div>`);
  if (c.whatsapp) direct.push(`<div><b>WhatsApp</b><a href="${esc(waLink(c.whatsapp))}" rel="noopener"${ltr}>${esc(c.whatsapp)}</a></div>`);
  const thanks = T('Thank you — your message is with us. We will reply to the email address you gave.');
  const msg = sent
    ? `<div class="cmsg ok" id="cMsg" role="status">${esc(thanks)}</div>`
    : `<div class="cmsg${error ? ' err' : ''}" id="cMsg" role="status">${esc(error)}</div>`;
  const body = `<p class="lede">${esc(T('Questions about an order, a return, selling on Trove or anything else: write to us here and a real person will reply by email. If it is about an order, please include the order number (it starts with TRV-).'))}</p>
${direct.length ? `<div class="direct">${direct.join('')}</div>` : ''}
<form class="cform" id="cForm" method="post" action="/api/contact" novalidate>
  ${msg}
  <div class="row2">
    <div><label for="cName">${esc(T('YOUR NAME'))}</label><input id="cName" name="name" autocomplete="name" maxlength="80" required></div>
    <div><label for="cEmail">${esc(T('EMAIL'))}</label><input id="cEmail" name="email" type="email" autocomplete="email" maxlength="254" required></div>
  </div>
  <div class="row2">
    <div><label for="cTopic">${esc(T('WHAT IS IT ABOUT?'))}</label><select id="cTopic" name="topic">${TOPICS.map(([v, l]) => `<option value="${v}">${esc(T(l))}</option>`).join('')}</select></div>
    <div><label for="cOrder">${esc(T('ORDER NUMBER (IF ANY)'))}</label><input id="cOrder" name="orderRef" maxlength="30" placeholder="TRV-…"${ltr}></div>
  </div>
  <div><label for="cBody">${esc(T('YOUR MESSAGE'))}</label><textarea id="cBody" name="message" maxlength="4000" required></textarea></div>
  <div class="hp" aria-hidden="true"><label for="cWeb">${esc(T('Leave this empty'))}</label><input id="cWeb" name="website" tabindex="-1" autocomplete="off"></div>
  <p class="note">${lang === 'ar' ? `${esc(T('We use your details only to answer you. See the'))} <a href="/privacy">${esc(T('Privacy Policy'))}</a>.` : 'We use your details only to answer you. See the <a href="/privacy">Privacy Policy</a>.'}</p>
  <button type="submit" id="cSend">${esc(T('Send message'))}</button>
</form>
<div class="prose"><h2 id="quick-answers">${esc(T('Quick answers'))}</h2>
${lang === 'ar'
    ? `<ul><li><a href="/returns">${esc(T('Delivery & Returns'))}</a>: ${esc(T('costs, timings and how to send a piece back.'))}</li><li><a href="/faq">${esc(T('Help centre'))}</a>: ${esc(T('buying, selling and services questions.'))}</li><li><a href="/account#orders">${esc(T('Your orders'))}</a>: ${esc(T('track a parcel or request a return.'))}</li></ul></div>`
    : '<ul><li><a href="/returns">Delivery &amp; Returns</a>: costs, timings and how to send a piece back.</li><li><a href="/faq">Help centre</a>: buying, selling and services questions.</li><li><a href="/account#orders">Your orders</a>: track a parcel or request a return.</li></ul></div>'}
${companyBlockHtml(c, { lang })}`;
  // The form's own messages, in the page's language (JSON-encoded into the script).
  const js = (k) => JSON.stringify(T(k)).replace(/</g, '\\u003c');
  const script = `<script>
(function(){
  var f=document.getElementById('cForm'),m=document.getElementById('cMsg'),b=document.getElementById('cSend');
  var t=new URLSearchParams(location.search).get('topic');if(t){var s=document.getElementById('cTopic');for(var i=0;i<s.options.length;i++)if(s.options[i].value===t)s.value=t;}
  f.addEventListener('submit',async function(e){
    e.preventDefault();
    var d={};new FormData(f).forEach(function(v,k){d[k]=String(v);});
    m.className='cmsg';m.textContent='';b.disabled=true;b.textContent=${js('Sending…')};
    try{
      await TroveAPI.api('/api/contact',{method:'POST',body:d});
      f.reset();m.className='cmsg ok';m.textContent=${js('Thank you — your message is with us. We will reply to the email address you gave.')};
    }catch(err){m.className='cmsg err';m.textContent=err.message||${js('That did not send — please try again.')};}
    b.disabled=false;b.textContent=${js('Send message')};m.scrollIntoView({block:'nearest',behavior:'smooth'});
  });
})();
</script>`;
  return shell({
    base, pathName: '/contact', title: T('Contact'), h1: T('Contact us'), lang,
    description: T('Contact Trove about an order, a return, selling on Trove or the Services Marketplace. We deliver across Dubai and Abu Dhabi.'),
    body: arBody(body, lang), script, ld: [webPageLd(base, '/contact', T('Contact Trove'), 'ContactPage')],
  });
}

/**
 * Arabic headings have no Latin slug: give the Arabic document's h2/h3 the
 * English document's ids, heading for heading, so /privacy#2-what-we-collect
 * and /ar/privacy#2-what-we-collect land on the same section.
 */
function alignIds(arHtml, enHtml) {
  for (const lvl of [2, 3]) {
    const ids = [...enHtml.matchAll(new RegExp(`<h${lvl} id="([^"]*)">`, 'g'))].map((m) => m[1]);
    let i = 0;
    const count = (arHtml.match(new RegExp(`<h${lvl} id="[^"]*">`, 'g')) || []).length;
    arHtml = arHtml.replace(new RegExp(`<h${lvl} id="([^"]*)">`, 'g'), (m, id) => {
      const n = i++;
      if (id) return m;
      return `<h${lvl} id="${count === ids.length ? ids[n] : `s${lvl}-${n + 1}`}">`;
    });
  }
  return arHtml;
}

function renderLegal(base, name, lang = 'en') {
  const T = (k, v) => i18n.t(lang, k, v);
  const d = legalDoc(name, lang);
  const c = content.company();
  const ar = lang === 'ar' && d.arabic ? d.arabic.markdown : null;
  // The Arabic file opens with a blockquote: a translation for convenience, the English prevails.
  let note = '';
  let src = ar || d.markdown;
  if (ar) {
    const q = src.match(/^(?:>[^\n]*\n?)+/m);
    if (q) {
      note = `<div class="tr-note" role="note">${md.toHtml(q[0].replace(/^>\s?/gm, ''))}</div>`;
      src = src.replace(q[0], '');
    }
  } else if (lang === 'ar') {
    note = `<div class="tr-note" role="note"><p>${esc(T('The Arabic translation of this document is being prepared. The English text below is the version that applies.'))}</p></div>`;
  }
  const firstBold = src.match(/^\*\*(.+)\*\*\s*$/m);
  const sub = firstBold ? esc(firstBold[1]) : esc(T('Version {v}', { v: d.version }));
  const bodySrc = firstBold ? src.replace(firstBold[0], '') : src;
  const apiName = name === 'terms' ? 'buyer-terms' : name;
  const buyerDoc = name === 'terms' || name === 'privacy';
  const others = [['/terms', 'Terms of Sale'], ['/privacy', 'Privacy Policy'], ['/returns', 'Delivery & Returns'], ['/services-terms', 'Services Terms'], ['/seller-agreement', 'Seller Agreement'], ['/provider-agreement', 'Provider Agreement']]
    .filter(([p]) => p !== d.path);
  let prose = md.toHtml(bodySrc);
  if (ar) prose = alignIds(prose, md.toHtml(d.markdown));
  const hash = lang === 'ar'
    ? `<div class="hash">${esc(T('Document integrity (SHA-256) of the English version, which applies:'))} <span dir="ltr">${esc(d.sha256)}</span> · ${esc(T('Machine-readable copy:'))} <a href="/api/legal/${esc(apiName)}" dir="ltr">/api/legal/${esc(apiName)}</a> · <a href="${d.path}?hl=en">${esc(T('Read the English version'))}</a><br>${esc(T('Also see:'))} ${others.map(([p, l]) => `<a href="${p}">${esc(T(l))}</a>`).join(' · ')}</div>`
    : `<div class="hash">Document integrity (SHA-256): ${esc(d.sha256)} · Machine-readable copy: <a href="/api/legal/${esc(apiName)}">/api/legal/${esc(apiName)}</a><br>Also see: ${others.map(([p, l]) => `<a href="${p}">${esc(l)}</a>`).join(' · ')}</div>`;
  return shell({
    base, pathName: d.path, title: T(d.title), h1: T(d.title), description: T(d.description), sub, lang,
    body: arBody(`${note}<div class="prose">${prose}</div>
${buyerDoc ? companyBlockHtml(c, { lang }) : ''}
${hash}`, lang),
    ld: [webPageLd(base, d.path, T(d.title))],
  });
}

/* ---- llms.txt / llms-full.txt ---- */
function llmsTxt(base) {
  const f = facts();
  const c = content.company();
  return `# Trove

> Trove (also known as Trove at Home, ${base.replace(/^https?:\/\//, '')}) is a curated online marketplace for homeware and handmade pieces by independent makers, based in Dubai and delivering to ${f.areas} only. Trove is the seller of record (merchant of record) for every product order; buyers pay Trove by card through Stripe.

## Key facts

- Service area: ${f.areas}, United Arab Emirates. Delivery addresses anywhere else are not accepted.
- Currency: UAE dirhams (AED). No service fee.
- Delivery: ${f.deliveryFee} on orders of ${f.freeOver} and below; free on orders over ${f.freeOver}. Delivery time is shown on every piece: the maker's make/pack time plus ${f.transitDays} with the courier. Most pieces arrive in ${f.deliveryDays}; made-to-order pieces show their own time (up to ${f.maxLeadWeeks} weeks). Orders with pieces from several makers may arrive in separate parcels.
- Returns: request within ${f.returnDays} days of delivery from the account's Orders page; Trove's courier collects the piece; the refund is issued once the courier has collected the return. An ${f.deliveryFee} collection fee applies only to change-of-mind returns on orders of ${f.freeOver} and below, never when a piece is faulty, damaged or wrong; it is charged once per return request. The original delivery charge is refunded when the whole order comes back faulty, damaged, wrong or not as described. Personalised pieces can be returned only if faulty or wrong.
- Curation: every maker applies and a real person reviews every application before a shop goes live.
- Makers: apply at ${base}/apply. Nothing to join; Trove buys each sold piece at ${f.makerShare}% of the maker's price (a ${f.commission}% margin covering photography, marketing, checkout, delivery and customer care) and pays makers ${f.payoutRhythm}, by bank transfer.
- Services Marketplace (${base}/services): creative services at home in ${f.areas} by independent providers, who (not Trove) are responsible for the service. Customers settle directly with the provider or pay through Trove by card where available. Providers apply at ${base}/apply?for=services and pay ${f.providerSub} a month; Trove keeps ${f.serviceCommission}% of bookings paid through Trove.
- Company details: ${companyRows(c).length ? companyRows(c).map(([k, v]) => `${k}: ${v}`).join('; ') : `being finalised; write to Trove through the contact form at ${base}/contact`}

## Pages

- [Home](${base}/): the storefront
- [Shop all](${base}/shop): every piece on sale, by category
- [About Trove](${base}/about): what Trove is, how curation works, who it is for
- [Delivery & Returns](${base}/returns): delivery costs and times, the returns policy with examples
- [Help centre](${base}/faq): questions for buyers, makers and service providers
- [Contact](${base}/contact): contact form
- [Services Marketplace](${base}/services): in-person creative services
- [Sell on Trove](${base}/sell-on-trove): how selling on Trove works for makers
- [Apply](${base}/apply): the maker and provider application

## Policies

- [Terms of Sale](${base}/terms)
- [Privacy Policy](${base}/privacy)
- [Seller Agreement](${base}/seller-agreement)
- [Provider Agreement](${base}/provider-agreement)
- [Services Terms](${base}/services-terms)

## Optional

- [Full text of About, Delivery & Returns and the Help centre](${base}/llms-full.txt)
`;
}

function llmsFullTxt(base) {
  const f = facts();
  const about = md.toText(require('./pages/about')(f), base).trim();
  const returns = md.toText(require('./pages/delivery-returns')(f), base).trim();
  const faq = md.toText(require('./pages/faq')(f), base).trim();
  return `# Trove — full text

Source: ${base}/llms.txt · Pages: ${base}/about, ${base}/returns, ${base}/faq

${about}

## Company details

${companyText(content.company())}

---

${returns}

---

${faq}
`;
}

module.exports = {
  LEGAL, legalDoc, chrome, footerHtml, faqSections, organizationLd, hasHousePieces,
  renderAbout, renderReturns, renderFaq, renderContact, renderLegal, llmsTxt, llmsFullTxt, TOPICS,
};
