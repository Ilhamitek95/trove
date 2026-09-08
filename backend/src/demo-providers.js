'use strict';
/**
 * Demo service providers — the Services Marketplace equivalent of the seeded
 * demo shops, so the provider dashboard, the admin queue and the public
 * directory all have something to show before real providers sign up.
 *
 * `ensureDemoProviders(db)` is idempotent and keyed on the provider slug: it
 * creates whatever is missing and never touches a provider that exists (so a
 * demo account the owner has edited keeps its edits). It runs from the local
 * seed AND at boot on the live site (prod never reseeds), which is why it
 * lives here rather than in seed.js. The accounts are listed in server.js's
 * DEMO_EMAILS so DEMO_PASSWORD rotates them on a public deployment; locally
 * they sign in with the usual demo1234.
 *
 * Mara (Kiln & Clay) is the "one account, shop + services" story from the
 * services FAQ: her existing seller account gains a provider profile.
 */
const c = (aed) => Math.round(aed * 100);

const DEMO_PROVIDERS = [
  {
    email: 'mara@kilnandclay.com', userName: 'Mara',
    name: 'Kiln & Clay Workshops', slug: 'kiln-and-clay-workshops',
    location: 'Al Quoz, Dubai', color: '#DBC7BD', categories: ['workshops', 'care-repair'],
    bio: 'Mara runs the Kiln & Clay studio in Al Quoz and brings the wheel-free side of it to your home: hand-building afternoons for friends, clay birthdays for little ones, and careful repair of the pieces you already love.',
    experience: '8 years', instagram: 'instagram.com/kilnandclay',
    services: [
      { title: 'Hand-building afternoon at home', category: 'workshops', price: 1200, type: 'fixed', duration: '3 hours · up to 8 people', setting: 'home',
        description: 'Clay, tools, aprons and a firing run back at the studio are all included. Everyone makes two pieces — a pinch pot and a slab dish — which come back glazed about two weeks later.' },
      { title: "Kids' clay birthday party", category: 'workshops', price: 950, type: 'from', duration: '2 hours · up to 10 children', setting: 'home',
        description: 'A messy, happy two hours: each child makes a creature and a little dish, both fired and glazed and delivered back to you. Price covers ten children; larger parties by arrangement.' },
      { title: 'Ceramic repair & kintsugi', category: 'care-repair', price: 180, type: 'from', duration: '2–3 weeks turnaround', setting: 'studio',
        description: 'Chips, clean breaks and hairline cracks mended at the studio — invisibly, or with gold-seam kintsugi if you would rather celebrate the repair. Send a photo with your request for a firm quote.' },
    ],
  },
  {
    email: 'noor@noorletters.ae', userName: 'Noor Al Sayegh',
    name: 'Noor Letters', slug: 'noor-letters',
    location: 'Jumeirah, Dubai', color: '#F8D7E4', categories: ['made-to-order', 'live-entertainment'],
    bio: 'Hand-lettering and calligraphy in Arabic and English — envelopes and place cards for the table, names on nursery walls, and live lettering at the door of your event.',
    experience: '6 years', instagram: 'instagram.com/noorletters',
    services: [
      { title: 'Live event lettering', category: 'made-to-order', price: 350, type: 'hourly', duration: 'Minimum 2 hours', setting: 'home',
        description: 'A lettering table at your event: guests leave with a name, a phrase or a favour tag written by hand in Arabic or English. Cards, ribbon and inks included.' },
      { title: 'Envelope & place-card calligraphy', category: 'made-to-order', price: 15, type: 'from', duration: 'Allow 5 working days', setting: 'studio',
        description: 'Per piece, written at the studio and delivered or collected. Ivory, kraft and coloured stock available; Arabic, English or both on one card.' },
      { title: 'Nursery name mural', category: 'made-to-order', price: 900, type: 'from', duration: 'One day on site', setting: 'home',
        description: 'A child’s name, a short verse or a line of a lullaby painted straight onto the wall. We agree the design and colours first from a photo of the room.' },
      { title: 'Arabic–English wedding signage', category: 'made-to-order', price: 650, type: 'from', duration: '2 weeks', setting: 'studio',
        description: 'Welcome boards, seating charts and menu cards lettered by hand in both languages, on acrylic, board or mirror.' },
    ],
  },
  {
    email: 'hello@thehangstudio.ae', userName: 'Tariq Haddad',
    name: 'The Hang Studio', slug: 'the-hang-studio',
    location: 'Khalifa City, Abu Dhabi', color: '#CAD5CC', categories: ['care-repair', 'styling-celebrations'],
    bio: 'Gallery walls hung properly, tired furniture given a second life, and curtains made to the millimetre. Tariq trained as a picture framer and still cannot walk past a crooked frame.',
    experience: '12 years', instagram: 'instagram.com/thehangstudio',
    services: [
      { title: 'Gallery wall hang & curation', category: 'care-repair', price: 450, type: 'fixed', duration: 'Half a day', setting: 'home',
        description: 'Up to twelve pieces laid out, levelled and hung with the right fixings for your wall. Bring the art; we bring the ladder, the laser and the patience.' },
      { title: 'Chalk-paint furniture makeover', category: 'care-repair', price: 600, type: 'from', duration: 'About a week', setting: 'studio',
        description: 'A chest, a chair or a side table collected, sanded, painted and waxed at the workshop, then brought back. Colour matched to a swatch or a photo.' },
      { title: 'Curtains made to measure', category: 'care-repair', price: 350, type: 'from', duration: 'Measure visit + 10 days', setting: 'home',
        description: 'Per window, lined and hand-finished. We measure at your place, you choose the fabric from our books or supply your own, and we fit them when they are ready.' },
      { title: 'Shelf & mantel styling consult', category: 'styling-celebrations', price: 500, type: 'fixed', duration: '2 hours', setting: 'home',
        description: 'Two hours rearranging what you already own — shelves, consoles and mantels — with a short list of the one or two pieces that would finish each one.' },
    ],
  },
  {
    email: 'amal@amalstudio.ae', userName: 'Amal Rashid',
    name: 'Amal Studio', slug: 'amal-studio',
    location: 'Downtown, Dubai', color: '#BED3DF', categories: ['portraits-photography', 'content-visuals'],
    bio: 'Natural-light photography with nothing staged: families and newborns at home, and product and behind-the-making stories for the makers on Trove.',
    experience: '9 years', instagram: 'instagram.com/amalstudio.ae',
    services: [
      { title: 'Family shoot at home', category: 'portraits-photography', price: 1400, type: 'fixed', duration: '90 minutes · 40 edited photos', setting: 'home',
        description: 'Ninety unhurried minutes at your place — breakfast, the garden, the sofa everyone piles onto. Forty edited photos in an online gallery within ten days.' },
      { title: 'Newborn session at home', category: 'portraits-photography', price: 1600, type: 'fixed', duration: '2–3 hours, baby-led', setting: 'home',
        description: 'Baby sets the pace; we work around feeds and naps. Parents and siblings included, no props you would not have in the house anyway.' },
      { title: 'Product & flat-lay shoot', category: 'content-visuals', price: 900, type: 'from', duration: 'Half a day · 25 finished images', setting: 'home',
        description: 'At your studio or kitchen table: clean cut-outs for the listing, styled flat-lays for the feed. Price covers up to eight pieces; more by arrangement.' },
      { title: 'Reels & behind-the-making video', category: 'content-visuals', price: 450, type: 'hourly', duration: 'Minimum 2 hours', setting: 'home',
        description: 'Short vertical films of you at work, cut to length for Instagram and TikTok and delivered with captions in English and Arabic.' },
    ],
  },
  {
    email: 'hala@saduandco.ae', userName: 'Hala Mansour',
    name: 'Sadu & Co. Brand Studio', slug: 'sadu-and-co',
    location: 'Al Reem Island, Abu Dhabi', color: '#FCC998', categories: ['brand-design', 'words-both-languages', 'social-growth'],
    bio: 'A two-person brand studio for small makers: identities, packaging and the words to go with them, in English and Arabic, priced for a first collection rather than a corporation.',
    experience: '7 years', instagram: 'instagram.com/saduandco',
    services: [
      { title: 'Logo & identity', category: 'brand-design', price: 3500, type: 'from', duration: '3–4 weeks', setting: 'remote',
        description: 'Wordmark, symbol, colour and type, with the files you actually need — for labels, for the website, for a market-stall banner. Two rounds of revisions.' },
      { title: 'Packaging, labels & care cards', category: 'brand-design', price: 1500, type: 'from', duration: '2 weeks', setting: 'remote',
        description: 'Print-ready artwork for boxes, labels, hang tags and care cards, with printer recommendations in Dubai and Abu Dhabi.' },
      { title: 'English–Arabic captions, monthly', category: 'words-both-languages', price: 900, type: 'fixed', duration: 'Per month · 12 posts', setting: 'remote',
        description: 'Twelve captions a month written in both languages from your photos and voice notes, ready to paste. Product descriptions and bios quoted separately.' },
      { title: 'Instagram setup & content calendar', category: 'social-growth', price: 1200, type: 'fixed', duration: 'One week', setting: 'remote',
        description: 'Profile, highlights and a bilingual bio set up properly, plus a four-week calendar you can keep running yourself.' },
    ],
  },
  {
    email: 'rania@firsthundred.ae', userName: 'Rania Haddad',
    name: 'First Hundred', slug: 'first-hundred',
    location: 'Business Bay, Dubai', color: '#CFDBBE', categories: ['coaching', 'selling-support'],
    bio: 'Rania grew a home candle brand into a stockist in three malls before selling it. Now she helps makers get to their first hundred sales without guessing at prices or wholesale.',
    experience: '10 years', instagram: 'instagram.com/firsthundred.ae',
    services: [
      { title: '“First 100 sales” coaching', category: 'coaching', price: 300, type: 'hourly', duration: 'Weekly or fortnightly', setting: 'remote',
        description: 'One-to-one calls with homework: where your buyers are, what to say to them, and what to stop doing. Most makers need four to six sessions.' },
      { title: 'Pricing & margin review', category: 'selling-support', price: 450, type: 'fixed', duration: '90 minutes + written notes', setting: 'remote',
        description: 'Your costs, your time and your competitors on one sheet, and a price list that leaves room for Trove’s commission, wholesale and a sale.' },
      { title: 'Online-shop setup', category: 'selling-support', price: 2000, type: 'from', duration: '2 weeks', setting: 'remote',
        description: 'Domain, email, shop, payment and delivery settings done and handed over with a short screen-recorded walkthrough.' },
      { title: 'Wholesale deck & gifting outreach', category: 'selling-support', price: 1200, type: 'from', duration: '2 weeks', setting: 'remote',
        description: 'A line sheet and a short deck, plus a list of twenty stockists or corporate-gifting buyers in the UAE and the first email to send them.' },
    ],
  },
  // Still in the admin queue, so the Providers tab has an application to review.
  {
    email: 'khalid@oudbykhalid.ae', userName: 'Khalid Al Amiri',
    name: 'Oud by Khalid', slug: 'oud-by-khalid', status: 'pending',
    location: 'Mirdif, Dubai', color: '#DBC7BD', categories: ['live-entertainment'],
    bio: 'Oud and acoustic guitar for majlis evenings, engagements and dinners — classical maqams, Khaleeji favourites and the odd Beatles song by request.',
    experience: '15 years', instagram: 'instagram.com/oudbykhalid',
    services: [
      { title: 'Oud & acoustic evening set', category: 'live-entertainment', price: 1500, type: 'from', duration: '2 × 45-minute sets', setting: 'home',
        description: 'Solo oud, or a duo with percussion, for up to sixty guests. Bring the tea; the music comes with its own amplification.' },
    ],
  },
];

