'use strict';
/**
 * Site content — the admin-editable copy on the storefront: the homepage, the
 * Sell-on-Trove page, and the sitewide chrome (announcement bar, footer).
 *
 * DEFAULTS below mirror the copy that ships inside docs/trove.html (which
 * still renders on its own in demo mode). The admin panel saves whole
 * sections as overrides into the site_content table; GET /api/content serves
 * defaults with overrides layered on top, and the storefront applies it at
 * boot. Deleting an override falls back to the default.
 *
 * Heading strings may use two tokens the storefront renders safely:
 *   *word*  → Orange accent (never italic — the display face has no italic)
 *   |       → line break
 *
 * Every saved string passes the same banned-language rules CI enforces on
 * checked-in copy (src/copy-rules.js) — the CMS can't drift where the repo
 * can't.
 */
const db = require('./db');
const { copyViolation } = require('./copy-rules');

const DEFAULTS = {
  'site.promo': {
    text: 'Delivering across Dubai & Abu Dhabi · Free delivery on orders over AED 200',
  },
  'site.footer': {
    blurb: 'Thoughtfully designed homeware and handcrafted finds from independent makers in the Trove Marketplace, delivered across Dubai and Abu Dhabi. Objects worth keeping.',
    legal: '© 2026 Trove · Dubai, UAE',
  },
  // Who Trove is, for the About, Contact and legal pages and the
  // Organization structured data. Owner, 2026-10-02: Trove and Trove at Home
  // are brand names of Serein Consultancy LLC (Sharjah Media City (Shams)
  // licence 2220356.01), the company every legal document names. The owner
  // can still edit any field in /admin → Site content; a blank field is not
  // shown, and with every field blank the pages say the details are being
  // finalised (never made-up ones). VAT TRN stays blank until the owner
  // decides on VAT registration.
  'site.company': {
    legalName: 'Serein Consultancy LLC',
    tradeLicence: '2220356.01',
    licenceAuthority: 'Sharjah Media City (Shams), Sharjah, UAE',
    address: 'Sharjah Media City (Shams), Sharjah, United Arab Emirates',
    email: 'hello@troveathome.com',
    whatsapp: '',
    vatTrn: '104316607100003',
  },
  'home.hero': {
    eyebrow: 'Thoughtfully gathered',
    h1: 'Curated|for *Living*.',
    lead: 'Discover handcrafted homeware from independent makers across the UAE, each piece chosen by hand for the Trove Marketplace.',
    ctaShop: 'Shop the Collection',
    ctaSell: 'Explore the Marketplace',
    tagLine: 'Our own line',
    tagName: 'Trove Collection →',
    stageLabel: 'On the shelf this week',
    productIds: [],
    crops: {},
  },
  'home.marquee': {
    items: [
      { head: 'Handpicked shops', sub: 'Vetted by hand' },
      { head: 'Small-batch pieces', sub: 'Made to last' },
      { head: 'Delivery time shown', sub: 'On every piece, most 3–6 days' },
      { head: '15-day returns', sub: 'Free on orders over AED 200' },
    ],
  },
  'home.browse': { eyebrow: 'Browse by', heading: 'Where would you like to begin?' },
  'home.weekly': {
    eyebrow: 'The weekly edit',
    heading: "This week's finds",
    linkLabel: 'Shop everything →',
    productIds: [],
    crops: {},
  },
  'home.collection': {
    eyebrow: 'The Trove Collection · Designed by Trove',
    h2: 'Our own, made well.',
    intro: 'Timeless pieces designed to become part of your everyday home. Designed by Trove, made with quality materials and considered details — created to feel at home from the moment they arrive.',
    points: [
      { title: 'Thoughtfully designed', text: 'Every detail has purpose — quality, functionality and beauty considered in every piece.' },
      { title: 'Made to last', text: 'We believe in buying fewer, better things: timeless design, honest materials, made to be enjoyed for years.' },
      { title: 'Made yours', text: 'Spot a personalisation option? That piece can be made just for you or someone special.' },
    ],
    cta: 'Shop the Collection',
    productIds: [],
    crops: {},
  },
  'home.makers': {
    eyebrow: 'The Trove Marketplace',
    heading: 'Meet the makers',
    intro: 'Discover handcrafted products from independent makers, carefully curated for their quality, creativity and craftsmanship.',
    shopSlugs: [],
  },
  'home.sellBand': {
    eyebrow: 'Sell on Trove',
    h2: 'Make things at home? Give them a *shopfront*.',
    intro: 'No shop experience needed and nothing to pay up front. You set your prices and keep your brand; Trove takes care of the photography, the marketing, the delivery and the storefront.',
    cta: 'See how it works',
    steps: [
      { title: 'Tell us about your craft', text: 'A short, friendly form — a real person reads every application.' },
      { title: 'Add your pieces', text: 'A name, a price, a few honest words — the form guides you.' },
      { title: 'Shoppers discover them', text: 'Your work appears beside the other makers, in search and collections.' },
      { title: 'Sold? We come to you', text: 'Our courier collects from your door. Fortnightly payouts, straight to your bank.' },
    ],
  },
  'sell.hero': {
    eyebrow: 'Sell on Trove',
    h1: "You make the pieces.|We'll be the *shop*.",
    intro: 'If you make things at home — ceramics, candles, knits, art, anything crafted with care — Trove gives them a proper shopfront. No shop experience needed, nothing to pay up front, and every price is yours to set.',
    ctaApply: 'Start your application',
    ctaHow: 'See how it works',
    // The deal at a glance, right under the hero buttons (F146): what a maker
    // keeps and when it is paid. Each promise is made once on the page (F147).
    facts: ['You keep 60% of every sale', 'Paid every other Tuesday, after the 15-day return window', 'Free to join'],
  },
  'sell.steps': {
    eyebrow: 'How it works',
    heading: 'Four steps from craft table to shopfront — with Trove carrying the load at every one.',
    items: [
      { title: 'Tell us about your craft', text: 'A short form about you and what you make — written like a chat, not paperwork. A real person reads every application, usually within a day or two.' },
      { title: 'Add your pieces', text: 'Give each piece a name, a price and a few honest words. The form guides you step by step — three or four pieces is a lovely start.' },
      { title: 'Shoppers discover them', text: 'Your work appears in search, categories and collections, beside the other makers — in front of people who came looking for something handmade.' },
      { title: 'Sold? We come to you', text: 'We email you the moment a piece sells, with the day to have it packed by. Pack it in your own packaging and mark it packed in your dashboard.' },
    ],
  },
  'sell.offer': {
    eyebrow: 'Included with every shop',
    heading: 'You make. Trove does the rest.',
    sub: 'All of it is part of the arrangement — no joining fee, no listing fee, no hidden costs.',
    items: [
      { title: 'No trade licence to start', text: 'Trove buys your pieces and resells them, so most home makers can start without a licence. Before your first payout we check your Emirates ID and home address.' },
      { title: 'Professional photography', text: 'Our photographer shoots your pieces so they look their best online — or use your own photos if you prefer.' },
      { title: 'Marketing, done for you', text: 'Trove runs the advertising, social media and featured placements that bring shoppers in — you never pay for promotion.' },
      { title: 'The shopkeeping', text: 'Storefront, checkout, card payments, customer questions and returns — Trove runs the shop so you can stay at the craft table.' },
      { title: 'Delivery, arranged and paid', text: 'Our courier collects each sold piece from your door and takes it to the buyer. Trove books and pays for every delivery.' },
      { title: 'Fortnightly payouts', text: "A sale is paid in the first payout after the buyer's 15-day return window closes, so returns are settled first. Your Payments page shows the date for each sale." },
    ],
  },
  'sell.quotes': {
    eyebrow: 'From our makers',
    heading: 'In their words.',
    sub: "Independent makers run their own shops on Trove. Here's how it feels from the studio side.",
    // Real, consented quotes only — added by the admin once a maker gives one.
    // The storefront shows a founding-makers panel while this list is empty.
    items: [],
  },
  'sell.faq': {
    eyebrow: 'Good to know',
    heading: 'Your questions, answered honestly.',
    items: [
      { q: "I've never sold online before — is that okay?", a: "That's exactly who Trove is built for. Your shop dashboard is a simple checklist — add a piece, see your orders, mark them ready — with no jargon anywhere. If you can post a photo to Instagram, you can run a Trove shop." },
      { q: 'Do I need a trade licence?', a: 'Most home makers can start without one: Trove buys your pieces from you and resells them to shoppers. Before your first payout we ask for your Emirates ID (front and back) and your home address to verify who you are, and if your sales grow a lot we may ask you to get an e-Trader licence. If you already have a licence, mention it when you apply — it unlocks extra payout options as you grow.' },
      { q: 'What does it cost?', a: "Nothing to join — no monthly fee, no listing fee, no hidden costs. You decide each piece's price. When one sells, Trove buys it from you at 60% of that price — photography, marketing, delivery and customer care all included — and that's the whole arrangement. If nothing sells, you owe nothing." },
      { q: 'How does delivery work?', a: "You don't deliver anything. When a piece sells, our courier collects it from your door and takes it to the buyer — you just have it packed in your own packaging, ready to hand over. You can follow each order's journey in your dashboard." },
      { q: 'How and when do I get paid?', a: "Every other Tuesday, to the bank account you add in your dashboard. A sale becomes payable once the piece is delivered and the buyer's 15-day return window has closed, so returns are settled before you are paid — in practice 16 to 29 days after delivery, depending on where the fortnight falls. Your Payments page shows exactly what's coming and when." },
      { q: 'What if I only make a few pieces a month?', a: "Small-batch is the point of Trove. A shop with four lovely pieces is very welcome — and the application asks how many orders a month you're comfortable with, so you're never overwhelmed." },
      { q: 'Can I keep selling on Instagram or at markets?', a: 'Of course. Your Trove shop is another shelf for your work, not an exclusive deal — keep selling wherever your customers already find you.' },
    ],
  },
  'sell.closing': {
    eyebrow: 'Ready when you are',
    heading: 'Give your craft a *shopfront*.',
    text: 'The application takes about ten minutes, and you can sign in and prepare your shop while a real person reviews it.',
    cta: 'Start your application',
  },
};

