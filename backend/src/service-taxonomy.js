'use strict';
/**
 * Services taxonomy — the categories a service provider can list under.
 * Two audiences:
 *   home   — "At home": services for shoppers and hosts
 *   makers — "For makers": services for sellers and small brands
 *
 * Everything is delivered in person in Dubai & Abu Dhabi (or remotely where
 * the setting allows). Like the product taxonomy, anything regulated is out:
 * no food or catering, no beauty/skin treatments, no medical or financial
 * services beyond plain advice. Providers pay a monthly platform
 * subscription (fees.PROVIDER_SUB_FEE_CENTS); Trove takes no cut of the
 * service price itself.
 */

const AUDIENCES = [
  { key: 'home', name: 'At home', sub: 'For shoppers and hosts' },
  { key: 'makers', name: 'For makers', sub: 'For sellers and small brands' },
];

const SERVICE_CATEGORIES = [
  /* -------- At home -------- */
  {
    slug: 'made-to-order', audience: 'home', name: 'Made to order & personalisation',
    blurb: 'Pieces made for you, and your own things made personal.',
    examples: [
      'Wall murals — nursery and feature walls',
      'Hand-lettering & calligraphy — signage, envelopes, stationery, live lettering',
      'Personalising your own pieces — embroidery, monogramming, engraving, hand-painting',
      'Memory pieces — quilts from baby clothes, hand-bound albums, recipe books',
      'Portraits from life — sketch, caricature, pet portraits',
    ],
  },
  {
    slug: 'care-repair', audience: 'home', name: 'Care & repair',
    blurb: 'Loved pieces brought back to life, and homes put right.',
    examples: [
      'Art hanging, gallery-wall curation & framing advice',
      'Ceramic repair & kintsugi',
      'Furniture restoration, chalk-paint makeovers, re-caning & reupholstery',
      'Curtains & cushions made to measure',
      'Alterations, rug & throw repair',
    ],
  },
  {
    slug: 'styling-celebrations', audience: 'home', name: 'Styling & celebrations',
    blurb: 'Rooms styled, tables set, occasions made beautiful.',
    examples: [
      'Tablescape & event styling',
      'Balloon, backdrop & floral installations',
      'Seasonal home styling — Ramadan, Eid, Diwali, Christmas, National Day',
      'Gift wrapping, ribbon work, hampers & favours',
      'Party concepts & on-the-day coordination',
      'Baby-shower, gender-reveal & nursery setups',
      'Interior styling consults, shelf & mantel styling, colour advice, home staging',
    ],
  },
  {
    slug: 'workshops', audience: 'home', name: 'Workshops at home',
    blurb: 'A maker comes to you — craft afternoons for friends, families and little ones.',
    examples: [
      'Pottery hand-building, painting parties, watercolour',
      'Embroidery, weaving, macramé & block printing',
      'Candle pouring, wreath making, calligraphy',
      'Sewing & knitting lessons',
      "Kids' craft birthdays & holiday craft afternoons",
      'Hen-party & family craft sessions',
    ],
  },
  {
    slug: 'portraits-photography', audience: 'home', name: 'Portraits & photography',
    blurb: 'Your people, your home, your milestones — beautifully captured.',
    examples: [
      'Family, newborn & maternity shoots at home',
      'Milestone & lifestyle shoots',
      'Live event painters & sketch artists',
    ],
  },
  {
    slug: 'live-entertainment', audience: 'home', name: 'Live creative entertainment',
    blurb: 'Performances that make a gathering.',
    examples: [
      'Storytelling & puppet shows',
      'Oud & acoustic sets',
      'Poetry & calligraphy performances',
    ],
  },

  /* -------- For makers -------- */
  {
    slug: 'content-visuals', audience: 'makers', name: 'Content & visuals',
    blurb: 'Photography and film that do your pieces justice.',
    examples: [
      'Product, flat-lay & lifestyle photography at your studio',
      'Retouching & editing',
      'Reels & behind-the-making video',
      'Product styling & prop sourcing',
    ],
  },
  {
    slug: 'brand-design', audience: 'makers', name: 'Brand & design',
    blurb: 'An identity as considered as the work itself.',
    examples: [
      'Logo & identity design',
      'Packaging, labels, hang tags, care cards & stickers',
      'Illustration & pattern design',
      'Catalogue & lookbook layout',
      'Market-stall & pop-up booth design',
    ],
  },
  {
    slug: 'words-both-languages', audience: 'makers', name: 'Words, both languages',
    blurb: 'Your story told well — in English and Arabic.',
    examples: [
      'Product descriptions, bios & brand story',
      'English–Arabic marketing copy & captions',
      'Newsletters & launch emails',
    ],
  },
  {
    slug: 'social-growth', audience: 'makers', name: 'Social & growth',
    blurb: 'Steady, honest growth for small brands.',
    examples: [
      'Instagram & TikTok setup, content calendars, monthly management',
      'Launch & campaign planning',
      'Small-budget Meta & Google ads',
      'SEO, Google Business Profile & analytics reviews',
    ],
  },
  {
    slug: 'selling-support', audience: 'makers', name: 'Shop & selling support',
    blurb: 'The practical side of selling, handled.',
    examples: [
      'Website & online-shop setup, domain & email',
      'Pricing & margin advice',
      'Wholesale decks & corporate-gifting outreach',
      'Pop-up & market organising',
      'Maker-to-maker collaboration matchmaking',
      'Bookkeeping setup & VAT readiness (advice only)',
    ],
  },
  {
    slug: 'coaching', audience: 'makers', name: 'Coaching',
    blurb: 'Someone a few steps ahead, in your corner.',
    examples: [
      'Small-business, pricing & launch coaching',
      '"First 100 sales" coaching',
      'Portfolio & studio-setup mentoring',
    ],
  },
];

const CATEGORY_SLUGS = SERVICE_CATEGORIES.map((c) => c.slug);
const bySlug = (slug) => SERVICE_CATEGORIES.find((c) => c.slug === slug) || null;

// How a service is priced. "from" = starting price, the final quote depends
// on the brief; "hourly" = per hour on site.
const PRICE_TYPES = ['fixed', 'from', 'hourly'];
// Where it happens. "home" = at the customer's place, "studio" = at the
// provider's, "remote" = delivered online (design, copy, coaching…).
const SETTINGS = ['home', 'studio', 'remote'];

/** null when the category slug is valid, else an Error with .status = 422. */
function serviceCategoryError(slug) {
  const err = (msg) => Object.assign(new Error(msg), { status: 422 });
  const s = String(slug || '').trim();
  if (!s) return err('A service category is required.');
  if (!CATEGORY_SLUGS.includes(s)) return err(`"${s}" isn't one of Trove's service categories.`);
  return null;
}

module.exports = { AUDIENCES, SERVICE_CATEGORIES, CATEGORY_SLUGS, bySlug, PRICE_TYPES, SETTINGS, serviceCategoryError };