// Booking requests so the provider dashboard's tabs are not empty. Layla is
// the seeded demo buyer; if she is missing the booking is a guest request.
const DEMO_BOOKINGS = [
  { code: 'SRV-DEMO01', provider: 'kiln-and-clay-workshops', service: 'Hand-building afternoon at home', status: 'requested',
    area: 'Dubai', preferredDate: 'A Saturday afternoon in October', notes: 'Six of us — a birthday for my sister. Total beginners, so please be kind.' },
  { code: 'SRV-DEMO02', provider: 'kiln-and-clay-workshops', service: 'Ceramic repair & kintsugi', status: 'confirmed',
    area: 'Dubai', preferredDate: 'Whenever suits', notes: 'A chipped serving bowl that was my grandmother’s. Gold seam, please.' },
  { code: 'SRV-DEMO03', provider: 'noor-letters', service: 'Nursery name mural', status: 'requested',
    area: 'Abu Dhabi', preferredDate: 'Before 20 November', notes: 'The name is Areli, on a pale sage wall above the cot. Photo to follow.' },
];

const DEMO_PROVIDER_EMAILS = DEMO_PROVIDERS.map((p) => p.email);

/** Creates whatever is missing; returns how many providers were created. */
function ensureDemoProviders(db) {
  const { hashPassword } = require('./middleware');
  const pw = hashPassword('demo1234');
  let created = 0;
  const run = db.transaction(() => {
    for (const d of DEMO_PROVIDERS) {
      if (db.prepare('SELECT 1 FROM service_providers WHERE slug = ?').get(d.slug)) continue;
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(d.email);
      const userId = user ? user.id
        : db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)').run(d.email, pw, d.userName, 'buyer').lastInsertRowid;
      // An account can hold one provider profile; if this one already has one
      // under another slug (the owner renamed it), leave it alone.
      if (db.prepare('SELECT 1 FROM service_providers WHERE user_id = ?').get(userId)) continue;
      const status = d.status || 'approved';
      const pid = db.prepare(`INSERT INTO service_providers
          (user_id, name, slug, status, bio, location, categories, color,
           pitch_services, pitch_experience, pitch_instagram, pitch_links, pitch_phone,
           sub_agreed_at, sub_started_at, agreement_version, agreement_accepted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), ${status === 'approved' ? "datetime('now')" : 'NULL'}, ?, datetime('now'))`)
        .run(userId, d.name, d.slug, status, d.bio, d.location, JSON.stringify(d.categories), d.color,
          d.services.map((s) => s.title).join('; '), d.experience, d.instagram, '', '+971 50 000 0000',
          require('./config').PROVIDER_AGREEMENT_VERSION)
        .lastInsertRowid;
      const ins = db.prepare(`INSERT INTO services
          (provider_id, title, category, description, price_cents, price_type, duration, setting, status)
        VALUES (?,?,?,?,?,?,?,?,'live')`);
      for (const s of d.services) ins.run(pid, s.title, s.category, s.description, c(s.price), s.type, s.duration, s.setting);
      created++;
    }
    // Demo profiles created before the Provider Agreement existed: stamp the
    // current version so the dashboards show a realistic acceptance line.
    db.prepare(`UPDATE service_providers SET agreement_version=?, agreement_accepted_at=datetime('now')
      WHERE (agreement_version IS NULL OR agreement_version='') AND slug IN (${DEMO_PROVIDERS.map(() => '?').join(',')})`)
      .run(require('./config').PROVIDER_AGREEMENT_VERSION, ...DEMO_PROVIDERS.map((d) => d.slug));
    const layla = db.prepare("SELECT id FROM users WHERE email = 'layla@email.com'").get();
    for (const b of DEMO_BOOKINGS) {
      if (db.prepare('SELECT 1 FROM service_bookings WHERE code = ?').get(b.code)) continue;
      const sv = db.prepare(`SELECT sv.* FROM services sv JOIN service_providers p ON p.id = sv.provider_id
        WHERE p.slug = ? AND sv.title = ?`).get(b.provider, b.service);
      if (!sv) continue;
      db.prepare(`INSERT INTO service_bookings
          (code, service_id, provider_id, buyer_id, name, email, phone, area, preferred_date, notes,
           payment_method, title, price_cents, price_type, status, confirmed_at, terms_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,'direct',?,?,?,?, ${b.status === 'confirmed' ? "datetime('now')" : 'NULL'}, ?)`)
        .run(b.code, sv.id, sv.provider_id, layla ? layla.id : null, 'Layla Hassan', 'layla@email.com', '+971501234567',
          b.area, b.preferredDate, b.notes, sv.title, sv.price_cents, sv.price_type, b.status,
          require('./config').SERVICES_TERMS_VERSION);
    }
  });
  run();
  return created;
}

module.exports = { DEMO_PROVIDERS, DEMO_BOOKINGS, DEMO_PROVIDER_EMAILS, ensureDemoProviders };