const SECTIONS = Object.keys(DEFAULTS);

/* ---- validation -------------------------------------------------------- */

// Long-form fields get more room than labels and headings.
const LONG_FIELDS = new Set(['lead', 'intro', 'text', 'a', 'blurb', 'quote']);
const MAX_SHORT = 200;
const MAX_LONG = 1200;

// Sections whose fields may be left blank (a blank field is simply not shown).
const OPTIONAL_SECTIONS = new Set(['site.company']);
const COMPANY_PENDING = 'Company details are being finalised — write to us via the contact form.';
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

// Flexible list bounds; anything not listed must keep the default length.
const LIST_BOUNDS = {
  'sell.hero.facts': [2, 6],
  'sell.steps.items': [2, 6],
  'sell.offer.items': [3, 8],
  'sell.quotes.items': [0, 6],
  'sell.faq.items': [1, 12],
};

// Shape of one entry for lists whose default is empty (nothing to copy it from).
const LIST_ITEM_SHAPES = {
  'sell.quotes.items': { quote: '', name: '', shop: '' },
};

/* The sell page once shipped five invented maker quotes as its defaults, and
 * a saved override can still carry them. They are never served: only a
 * real maker's words appear. Matched on maker name and shop together. */
const SEEDED_QUOTES = [
  ['mara', 'kiln & clay'], ['nadia', 'sable & stone'], ['yasmin', 'fern apothecary'],
  ['saeed', 'ember goods'], ['lena', 'northbound loom'],
];
const isSeededQuote = (q) => {
  const name = String((q && q.name) || '').trim().toLowerCase();
  const shop = String((q && q.shop) || '').trim().toLowerCase();
  return SEEDED_QUOTES.some(([n, s]) => name === n && shop.startsWith(s));
};

