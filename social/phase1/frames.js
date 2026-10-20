// Every frame for Phase 1, v5 (20 Oct 2026): the series rebuilt after the 20 Oct creative review.
// Order: what Trove is (posts 1–3), then makers and providers get their own posts (4–8), money (9), a real
// founding maker (10) and the Collection tease (11). Buyers get their own posts in December.
// Rules for v5 covers: one headline of seven words or fewer, one short line, the offer along the bottom.
// Every cover shows real hands or real work (a labelled photo slot until the shoot), or is a plain type card.
// The only generated image left is the Collection tease (post 11), which the brief allows.
// "Made here. Made home." is now a small sign-off on end cards only. Copy and captions live in posts.json.
// Square-bracketed text renders as a dashed placeholder box: fill it in before posting.
// photo: a file name in ./photos — rendered when present, otherwise a labelled "Real photo" slot.
// mood: true = a generated mood image. upgrade: the real shot that replaces a frame once it is taken.
// screen: a phone capture in ./screens (1170px wide); offset = CSS pixels to skip at the top (cuts the delivery bar).

const SIGN = 'Made here. Made home.';
const OFFER = 'Free to join · We photograph it · We collect it';
const OFFER_P = 'Free to list during launch · Bookings in one place';
const end = (post, id, title, body, extra = {}) => ({ post, id, kind: 'slide', bg: 'sage', layout: 'cta', title, body, sign: SIGN, ...extra });
const type = (post, id, bg, title, body, extra = {}) => ({ post, id, kind: 'slide', bg, layout: 'type', title, body, ...extra });
const cover = (post, id, file, slot, caption, sub, foot, extra = {}) => ({ post, id, kind: 'slide', bg: 'cream', layout: 'photo', big: true, photo: file, slot, caption, sub, foot, ...extra });
const phone = (post, id, screen, offset, title, sub, extra = {}) => ({ post, id, kind: 'slide', bg: 'clay', layout: 'phone', screen, offset, title, sub, ...extra });
const steps = (post, id, bg, title, list) => ({ post, id, kind: 'slide', bg, layout: 'steps', title, steps: list });
const EXAMPLE = 'shop-example-full.png';

