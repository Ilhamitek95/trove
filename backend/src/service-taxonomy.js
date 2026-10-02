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

/* -------- Arabic (Modern Standard Arabic), hand-written --------
 * Same keys and order as above. The English objects stay exactly as they
 * are (validation, slugs, tests); localized('ar') / bySlug(slug, 'ar')
 * hand back copies with the Arabic text in the same fields. */
const AUDIENCES_AR = {
  home: { name: 'في منزلك', sub: 'للمتسوّقين والمضيفين' },
  makers: { name: 'للصنّاع', sub: 'للبائعين والعلامات التجارية الصغيرة' },
};
const CATEGORIES_AR = {
  'made-to-order': {
    name: 'صناعة حسب الطلب وتخصيص',
    blurb: 'قطع تُصنع خصيصاً لك، وأغراضك الخاصة بلمسة شخصية.',
    examples: [
      'جداريات — لغرف الأطفال والجدران المميّزة',
      'الخط اليدوي والخط العربي — لافتات وأظرف وقرطاسية وكتابة حيّة',
      'تخصيص قطعك الخاصة — تطريز وحروف أولى ونقش ورسم يدوي',
      'قطع للذكرى — ألحفة من ملابس الطفولة وألبومات مجلّدة يدوياً ودفاتر وصفات',
      'بورتريهات حيّة — رسم سريع وكاريكاتير وبورتريهات للحيوانات الأليفة',
    ],
  },
  'care-repair': {
    name: 'العناية والإصلاح',
    blurb: 'قطع عزيزة تعود إليها الحياة، وبيوت تستعيد أناقتها.',
    examples: [
      'تعليق اللوحات وتنسيق جدران المعارض ونصائح التأطير',
      'إصلاح الخزف وفن الكينتسوغي',
      'ترميم الأثاث وتجديده بطلاء الطباشير وإعادة نسج القش والتنجيد',
      'ستائر ووسائد مفصّلة حسب المقاس',
      'تعديلات الخياطة وإصلاح السجاد والأغطية',
    ],
  },
  'styling-celebrations': {
    name: 'التنسيق والمناسبات',
    blurb: 'غرف منسّقة وموائد مُعدّة ومناسبات تزداد جمالاً.',
    examples: [
      'تنسيق الموائد والمناسبات',
      'تركيبات البالونات والخلفيات والزهور',
      'تنسيق المنزل في المواسم — رمضان والعيد وديوالي والميلاد واليوم الوطني',
      'تغليف الهدايا وأعمال الشرائط والسلال والتوزيعات',
      'أفكار الحفلات وتنسيق يوم المناسبة',
      'تجهيزات حفلات استقبال المولود والكشف عن جنسه وغرف الأطفال',
      'استشارات التنسيق الداخلي وتنسيق الرفوف وأعلى المدفأة ونصائح الألوان وتجهيز المنزل للعرض',
    ],
  },
  workshops: {
    name: 'ورش عمل في المنزل',
    blurb: 'صانع يأتي إليك — أمسيات حِرفية للأصدقاء والعائلات والصغار.',
    examples: [
      'تشكيل الفخار يدوياً وحفلات الرسم والألوان المائية',
      'التطريز والنسيج والمكرمية والطباعة بالقوالب',
      'صبّ الشموع وصناعة الأكاليل والخط',
      'دروس الخياطة والحياكة',
      'أعياد ميلاد حِرفية للأطفال وأمسيات حِرفية في العطلات',
      'جلسات حِرفية لحفلات العروس وللعائلات',
    ],
  },
  'portraits-photography': {
    name: 'البورتريه والتصوير',
    blurb: 'أحبّاؤك وبيتك ولحظاتك المميّزة — بعدسة جميلة.',
    examples: [
      'جلسات تصوير عائلية وللمواليد والحوامل في المنزل',
      'جلسات تصوير للمناسبات واللحظات اليومية',
      'رسّامون ومخطّطون حيّون في المناسبات',
    ],
  },
  'live-entertainment': {
    name: 'ترفيه إبداعي حيّ',
    blurb: 'عروض تصنع اللقاء.',
    examples: [
      'الحكواتي وعروض الدمى',
      'عزف العود والعروض الصوتية',
      'عروض الشعر والخط',
    ],
  },
  'content-visuals': {
    name: 'المحتوى والمرئيات',
    blurb: 'تصوير وأفلام تُنصف قطعك.',
    examples: [
      'تصوير المنتجات والتصوير المسطّح وتصوير نمط الحياة في الاستوديو الخاص بك',
      'التنقيح والتحرير',
      'مقاطع ريلز وفيديوهات من كواليس الصناعة',
      'تنسيق المنتجات وتوفير الإكسسوارات',
    ],
  },
  'brand-design': {
    name: 'العلامة التجارية والتصميم',
    blurb: 'هوية مدروسة بقدر العمل نفسه.',
    examples: [
      'تصميم الشعار والهوية',
      'التغليف والملصقات وبطاقات التعليق وبطاقات العناية',
      'الرسم التوضيحي وتصميم النقوش',
      'تنسيق الكتالوجات وكتيّبات المجموعات',
      'تصميم أكشاك الأسواق والمتاجر المؤقتة',
    ],
  },
  'words-both-languages': {
    name: 'الكلمات، باللغتين',
    blurb: 'قصتك تُروى بإتقان — بالإنجليزية والعربية.',
    examples: [
      'أوصاف المنتجات والسير التعريفية وقصة العلامة',
      'نصوص تسويقية وتعليقات بالإنجليزية والعربية',
      'النشرات البريدية ورسائل الإطلاق',
    ],
  },
  'social-growth': {
    name: 'التواصل الاجتماعي والنمو',
    blurb: 'نموّ ثابت وصادق للعلامات الصغيرة.',
    examples: [
      'إعداد إنستغرام وتيك توك وتقويمات المحتوى والإدارة الشهرية',
      'تخطيط الإطلاق والحملات',
      'إعلانات Meta وGoogle بميزانيات صغيرة',
      'تحسين محركات البحث وملف Google التجاري ومراجعات التحليلات',
    ],
  },
  'selling-support': {
    name: 'دعم المتجر والمبيعات',
    blurb: 'الجانب العملي من البيع، نتولّاه عنك.',
    examples: [
      'إعداد الموقع والمتجر الإلكتروني والنطاق والبريد',
      'نصائح التسعير والهوامش',
      'عروض البيع بالجملة والتواصل لهدايا الشركات',
      'تنظيم المتاجر المؤقتة والأسواق',
      'تنسيق التعاون بين الصنّاع',
      'إعداد مسك الدفاتر والاستعداد لضريبة القيمة المضافة (استشارة فقط)',
    ],
  },
  coaching: {
    name: 'الإرشاد',
    blurb: 'شخص يسبقك بخطوات، يقف إلى جانبك.',
    examples: [
      'إرشاد في الأعمال الصغيرة والتسعير والإطلاق',
      'إرشاد «أول 100 عملية بيع»',
      'إرشاد في ملف الأعمال وتجهيز الاستوديو',
    ],
  },
};