class ContentError extends Error {}
const bad = (msg) => { throw new ContentError(msg); };

function checkString(section, key, v) {
  if (typeof v !== 'string') bad(`"${key}" must be text`);
  const s = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (!s) bad(`"${key}" can't be empty`);
  const max = LONG_FIELDS.has(key) ? MAX_LONG : MAX_SHORT;
  if (s.length > max) bad(`"${key}" is too long (max ${max} characters)`);
  const hit = copyViolation(s);
  if (hit) bad(`The phrase “${hit}” can't be used — Trove buys pieces and resells them, it never handles anyone else's money, and it makes no claims it can't back up.`);
  return s;
}

// A blank-allowed field: trimmed, capped, no markup; the email must look like one.
function checkOptional(section, key, v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return '';
  const s = checkString(section, key, v);
  if (/[<>]/.test(s)) bad(`"${key}" can't contain < or >`);
  if (key === 'email' && !EMAIL_RE.test(s)) bad('That email address doesn\'t look right');
  if (key === 'whatsapp' && !/^\+?[0-9 ()-]{7,20}$/.test(s)) bad('Write the WhatsApp number with digits only, e.g. +971 50 123 4567');
  return s;
}

/** Validate a full section object against its default's shape; returns a clean copy. */
function validateSection(section, value) {
  if (!SECTIONS.includes(section)) bad('Unknown content section');
  const def = DEFAULTS[section];
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Section content must be an object');
  const clean = {};
  for (const key of Object.keys(def)) {
    const dv = def[key];
    const v = value[key];
    if (key === 'productIds') {
      // An older admin build may omit keys added later — treat missing as empty.
      if (v == null) { clean[key] = []; continue; }
      if (!Array.isArray(v)) bad('"productIds" must be a list');
      if (v.length > 8) bad('Pick at most 8 pieces');
      clean[key] = v.map((n) => {
        if (!Number.isInteger(n) || n < 1) bad('Picked pieces must be product ids');
        return n;
      });
    } else if (key === 'shopSlugs') {
      if (v == null) { clean[key] = []; continue; }
      if (!Array.isArray(v)) bad('"shopSlugs" must be a list');
      if (v.length > 8) bad('Pick at most 8 makers');
      clean[key] = v.map((s) => {
        if (typeof s !== 'string' || !/^[a-z0-9-]{1,80}$/.test(s)) bad('Picked makers must be shop slugs');
        return s;
      });
    } else if (key === 'crops') {
      // Homepage image crops: { productId: { x, y, z } } — focal point in %, zoom 1–3.
      if (v == null) { clean[key] = {}; continue; }
      if (typeof v !== 'object' || Array.isArray(v)) bad('"crops" must be a map of piece crops');
      const entries = Object.entries(v);
      if (entries.length > 12) bad('Too many crops — clear ones you no longer use');
      const cc = {};
      for (const [id, c] of entries) {
        if (!/^\d{1,10}$/.test(id)) bad('Crops must be keyed by product id');
        if (!c || typeof c !== 'object' || Array.isArray(c)) bad('Each crop must set x, y and z');
        const num = (n, lo, hi, name) => {
          const f = Number(c[n]);
          if (!Number.isFinite(f) || f < lo || f > hi) bad(`Crop ${name} must be between ${lo} and ${hi}`);
          return Math.round(f * 10) / 10;
        };
        cc[id] = { x: num('x', 0, 100, 'position'), y: num('y', 0, 100, 'position'), z: num('z', 1, 3, 'zoom') };
      }
      clean[key] = cc;
    } else if (Array.isArray(dv)) {
      if (!Array.isArray(v)) bad(`"${key}" must be a list`);
      const [min, max] = LIST_BOUNDS[`${section}.${key}`] || [dv.length, dv.length];
      if (v.length < min || v.length > max) {
        bad(min === max ? `"${key}" must have exactly ${min} items` : `"${key}" needs ${min}–${max} items`);
      }
      const itemDef = dv.length ? dv[0] : LIST_ITEM_SHAPES[`${section}.${key}`];
      if (itemDef === undefined) bad(`"${key}" can't be edited`);
      clean[key] = v.map((item) => {
        if (typeof itemDef === 'string') return checkString(section, key, item);
        if (!item || typeof item !== 'object') bad(`Each "${key}" entry must have its fields filled in`);
        const ci = {};
        for (const f of Object.keys(itemDef)) ci[f] = checkString(section, f, item[f]);
        return ci;
      });
    } else if (OPTIONAL_SECTIONS.has(section)) {
      clean[key] = checkOptional(section, key, v);
    } else {
      clean[key] = checkString(section, key, v);
    }
  }
  return clean;
}