module.exports = [
  // 1. What Trove is (Carousel, 5) — pinned
  cover(1, '1', 'real-01-hands.jpg', 'Close-up of hands finishing a real piece (shot 1)',
    'Handmade in|Dubai and Abu Dhabi.', 'Trove is a new online marketplace for handmade pieces and creative services.', OFFER),
  type(1, '2', 'cream', 'Pieces,|made by hand.', 'Ceramics, candles, textiles, prints, jewellery and more, from makers who live here.'),
  type(1, '3', 'clay', 'Services,|at home.', 'Workshops, home styling and photography, from providers in Dubai and Abu Dhabi.'),
  phone(1, '4', 'sell-full.png', 47, 'All on|troveathome.com', 'Makers and providers apply in about ten minutes.', { bg: 'sage' }),
  end(1, '5', 'Make something?|Sell it on Trove.', 'Offer a service? List it. Buyers, the Marketplace opens soon.'),

  // 2. Why Trove exists (Reel, about 30 seconds, manifesto voiceover over real footage from the shoot)
  { post: 2, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'real-02-piece.jpg',
    slot: 'A real piece held in its maker’s two hands (shot 9)', kicker: '', title: 'We’d rather know|who made it.',
    sub: 'Pieces made with care, by people you can name.' },
  { post: 2, id: 'name-1', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Cushion cover · [Name], [area]' },
  { post: 2, id: 'name-2', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Wedding-card lettering · [Name], [area]' },
  { post: 2, id: 'name-3', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'A chair, brought back · [Name], [area]' },
  { post: 2, id: 'line', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Trove: handmade pieces and creative services' },
  { post: 2, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Makers on Trove get|their own shop.', body: 'And their own story.', sign: SIGN, size: 96 },

  // 3. The three words (Carousel, 5, type only) — pinned
  type(3, '1', 'sage', 'Makers.|Providers.|Buyers.', 'Here’s who Trove is for.', { size: 156 }),
  type(3, '2', 'cream', 'Makers', 'Make things by hand and sell them on Trove: ceramics, candles, textiles, prints, jewellery and more. Free to join.', { size: 200, foot: OFFER }),
  type(3, '3', 'clay', 'Providers', 'Offer a creative service people can book: workshops, home styling, photography and more. Free to list during launch.', { size: 200, foot: OFFER_P }),
  type(3, '4', 'cream', 'Buyers', 'Anyone looking for something handmade, or a workshop to book. The Marketplace opens to buyers soon.', { size: 200 }),
  end(3, '5', 'Which one|are you?', 'Makers and providers, apply. Buyers, follow along.'),

  // 4. Makers (Carousel, 6)
  cover(4, '1', 'real-04-own-piece.jpg', 'A maker’s own hands holding their own piece (shot 9)',
    'Make things by hand?|You’re a maker.', 'Sell your handmade pieces on your own Trove shop page.', OFFER),
  { post: 4, id: '2', kind: 'slide', bg: 'cream', layout: 'grid', title: 'What makers sell|on Trove',
    items: ['Ceramics', 'Candles', 'Cushions and throws', 'Prints', 'Jewellery', 'Stationery', 'Baby blankets', 'Wheat bags', 'Pet collars'] },
  phone(4, '3', EXAMPLE, 0, 'Your own|shop page.', 'Your name, your story, your pieces. This one is an example.', { label: 'Example' }),
  steps(4, '4', 'cream', 'What happens next', ['Apply in about ten minutes', 'A real person reads it, usually within a day or two', 'We photograph your pieces, or you use your own', 'A courier collects each sale from your door']),
  type(4, '5', 'sage', 'Never sold|anything?|That’s fine.', 'Four lovely pieces is a shop. You choose how many orders a month you can take.', { size: 120 }),
  end(4, '6', 'Sell what you make|on Trove.', 'Know a maker? Tag them.'),

  // 5. You make it. Trove sells it. (Carousel, 6) — the real site, step by step
  phone(5, '1', 'sell-full.png', 47, 'You make it.|Trove sells it.', 'We photograph it, give it a shop and send a courier to your door.'),
  steps(5, '2', 'cream', 'Your part', ['Make at your own pace', 'Set your own price', 'Choose how many orders a month', 'Pack each sale in your own packaging']),
  steps(5, '3', 'sage', 'Our part', ['Photograph your pieces, if you’d like', 'Give them a shop page', 'Look after the buyer and payment', 'Book a courier to your door']),
  phone(5, '4', EXAMPLE, 0, 'Your shop, with|your name on it.', 'An example shop page on troveathome.com.', { bg: 'sage', label: 'Example',
    upgrade: 'After the shoot, add two real slides: the photographer shooting a piece (shot 6) and a parcel at the door (shot 7)' }),
  phone(5, '5', 'apply-top.png', 120, 'About ten minutes|to apply.', 'Have ready: photos of your work, a WhatsApp number and rough prices.', { bg: 'cream' }),
  end(5, '6', 'Ready when|you are.', 'Know a maker? Tag them.'),

  // 6. Keep your stall. Add a Trove shop. (Carousel, 5) — established makers, Downtown Design week
  type(6, '1', 'clay', 'Keep your stall.|Add a Trove shop.', 'Trove isn’t exclusive: keep your stall and your Instagram.', { foot: OFFER,
    upgrade: 'Collab photo: an established maker who has applied, at their own stall' }),
  phone(6, '2', EXAMPLE, 0, 'One more place|to find your work.', 'An example shop page. Founding makers get a badge and a spotlight.', { bg: 'cream', label: 'Example' }),
  steps(6, '3', 'cream', 'What Trove handles', ['Product photos, if you’d like them', 'The buyer’s questions and payment', 'Booking the courier to your door', 'A spotlight for founding makers']),
  type(6, '4', 'sage', 'Keep all of it.', 'Your Instagram, your market days, your own customers. Trove is one more place people can find your work.', { size: 120 }),
  end(6, '5', 'One more home|for your work.', 'At Downtown Design this week? Say hello.'),

  // 7. Providers (Carousel, 5) — Diwali
  cover(7, '1', 'real-07-table.jpg', 'Hands placing the last detail on a styled table, diyas lit (shot 5)',
    'Style homes? Run workshops?|You’re a provider.', 'List your service on Trove, free during launch.', 'Workshops · Home styling · Photography', { size: 76 }),
  { post: 7, id: '2', kind: 'slide', bg: 'cream', layout: 'grid', title: 'Services you can|list on Trove',
    items: ['Workshops at home', 'Home styling', 'Tablescapes', 'Diwali and Christmas styling', 'Portraits at home', 'Photography for makers'],
    sub: 'And more: hand-lettering, repairs and gift wrapping.' },
  phone(7, '3', 'sell-services-top.png', 47, 'Your service gets|its own page.', 'Booking requests arrive in one dashboard.'),
  type(7, '4', 'cream', 'From December,|your service|can be a gift.', 'People will be able to give a workshop, a styled table or a portrait session as a present.', { size: 110 }),
  end(7, '5', 'Your service,|on Trove.', 'Know a provider? Tag them.'),

  // 8. Providers: workshops (Carousel, 5)
  cover(8, '1', 'real-08-workshop.jpg', 'A real workshop mid-class at home, hands at work (shot 13)',
    'Run workshops?|Take bookings on Trove.', 'Your own service page, with booking requests in one place.', OFFER_P),
  steps(8, '2', 'cream', 'How a booking works', ['Your workshop gets its own page', 'Someone requests a date', 'You confirm the date and final price', 'They pay you directly, or by card through Trove']),
  phone(8, '3', 'services-top.png', 47, 'On the Services|Marketplace.', 'Workshops, styling and photography, in homes in Dubai and Abu Dhabi.', { bg: 'sage' }),
  { post: 8, id: '4', kind: 'slide', bg: 'clay', layout: 'grid', title: 'Workshops people|book at home',
    items: ['Pottery', 'Embroidery', 'Candle pouring', 'Calligraphy', 'Kids’ craft birthdays'] },
  end(8, '5', 'Your workshop,|on Trove.', 'Know someone who teaches? Tag them.'),

  // 9. What Trove costs, and what you keep. (Carousel, 8) — the one post about money
  type(9, '1', 'sage', 'What Trove costs,|and what you keep.', 'Plain answers on money and paperwork, for makers and providers.', { size: 112, foot: 'troveathome.com/apply' }),
  ...[
    ['Do I need a company?', 'Not to start. Trove buys each piece and resells it. We check your Emirates ID and home address before your first payout, and may ask for an e-Trader licence if sales grow a lot.'],
    ['What does it cost me?', 'Nothing to join, and nothing to pay if nothing sells. You set the price and keep 60% when a piece sells.'],
    ['When am I paid?', 'Every other Tuesday, by bank transfer, once the buyer’s 15-day return window has closed.'],
    ['I offer a service. What do I pay?', 'Nothing during launch, then AED 30 a month, with 30 days’ notice. Paid directly by the customer, you keep 100%. Paid by card through Trove, you keep 90%.'],
    ['How much do I need to start?', 'Four lovely pieces is a shop. You choose how many orders a month you can take, and pack them in your own packaging.'],
  ].map(([q, a], i) => ({ post: 9, id: String(i + 2), kind: 'slide', bg: i % 2 ? 'clay' : 'cream', layout: 'qa', q, a })),
  steps(9, '7', 'cream', 'After you press Apply', ['A real person reads it, usually within a day or two', 'Add your story, pieces and prices', 'Photos by us, or by you', 'A courier collects each sale from your door']),
  end(9, '8', 'Have a wander.|There’s no rush.', 'Ask us anything below.'),

  // 10. Meet [Name] (Collab Reel, face to camera) — only with a real founding maker; back-up slides below
  { post: 10, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'real-10-maker.jpg',
    slot: 'The founding maker at work, their hands and piece in frame', kicker: 'Meet a founding maker', title: 'Meet [Name].', sub: '[Craft], made in [area].' },
  { post: 10, id: 'words', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '“[Their own words]”' },
  { post: 10, id: 'craft', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '[Craft] at home in [area], since [year].' },
  { post: 10, id: 'shop', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Now [Name] has a shop on Trove.' },
  { post: 10, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Know someone|like [Name]?', body: 'Tag them.', sign: SIGN },
  type(10, 'alt-1', 'cream', 'What happens|after you apply.', 'From your application to your own shop page, step by step.', { size: 120,
    note: 'Back-up: runs instead of the Reel if no founding maker is ready by 14 Nov' }),
  steps(10, 'alt-2', 'sage', 'After you press Apply', ['A real person reads it, usually within a day or two', 'We photograph your pieces, or you use your own', 'Your shop page goes live', 'A courier collects each sale from your door']),

  // 11. Something of our own. (Carousel, 3) — Trove Collection tease
  cover(11, '1', 'c9-drape.jpg', '', 'Something of|our own.', 'The Trove Collection, our own range. Coming next year.', 'troveathome.com',
    { mood: true, upgrade: 'A real material swatch or sketch from the Collection work' }),
  type(11, '2', 'clay', 'The Collection is ours.|The Marketplace|is yours.', 'Both on troveathome.com. Ours comes next year. Yours starts with an application.', { size: 96 }),
  end(11, '3', 'While we make ours,|we’re looking for yours.', 'Ceramics, candles, textiles, prints and more, made by hand.', { size: 96 }),
];