/** The audiences + categories with their text in a language (same shapes). */
function localized(lang) {
  if (lang !== 'ar') return { audiences: AUDIENCES, categories: SERVICE_CATEGORIES };
  return {
    audiences: AUDIENCES.map((a) => ({ ...a, ...(AUDIENCES_AR[a.key] || {}) })),
    categories: SERVICE_CATEGORIES.map((c) => ({ ...c, ...(CATEGORIES_AR[c.slug] || {}) })),
  };
}

const CATEGORY_SLUGS = SERVICE_CATEGORIES.map((c) => c.slug);
/** A category by slug; with lang 'ar' a copy with the Arabic text. */
const bySlug = (slug, lang) => {
  const c = SERVICE_CATEGORIES.find((x) => x.slug === slug) || null;
  return c && lang === 'ar' && CATEGORIES_AR[slug] ? { ...c, ...CATEGORIES_AR[slug] } : c;
};
/** An audience by key, localized like bySlug. */
const audience = (key, lang) => {
  const a = AUDIENCES.find((x) => x.key === key) || null;
  return a && lang === 'ar' && AUDIENCES_AR[key] ? { ...a, ...AUDIENCES_AR[key] } : a;
};
/** Just the category's display name ('' when unknown). */
const nameOf = (slug, lang) => { const c = bySlug(slug, lang); return c ? c.name : ''; };

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

module.exports = { AUDIENCES, SERVICE_CATEGORIES, CATEGORY_SLUGS, bySlug, audience, nameOf, localized, CATEGORIES_AR, AUDIENCES_AR, PRICE_TYPES, SETTINGS, serviceCategoryError };
