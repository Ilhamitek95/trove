'use strict';
/**
 * Sell on Trove becomes 'Choose your path' (owner's pick, 2026-10-12): the
 * page asks pieces, services or both first and shows only that path. The
 * Site content behind it changed shape (src/content.js): new keys for the
 * services and both wording, 'Your part' / 'Trove's part' instead of the
 * four-step hand-off, the arrangement card's terms, a topic and an audience
 * on every question.
 *
 * A saved override (Admin → Site content) is the owner's own wording and is
 * served as written, so one saved before today would keep the old page's
 * copy in the new layout. Like migrations 013/017/021/024/026-E:
 *   - a field still holding the OLD shipped wording is removed from the
 *     override, so today's default (with fees.js's current figures) shows;
 *   - fields the new page no longer has (the second hero button, the old
 *     Trove lane caption) are removed;
 *   - a FAQ the owner reworded keeps every question: each gets the topic and
 *     audience of the shipped question it matches (else Getting started,
 *     makers — the old page was the makers' page), and the new questions for
 *     service providers are added so their path is not left without any.
 * Anything else the owner wrote is left alone. An override left empty is
 * deleted. The values are snapshots: a migration must not require
 * src/content.js (it requires the database this runs inside).
 */
const OLD = {
 "sell.hero": {
  "ctaHow": "See how it works",
  "facts": [
   "You keep 60% of every sale",
   "Paid every other Tuesday, after the 15-day return window",
   "Free to join"
  ]
 },
 "sell.steps": {
  "heading": "Four steps from craft table to shopfront — with Trove carrying the load at every one.",
  "items": [
   {
    "title": "Tell us about your craft",
    "text": "A short form about you and what you make — written like a chat, not paperwork. A real person reads every application, usually within a day or two."
   },
   {
    "title": "Add your pieces",
    "text": "Give each piece a name, a price and a few honest words. The form guides you step by step — three or four pieces is a lovely start."
   },
   {
    "title": "Shoppers discover them",
    "text": "Your work appears in search, categories and collections, beside the other makers — in front of people who came looking for something handmade."
   },
   {
    "title": "Sold? We come to you",
    "text": "We email you the moment a piece sells, with the day to have it packed by. Pack it in your own packaging and mark it packed in your dashboard."
   }
  ]
 },
 "sell.offer": {
  "eyebrow": "Included with every shop",
  "sub": "All of it is part of the arrangement — no joining fee, no listing fee, no hidden costs.",
  "items": [
   {
    "title": "No trade licence to start",
    "text": "Trove buys your pieces and resells them, so most home makers can start without a licence. Before your first payout we check your Emirates ID and home address."
   },
   {
    "title": "Professional photography",
    "text": "Our photographer shoots your pieces so they look their best online — or use your own photos if you prefer."
   },
   {
    "title": "Marketing, done for you",
    "text": "Trove runs the advertising, social media and featured placements that bring shoppers in — you never pay for promotion."
   },
   {
    "title": "The shopkeeping",
    "text": "Storefront, checkout, card payments, customer questions and returns — Trove runs the shop so you can stay at the craft table."
   },
   {
    "title": "Delivery, arranged and paid",
    "text": "Our courier collects each sold piece from your door and takes it to the buyer. Trove books and pays for every delivery."
   },
   {
    "title": "Fortnightly payouts",
    "text": "A sale is paid in the first payout after the buyer's 15-day return window closes, so returns are settled first. Your Payments page shows the date for each sale."
   }
  ]
 },
 "sell.faq": {
  "items": [
   {
    "q": "I've never sold online before — is that okay?",
    "a": "That's exactly who Trove is built for. Your shop dashboard is a simple checklist — add a piece, see your orders, mark them ready — with no jargon anywhere. If you can post a photo to Instagram, you can run a Trove shop."
   },
   {
    "q": "Do I need a trade licence?",
    "a": "Most home makers can start without one: Trove buys your pieces from you and resells them to shoppers. Before your first payout we ask for your Emirates ID (front and back) and your home address to verify who you are, and if your sales grow a lot we may ask you to get an e-Trader licence. If you already have a licence, mention it when you apply — it unlocks extra payout options as you grow."
   },
   {
    "q": "What does it cost?",
    "a": "Nothing to join — no monthly fee, no listing fee, no hidden costs. You decide each piece's price. When one sells, Trove buys it from you at 60% of that price — photography, marketing, delivery and customer care all included. If nothing sells, you pay nothing. You do stay responsible for your pieces being your own work, safe and as described (see the Seller Agreement)."
   },
   {
    "q": "How does delivery work?",
    "a": "You don't deliver anything. When a piece sells, our courier collects it from your door and takes it to the buyer — you just have it packed in your own packaging, ready to hand over. You can follow each order's journey in your dashboard."
   },
   {
    "q": "How and when do I get paid?",
    "a": "Every other Tuesday, to the bank account you add in your dashboard. A sale becomes payable once the piece is delivered and the buyer's 15-day return window has closed, so returns are settled before you are paid — in practice 16 to 29 days after delivery, depending on where the fortnight falls. Your Payments page shows exactly what's coming and when."
   },
   {
    "q": "What if I only make a few pieces a month?",
    "a": "Small-batch is the point of Trove. A shop with four lovely pieces is very welcome — and the application asks how many orders a month you're comfortable with, so you're never overwhelmed."
   },
   {
    "q": "Can I keep selling on Instagram or at markets?",
    "a": "Of course. Your Trove shop is another shelf for your work, not an exclusive deal — keep selling wherever your customers already find you."
   }
  ]
 },
 "sell.closing": {
  "eyebrow": "Ready when you are",
  "heading": "Give your craft a *shopfront*.",
  "text": "The application takes about ten minutes, and you can sign in and prepare your shop while a real person reviews it.",
  "cta": "Start your application"
 }
};
const DROPPED = {"sell.hero":["ctaHow"],"sell.offer":["eyebrow"]};
const TAGS = {
 "I've never sold online before — is that okay?": [
  "start",
  "pieces"
 ],
 "Do I need a trade licence?": [
  "start",
  "pieces"
 ],
 "How long does applying take, and who reviews it?": [
  "start",
  "all"
 ],
 "What if I only make a few pieces a month?": [
  "start",
  "pieces"
 ],
 "Do I need professional photos?": [
  "start",
  "pieces"
 ],
 "Can I keep selling on Instagram or at markets?": [
  "start",
  "pieces"
 ],
 "Can I sell pieces and offer services?": [
  "start",
  "all"
 ],
 "What does it cost?": [
  "money",
  "pieces"
 ],
 "How and when do I get paid?": [
  "money",
  "pieces"
 ],
 "What does listing services cost?": [
  "money",
  "services"
 ],
 "How do customers pay me?": [
  "money",
  "services"
 ],
 "How does delivery work?": [
  "delivery",
  "pieces"
 ],
 "How long do buyers wait?": [
  "delivery",
  "pieces"
 ],
 "What kind of services can I list?": [
  "services",
  "services"
 ],
 "Can I keep taking bookings elsewhere?": [
  "services",
  "services"
 ]
};
const ADD = [
 {
  "q": "How long does applying take, and who reviews it?",
  "a": "About ten minutes. A real person reads every application, usually within a day or two, and you can sign in and prepare everything while it's reviewed.",
  "topic": "start",
  "audience": "all"
 },
 {
  "q": "Can I sell pieces and offer services?",
  "a": "Yes. One account holds both: a shop for your pieces and a page for your services, reviewed together and run from one dashboard.",
  "topic": "start",
  "audience": "all"
 },
 {
  "q": "What does listing services cost?",
  "a": "Nothing during launch. A flat listing fee of AED 30 a month will start later; it will not start without at least 30 days' written notice, and you can stop listing before then without paying anything.",
  "topic": "money",
  "audience": "services"
 },
 {
  "q": "How do customers pay me?",
  "a": "The customer chooses. Paid directly, it is settled between you and them, by bank transfer or cash, and Trove takes nothing. Paid through Trove, they pay by card through a secure link; Trove keeps a 10% platform fee and pays you the other 90% by bank transfer to an account in your own name, after the service date.",
  "topic": "money",
  "audience": "services"
 },
 {
  "q": "What kind of services can I list?",
  "a": "Services you deliver in person at the customer's home — workshops, styling, photography, murals and the like. Pick one to three categories when you apply; rough ideas and rough prices are fine.",
  "topic": "services",
  "audience": "services"
 },
 {
  "q": "Can I keep taking bookings elsewhere?",
  "a": "Of course. Your Trove page is one more way for customers to find you, not an exclusive deal.",
  "topic": "services",
  "audience": "services"
 }
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = {
  id: '027-S-sell-paths',
  OLD, DROPPED, TAGS, ADD,
  up(db) {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='site_content'").get();
    if (!has) return;
    const get = db.prepare('SELECT value FROM site_content WHERE section=?');
    const update = db.prepare("UPDATE site_content SET value=?, updated_at=datetime('now') WHERE section=?");
    const remove = db.prepare('DELETE FROM site_content WHERE section=?');
    let touched = 0;
    for (const section of Object.keys(OLD)) {
      const row = get.get(section);
      if (!row) continue;
      let v;
      try { v = JSON.parse(row.value); } catch (_) { continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const before = JSON.stringify(v);
      for (const [k, old] of Object.entries(OLD[section])) if (k in v && same(v[k], old)) delete v[k];
      for (const k of DROPPED[section] || []) delete v[k];
      if (section === 'sell.faq' && Array.isArray(v.items)) {
        v.items = v.items.map((it) => {
          if (!it || typeof it !== 'object') return it;
          const [topic, audience] = TAGS[it.q] || ['start', 'pieces'];
          return { ...it, topic: it.topic || topic, audience: it.audience || audience };
        });
        const asked = new Set(v.items.map((it) => it && it.q));
        for (const it of ADD) if (!asked.has(it.q) && v.items.length < 20) v.items.push({ ...it });
      }
      if (JSON.stringify(v) === before) continue;
      if (Object.keys(v).length) update.run(JSON.stringify(v), section); else remove.run(section);
      touched += 1;
    }
    if (touched) console.log(`027-S: ${touched} saved sell-page content section(s) moved to the new page`);
  },
};
