// Every frame for Phase 1, v5 (20 Oct 2026): the series rebuilt after the 20 Oct creative review.
// Order: what Trove is (posts 1–3), then makers and providers get their own posts (4–8), money (9), a real
// founding maker (10) and the Collection tease (11). Buyers get their own posts in December.
// Rules for v5 covers: one headline of seven words or fewer, one short line, the offer along the bottom.
// Every cover shows hands at work or real work, or is a plain type card.
// 21 Oct 2026 (owner): the photo covers of posts 1, 2, 4, 7 and 8 use Higgsfield images (hands only, no faces,
// never named as a maker's work) until the shoot; each keeps its real shot as `upgrade`. Post 11 was already generated.
// 21 Oct 2026, later (owner: "every carousel needs to have an image"): the type cards became photo slides (pic) and
// the steps, lists and Q&As carry a photo strip (img). Owner, 21 Oct: 'missing images still - fix those as well', so the
// closing call-to-action cards got a photo (img) too, and the real-site phone screens sit on a full-bleed photo (img).
// Every carousel slide now carries an image. Prompts for every generated image are in photos/prompts.json.
// "Made here. Made home." is now a small sign-off on end cards only. Copy and captions live in posts.json.
// Square-bracketed text renders as a dashed placeholder box: fill it in before posting.
// photo: a file name in ./photos — rendered when present, otherwise a labelled "Real photo" slot.
// img: a file name in ./photos shown as a strip across the top of a steps, grid or Q&A slide.
// mood: true = a generated image. upgrade: the real shot that replaces a frame once it is taken.
// screen: a phone capture in ./screens (1170px wide); offset = CSS pixels to skip at the top (cuts the delivery bar).

const SIGN = 'Made here. Made home.';
const OFFER = 'Free to join · We photograph it · We collect it';
const OFFER_P = 'Free to list during launch · Bookings in one place';
const end = (post, id, title, body, extra = {}) => ({ post, id, kind: 'slide', bg: 'sage', layout: 'cta', title, body, sign: SIGN, ...extra });
const cover = (post, id, file, slot, caption, sub, foot, extra = {}) => ({ post, id, kind: 'slide', bg: 'cream', layout: 'photo', big: true, photo: file, slot, caption, sub, foot, ...extra });
// An inner photo slide: the picture above a band in the slide's colour, with the headline and one line
const pic = (post, id, file, band, caption, sub, foot, extra = {}) => ({ post, id, kind: 'slide', bg: band, band, layout: 'photo', photo: file, caption, sub, foot, mood: true, ...extra });
const phone = (post, id, screen, offset, title, sub, extra = {}) => ({ post, id, kind: 'slide', bg: 'clay', layout: 'phone', screen, offset, title, sub, ...extra });
const steps = (post, id, bg, title, list, extra = {}) => ({ post, id, kind: 'slide', bg, layout: 'steps', title, steps: list, ...extra });
const EXAMPLE = 'shop-example-full.png';

