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
 *   *word*  → italic accent      |  → line break
 *
 * Every saved string passes the same banned-language rules CI enforces on
 * checked-in copy (src/copy-rules.js) — the CMS can't drift where the repo
 * can't.
 */
const db = require('./db');
const { copyViolation } = require('./copy-rules');

const DEFAULTS = {
  'site.promo': {
    text: 'Delivering across Dubai & Abu Dhabi · Free delivery on orders over AED 500',
  },
  'site.footer': {
    blurb: 'Thoughtfully chosen homeware from the Trove Collection, alongside handcrafted finds from independent makers in the Trove Marketplace. Objects worth keeping.',
    legal: '© 2026 trove · Dubai, UAE',
  },
  'home.hero': {
    eyebrow: 'Thoughtfully gathered',
    h1: 'Curated|for *Living*',
    lead: 'Discover thoughtfully chosen homeware from the Trove Collection alongside handcrafted finds from independent makers in the Trove Marketplace.',
    ctaShop: 'Explore the trove',
    ctaSell: 'Open a shop →',
    tagLine: 'Our own line',
    tagName: 'Trove Collection →',
  },
  'home.marquee': {
    items: [
      { head: 'Handpicked shops', sub: 'Vetted by hand' },
      { head: 'Small-batch pieces', sub: 'Made to last' },
      { head: '2–4 day delivery', sub: 'Dubai & Abu Dhabi' },
      { head: '30-day returns', sub: 'Free on orders over AED 500' },
    ],
  },
  'home.browse': { eyebrow: 'Browse by', heading: 'Where would you like to begin?' },
  'home.weekly': {
    eyebrow: 'The weekly edit',
    heading: "This week's finds",
    linkLabel: 'Shop everything →',
    productIds: [],
  },
  'home.collection': {
    eyebrow: 'Curated by trove',
    h2: 'Trove Collection.|*Our own, made well.*',
    intro: 'Timeless pieces chosen to become part of your everyday home. Curated by us, made by makers we trust, priced honestly.',
    points: [
      { title: 'Authentic', text: "Every piece is chosen by hand and made in small batches by real makers — each one comes out a little different, and that's the point." },
      { title: 'Homely', text: 'Warm, everyday pieces made to be lived with — poured, thrown and stitched to make a house feel like home, not kept behind glass.' },
      { title: 'Made yours', text: 'Spot a personalisation box on a piece? That maker will add your name or a few words of your choosing — made just for you.' },
    ],
    cta: 'Shop the Collection',
  },
  'home.makers': {
    eyebrow: 'The Trove Marketplace',
    heading: 'Meet the makers',
    intro: 'Discover handcrafted products from independent makers, carefully curated for their quality, creativity and craftsmanship.',
  },
  'home.sellBand': {
    eyebrow: 'Sell on trove',
    h2: 'Make things at home? Give them a *shopfront*.',
    intro: 'No shop experience needed and nothing to pay up front. You set your prices; when a piece sells, Trove buys it from you at 80% of your price and takes care of delivery and the storefront — you keep your brand and your craft.',
    cta: 'See how it works',
    steps: [
      { title: 'Tell us about your craft', text: 'A short, friendly form — a real person reads every application.' },
      { title: 'Add your pieces', text: 'A name, a price, a few honest words — the form guides you.' },
      { title: 'Shoppers discover them', text: 'Your work appears beside the other makers, in search and collections.' },
      { title: 'Sold? We come to you', text: 'Our courier collects from your door. Weekly payouts, straight to your bank.' },
    ],
  },
  'sell.hero': {
    eyebrow: 'Sell on trove',
    h1: "You make the pieces.|We'll be the *shop*.",
    intro: 'If you make things at home — ceramics, candles, knits, art, anything crafted with care — trove gives them a proper shopfront. No shop experience needed, nothing to pay up front. You set your prices; when a piece sells, Trove buys it from you at 80% of your price.',
    ctaApply: 'Start your application',
    ctaHow: 'See how it works',
    facts: ['Free to join', 'No trade licence needed', 'Courier collects from your door', 'A real person reviews every shop'],
  },
  'sell.steps': {
    eyebrow: 'How it works',
    heading: 'From craft table to shopfront, in four steps.',
    items: [
      { title: 'Tell us about your craft', text: 'A short form about you and what you make — written like a chat, not paperwork. A real person reads every application, usually within a day or two.' },
      { title: 'Add your pieces', text: 'Give each piece a name, a price and a few honest words. The form guides you step by step — three or four pieces is a lovely start.' },
      { title: 'Shoppers discover them', text: 'Your work appears in search, categories and collections, beside the other makers — in front of people who came looking for something handmade.' },
      { title: 'Sold? We come to you', text: 'Our courier collects the piece from your door. Trove buys it from you at 80% of your price, and your money arrives with the weekly payout.' },
    ],
  },
  'sell.faq': {
    eyebrow: 'Good to know',
    heading: 'Your questions, answered honestly.',
    items: [
      { q: "I've never sold online before — is that okay?", a: "That's exactly who trove is built for. Your shop dashboard is a simple checklist — add a piece, see your orders, mark them ready — with no jargon anywhere. If you can post a photo to Instagram, you can run a trove shop." },
      { q: 'Do I need a trade licence?', a: 'No. Trove buys your pieces from you and resells them to shoppers, so you can sell here without any licence. If you do have one, mention it when you apply — it unlocks extra payout options as you grow.' },
      { q: 'What does it cost?', a: "Nothing to join — no monthly fee, no listing fee. You decide each piece's price. When one sells, Trove buys it from you at 80% of that price, and that's the whole arrangement. If nothing sells, you owe nothing." },
      { q: 'How does delivery work?', a: "You don't deliver anything. When a piece sells, our courier collects it from your door and takes it to the buyer — you just have it wrapped and ready. You can follow each order's journey in your dashboard." },
      { q: 'How and when do I get paid?', a: "Weekly, to the bank account you add in your dashboard. A sale becomes payable once the piece is delivered plus a 7-day buffer; if a buyer returns a piece after that, the amount is simply adjusted on a following payout. Your Payments page shows exactly what's coming and when." },
      { q: 'What if I only make a few pieces a month?', a: "Small-batch is the point of trove. A shop with four lovely pieces is very welcome — and the application asks how many orders a month you're comfortable with, so you're never overwhelmed." },
      { q: 'Can I keep selling on Instagram or at markets?', a: 'Of course. Your trove shop is another shelf for your work, not an exclusive deal — keep selling wherever your customers already find you.' },
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
const LONG_FIELDS = new Set(['lead', 'intro', 'text', 'a', 'blurb']);
const MAX_SHORT = 200;
const MAX_LONG = 1200;

// Flexible list bounds; anything not listed must keep the default length.
const LIST_BOUNDS = {
  'sell.hero.facts': [2, 6],
  'sell.steps.items': [2, 6],
  'sell.faq.items': [1, 12],
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
      if (!Array.isArray(v)) bad('"productIds" must be a list');
      if (v.length > 8) bad('Pick at most 8 weekly finds');
      clean[key] = v.map((n) => {
        if (!Number.isInteger(n) || n < 1) bad('Weekly finds must be product ids');
        return n;
      });
    } else if (Array.isArray(dv)) {
      if (!Array.isArray(v)) bad(`"${key}" must be a list`);
      const [min, max] = LIST_BOUNDS[`${section}.${key}`] || [dv.length, dv.length];
      if (v.length < min || v.length > max) {
        bad(min === max ? `"${key}" must have exactly ${min} items` : `"${key}" needs ${min}–${max} items`);
      }
      const itemDef = dv[0];
      clean[key] = v.map((item) => {
        if (typeof itemDef === 'string') return checkString(section, key, item);
        if (!item || typeof item !== 'object') bad(`Each "${key}" entry must have its fields filled in`);
        const ci = {};
        for (const f of Object.keys(itemDef)) ci[f] = checkString(section, f, item[f]);
        return ci;
      });
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
    (out[page] = out[page] || {})[key] = ov[s] || DEFAULTS[s];
  }
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

module.exports = { DEFAULTS, SECTIONS, getPublic, overrides, save, reset, ContentError };