/* ---- storage ----------------------------------------------------------- */

function overrides() {
  const out = {};
  for (const r of db.prepare('SELECT section, value FROM site_content').all()) {
    try { if (SECTIONS.includes(r.section)) out[r.section] = JSON.parse(r.value); } catch (_) {}
  }
  return out;
}

function getPublic() {
  const ov = overrides();
  const out = {};
  for (const s of SECTIONS) {
    const [page, key] = s.split('.');
    // defaults underlie every override, so a field added later is never missing from a section saved earlier
    (out[page] = out[page] || {})[key] = ov[s] ? { ...DEFAULTS[s], ...ov[s] } : DEFAULTS[s];
  }
  const q = out.sell && out.sell.quotes;
  if (q && Array.isArray(q.items)) out.sell.quotes = { ...q, items: q.items.filter((it) => !isSeededQuote(it)) };
  return out;
}

function save(section, value) {
  const clean = validateSection(section, value);
  db.prepare(`INSERT INTO site_content (section, value, updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(section) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`)
    .run(section, JSON.stringify(clean));
  return clean;
}

function reset(section) {
  if (!SECTIONS.includes(section)) bad('Unknown content section');
  db.prepare('DELETE FROM site_content WHERE section=?').run(section);
}

/** The company details as saved (blank fields ''), plus whether any are filled. */
function company() {
  const c = { ...DEFAULTS['site.company'], ...(overrides()['site.company'] || {}) };
  return { ...c, filled: Object.values(c).some((v) => typeof v === 'string' && v.trim()) };
}

module.exports = { DEFAULTS, SECTIONS, getPublic, overrides, save, reset, ContentError, isSeededQuote, company, COMPANY_PENDING, EMAIL_RE };