module.exports = [
  // 1. What Trove is (Carousel, 5) — pinned
  cover(1, '1', 'real-01-hands.jpg', 'Close-up of hands finishing a real piece (shot 1)',
    'Handmade in|Dubai and Abu Dhabi.', 'Trove is a new online marketplace for handmade pieces and creative services.', OFFER,
    { mood: true, upgrade: 'Real shot 1: hands finishing a real piece, close up' }),
  pic(1, '2', 'g-01-pieces.jpg', 'cream', 'Pieces,|made by hand.', 'Ceramics, candles, textiles, prints, jewellery and more, from makers who live here.', '', { size: 84 }),
  pic(1, '3', 'g-01-services.jpg', 'clay', 'Services,|at home.', 'Workshops, home styling and photography, from providers in Dubai and Abu Dhabi.', '', { size: 84 }),
  phone(1, '4', 'sell-full.png', 47, 'All on|troveathome.com', 'Makers and providers apply in about ten minutes.', { bg: 'sage', img: 'p-01-sell.jpg', mood: true }),
  end(1, '5', 'Make something?|Sell it on Trove.', 'Offer a service? List it. Buyers, the Marketplace opens soon.', { img: 'e-01.jpg', mood: true }),

  // 2. Why Trove exists (Reel, about 30 seconds, manifesto voiceover over real footage from the shoot)
  { post: 2, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'real-02-piece.jpg',
    slot: 'A real piece held in its maker’s two hands (shot 9)', kicker: '', title: 'We’d rather know|who made it.',
    sub: 'Pieces made with care, by people you can name.', mood: true, upgrade: 'Real shot 9: a real piece held in its maker’s two hands' },
  // 21 Oct 2026 (owner: "create a video post for each pillar"): the Reel is cut from Higgsfield clips (video/reels.js),
  // so the tags name the craft only. With real footage, add the maker's first name and area, only with their consent.
  { post: 2, id: 'hook', kind: 'reel', bg: 'clear', layout: 'reel-hook', title: 'We’d rather know|who made it.' },
  { post: 2, id: 'name-1', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'A cushion cover,|stitched in the evenings' },
  { post: 2, id: 'name-2', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'A chair,|brought back at the weekend' },
  { post: 2, id: 'name-3', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'The lettering on every|wedding card in the family' },
  { post: 2, id: 'line', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Trove: handmade pieces|and creative services|in Dubai and Abu Dhabi' },
  { post: 2, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Makers on Trove get|their own shop.', body: 'And their own story.', sign: SIGN, size: 96 },

  // 3. The three words (Carousel, 5) — pinned
  pic(3, '1', 'g-03-intro.jpg', 'sage', 'Makers. Providers. Buyers.', 'Here’s who Trove is for.', '', { size: 76 }),
  pic(3, '2', 'g-03-maker.jpg', 'cream', 'Makers', 'Make things by hand and sell them on Trove: ceramics, candles, textiles, prints, jewellery and more. Free to join.', OFFER, { size: 110 }),
  pic(3, '3', 'g-03-provider.jpg', 'clay', 'Providers', 'Offer a creative service people can book: workshops, home styling, photography and more. Free to list during launch.', OFFER_P, { size: 110 }),
  pic(3, '4', 'g-03-buyer.jpg', 'cream', 'Buyers', 'Anyone looking for something handmade, or a workshop to book. The Marketplace opens to buyers soon.', '', { size: 110 }),
  end(3, '5', 'Which one|are you?', 'Makers and providers, apply. Buyers, follow along.', { img: 'e-03.jpg', mood: true }),

  // 4. Makers (Carousel, 6)
  cover(4, '1', 'real-04-own-piece.jpg', 'A maker’s own hands holding their own piece (shot 9)',
    'Make things by hand?|You’re a maker.', 'Sell your handmade pieces on your own Trove shop page.', OFFER,
    { mood: true, upgrade: 'Real shot 9: a maker’s own hands holding their own piece' }),
  { post: 4, id: '2', kind: 'slide', bg: 'cream', layout: 'grid', title: 'What makers sell|on Trove', img: 'g-04-sell.jpg', mood: true,
    items: ['Ceramics', 'Candles', 'Cushions and throws', 'Prints', 'Jewellery', 'Stationery', 'Baby blankets', 'Wheat bags', 'Pet collars'] },
  phone(4, '3', EXAMPLE, 0, 'Your own|shop page.', 'Your name, your story, your pieces. This one is an example.', { label: 'Example', img: 'p-04-shop.jpg', mood: true }),
  steps(4, '4', 'cream', 'What happens next', ['Apply in about ten minutes', 'A real person reads it, usually within a day or two', 'We photograph your pieces, or you use your own', 'A courier collects each sale from your door'],
    { img: 'g-04-next.jpg', mood: true }),
  pic(4, '5', 'g-04-first.jpg', 'sage', 'Never sold anything?|That’s fine.', 'Four lovely pieces is a shop. You choose how many orders a month you can take.', '', { size: 80 }),
  end(4, '6', 'Sell what you make|on Trove.', 'Know a maker? Tag them.', { img: 'e-04.jpg', mood: true }),

  // 5. You make it. Trove sells it. (Carousel, 6)
  cover(5, '1', 'g-05-cover.jpg', '', 'You make it.|Trove sells it.', 'We photograph it, give it a shop and send a courier to your door.', OFFER,
    { mood: true, upgrade: 'Real shot 6: the photographer shooting a maker’s piece' }),
  steps(5, '2', 'cream', 'Your part', ['Make at your own pace', 'Set your own price', 'Choose how many orders a month', 'Pack each sale in your own packaging'],
    { img: 'g-05-yours.jpg', mood: true }),
  steps(5, '3', 'sage', 'Our part', ['Photograph your pieces, if you’d like', 'Give them a shop page', 'Look after the buyer and payment', 'Book a courier to your door'],
    { img: 'g-05-ours.jpg', mood: true, upgrade: 'Real shot 7: a parcel handed over at the door' }),
  phone(5, '4', EXAMPLE, 0, 'Your shop, with|your name on it.', 'An example shop page on troveathome.com.', { bg: 'sage', label: 'Example', img: 'p-05-shop.jpg', mood: true }),
  phone(5, '5', 'apply-top.png', 120, 'About ten minutes|to apply.', 'Have ready: photos of your work, a WhatsApp number and rough prices.', { bg: 'cream', img: 'p-05-apply.jpg', mood: true }),
  end(5, '6', 'Ready when|you are.', 'Know a maker? Tag them.', { img: 'e-05.jpg', mood: true }),

  // 6. Keep your stall. Add a Trove shop. (Carousel, 5) — established makers, Downtown Design week
  cover(6, '1', 'g-06-stall.jpg', '', 'Keep your stall.|Add a Trove shop.', 'Trove isn’t exclusive: keep your stall and your Instagram.', OFFER,
    { mood: true, upgrade: 'Collab photo: an established maker who has applied, at their own stall' }),
  phone(6, '2', EXAMPLE, 0, 'One more place|to find your work.', 'An example shop page. Founding makers get a badge and a spotlight.', { bg: 'cream', label: 'Example', img: 'p-06-shop.jpg', mood: true }),
  steps(6, '3', 'cream', 'What Trove handles', ['Product photos, if you’d like them', 'The buyer’s questions and payment', 'Booking the courier to your door', 'A spotlight for founding makers'],
    { img: 'g-06-handles.jpg', mood: true }),
  pic(6, '4', 'g-06-keep.jpg', 'sage', 'Keep all of it.', 'Your Instagram, your market days, your own customers. Trove is one more place people can find your work.', '', { size: 96 }),
  end(6, '5', 'One more home|for your work.', 'At Downtown Design this week? Say hello.', { img: 'e-06.jpg', mood: true }),

  // 7. Providers (Carousel, 5) — Diwali
  cover(7, '1', 'real-07-table.jpg', 'Hands placing the last detail on a styled table, diyas lit (shot 5)',
    'Style homes? Run workshops?|You’re a provider.', 'List your service on Trove, free during launch.', 'Workshops · Home styling · Photography',
    { size: 76, mood: true, upgrade: 'Real shot 5: hands placing the last detail on a styled table, diyas lit' }),
  { post: 7, id: '2', kind: 'slide', bg: 'cream', layout: 'grid', title: 'Services you can|list on Trove', img: 'g-07-services.jpg', mood: true,
    items: ['Workshops at home', 'Home styling', 'Tablescapes', 'Diwali and Christmas styling', 'Portraits at home', 'Photography for makers'],
    sub: 'And more: hand-lettering, repairs and gift wrapping.' },
  phone(7, '3', 'sell-services-top.png', 47, 'Your service gets|its own page.', 'Booking requests arrive in one dashboard.', { img: 'p-07-services.jpg', mood: true }),
  pic(7, '4', 'g-07-gift.jpg', 'cream', 'From December, your|service can be a gift.', 'People will be able to give a workshop, a styled table or a portrait session as a present.', '', { size: 76 }),
  end(7, '5', 'Your service,|on Trove.', 'Know a provider? Tag them.', { img: 'e-07.jpg', mood: true }),

  // 8. Providers: workshops (Carousel, 5)
  cover(8, '1', 'real-08-workshop.jpg', 'A real workshop mid-class at home, hands at work (shot 13)',
    'Run workshops?|Take bookings on Trove.', 'Your own service page, with booking requests in one place.', OFFER_P,
    { mood: true, upgrade: 'Real shot 13: a real workshop mid-class at home, hands at work' }),
  steps(8, '2', 'cream', 'How a booking works', ['Your workshop gets its own page', 'Someone requests a date', 'You confirm the date and final price', 'They pay you directly, or by card through Trove'],
    { img: 'g-08-booking.jpg', mood: true }),
  phone(8, '3', 'services-top.png', 47, 'On the Services|Marketplace.', 'Workshops, styling and photography, in homes in Dubai and Abu Dhabi.', { bg: 'sage', img: 'p-08-services.jpg', mood: true }),
  { post: 8, id: '4', kind: 'slide', bg: 'clay', layout: 'grid', title: 'Workshops people|book at home', img: 'g-08-workshops.jpg', mood: true,
    items: ['Pottery', 'Embroidery', 'Candle pouring', 'Calligraphy', 'Kids’ craft birthdays'] },
  end(8, '5', 'Your workshop,|on Trove.', 'Know someone who teaches? Tag them.', { img: 'e-08.jpg', mood: true }),

  // 9. What Trove costs, and what you keep. (Carousel, 8) — the one post about money
  cover(9, '1', 'g-09-cover.jpg', '', 'What Trove costs,|and what you keep.', 'Plain answers on money and paperwork, for makers and providers.', 'troveathome.com/apply', { mood: true }),
  ...[
    ['Do I need a company?', 'Not to start. Trove buys each piece and resells it. We check your Emirates ID and home address before your first payout, and may ask for an e-Trader licence if sales grow a lot.', 'g-09-company.jpg'],
    ['What does it cost me?', 'Nothing to join, and nothing to pay if nothing sells. You set the price and keep 60% when a piece sells.', 'g-09-cost.jpg'],
    ['When am I paid?', 'Every other Tuesday, by bank transfer, once the buyer’s 15-day return window has closed.', 'g-09-paid.jpg'],
    ['I offer a service. What do I pay?', 'Nothing during launch, then AED 30 a month, with 30 days’ notice. Paid directly by the customer, you keep 100%. Paid by card through Trove, you keep 90%.', 'g-09-service.jpg'],
    ['How much do I need to start?', 'Four lovely pieces is a shop. You choose how many orders a month you can take, and pack them in your own packaging.', 'g-09-start.jpg'],
  ].map(([q, a, img], i) => ({ post: 9, id: String(i + 2), kind: 'slide', bg: i % 2 ? 'clay' : 'cream', layout: 'qa', q, a, img, mood: true })),
  steps(9, '7', 'cream', 'After you press Apply', ['A real person reads it, usually within a day or two', 'Add your story, pieces and prices', 'Photos by us, or by you', 'A courier collects each sale from your door'],
    { img: 'g-09-apply.jpg', mood: true }),
  end(9, '8', 'Have a wander.|There’s no rush.', 'Ask us anything below.', { img: 'e-09.jpg', mood: true }),

  // 10. Meet [Name] (Collab Reel, face to camera) — only with a real founding maker; back-up slides below
  { post: 10, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'real-10-maker.jpg',
    slot: 'The founding maker at work, their hands and piece in frame', kicker: 'Meet a founding maker', title: 'Meet [Name].', sub: '[Craft], made in [area].' },
  { post: 10, id: 'words', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '“[Their own words]”' },
  { post: 10, id: 'craft', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '[Craft] at home in [area], since [year].' },
  { post: 10, id: 'shop', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Now [Name] has a shop on Trove.' },
  { post: 10, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Know someone|like [Name]?', body: 'Tag them.', sign: SIGN },
  pic(10, 'alt-1', 'g-10-after.jpg', 'cream', 'What happens|after you apply.', 'From your application to your own shop page, step by step.', '', { size: 96,
    note: 'Back-up: runs instead of the Reel if no founding maker is ready by 14 Nov' }),
  steps(10, 'alt-2', 'sage', 'After you press Apply', ['A real person reads it, usually within a day or two', 'We photograph your pieces, or you use your own', 'Your shop page goes live', 'A courier collects each sale from your door'],
    { img: 'g-10-steps.jpg', mood: true }),

  // 11. Something of our own. (Carousel, 3) — Trove Collection tease
  cover(11, '1', 'c9-drape.jpg', '', 'Something of|our own.', 'The Trove Collection, our own range. Coming next year.', 'troveathome.com',
    { mood: true, upgrade: 'A real material swatch or sketch from the Collection work' }),
  pic(11, '2', 'g-11-materials.jpg', 'clay', 'The Collection is ours.|The Marketplace is yours.', 'Both on troveathome.com. Ours comes next year. Yours starts with an application.', '', { size: 72 }),
  end(11, '3', 'While we make ours,|we’re looking for yours.', 'Ceramics, candles, textiles, prints and more, made by hand.', { size: 96, img: 'e-11.jpg', mood: true }),

  // 12–14. One Reel per pillar (owner, 21 Oct 2026: "create a video post for each pillar"). Post 2 is the Trove Reel;
  // these are the makers, providers and buyers Reels, cut from Higgsfield clips by video/build.js (shots in video/reels.js).
  // 12. Makers (Reel)
  { post: 12, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'g-04-first.jpg', mood: true,
    slot: 'A maker’s hands at work on a real piece', title: 'From your hands|to your own shop.', sub: 'Sell your handmade pieces on Trove.|Free to join.', size: 92,
    upgrade: 'Real footage from the shoot: a maker’s hands at work' },
  { post: 12, id: 'hook', kind: 'reel', bg: 'clear', layout: 'reel-hook', title: 'Make things|by hand?' },
  { post: 12, id: 'l-1', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'You’re a maker' },
  { post: 12, id: 'l-2', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Sell your pieces|on your own Trove shop' },
  { post: 12, id: 'l-3', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'We photograph them,|or you use your own' },
  { post: 12, id: 'l-4', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'A courier collects|from your door' },
  { post: 12, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Make something?|Sell it on Trove.', body: 'Free to join.|We photograph it. We collect it.', sign: SIGN, size: 104 },

  // 13. Providers (Reel)
  { post: 13, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'g-03-provider.jpg', mood: true,
    slot: 'A provider at work in someone’s home', title: 'Get booked for|what you do best.', sub: 'List your service on Trove.|Free during launch.', size: 92,
    upgrade: 'Real footage from the shoot: a provider at work in a home' },
  { post: 13, id: 'hook', kind: 'reel', bg: 'clear', layout: 'reel-hook', title: 'Style homes?' },
  { post: 13, id: 'l-1', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Run workshops at home?' },
  { post: 13, id: 'l-2', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Set the table for Eid or Diwali?' },
  { post: 13, id: 'l-3', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Take photos at home?' },
  { post: 13, id: 'l-4', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'You’re a provider' },
  { post: 13, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Offer a service?|List it on Trove.', body: 'Free to list during launch.|Bookings in one place.', sign: SIGN, size: 104 },

  // 14. Buyers (Reel, December: only once the Marketplace is open to buyers)
  { post: 14, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'g-03-buyer.jpg', mood: true,
    slot: 'Hands unpacking a real handmade piece at home', title: 'Handmade, by people|who live here.', sub: 'Pieces and creative services|from Dubai and Abu Dhabi.', size: 92,
    upgrade: 'Real footage: a buyer unpacking a real maker’s piece, with the maker’s consent' },
  { post: 14, id: 'hook', kind: 'reel', bg: 'clear', layout: 'reel-hook', title: 'Handmade,|by people|who live here.' },
  { post: 14, id: 'l-1', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Pieces for home, from makers|in Dubai and Abu Dhabi' },
  { post: 14, id: 'l-2', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Workshops you can book at home' },
  { post: 14, id: 'l-3', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Or give one as a gift' },
  { post: 14, id: 'l-4', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Ceramics, candles, textiles,|prints and more' },
  { post: 14, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Have a wander.|There’s no rush.', body: 'Handmade pieces and creative services.', sign: SIGN, size: 104,
    lead: 'Shop at', pill: 'troveathome.com' },
];
