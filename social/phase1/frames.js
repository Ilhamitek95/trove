// Every frame for Phase 1 posts 1–10: "Made here. Made home." v4 (19 Oct 2026), the concrete rebuild.
// Built from agents/social-creative-v2.md (frames) and agents/brand-strategist-v2.md (plain headlines and the
// proposition). Copy and captions live in posts.json.
// Square-bracketed text renders as a dashed placeholder box: fill it in before posting.
// photo: a file name in ./photos — rendered when present, otherwise a labelled photo slot.
// mood: true = a generated mood image (props, tools, spaces). The strategy allows these only for mood
// and Collection teases, never as a maker's work — real makers' pieces and hands always come from real photos.
// upgrade: the real-people shot (see the shoot plan) that replaces this frame's mood image once it is taken.
// screen: a phone capture in ./screens (1170px wide); offset = CSS pixels to skip at the top (cuts the delivery bar).

const PROP = 'Sell what you make. Take bookings for what you do. On Trove.';
const LINE = 'Made here.|Made home.';
const end = (post, id, extra = {}) => ({ post, id, kind: 'slide', bg: 'sage', layout: 'cta', title: LINE, body: 'Apply in about ten minutes.', ...extra });
const photo = (post, id, file, caption, extra = {}) => ({ post, id, kind: 'slide', bg: 'cream', layout: 'photo', photo: file, mood: true, caption, ...extra });
const phone = (post, id, screen, offset, title, sub, extra = {}) => ({ post, id, kind: 'slide', bg: 'clay', layout: 'phone', screen, offset, title, sub, ...extra });

module.exports = [
  // 1. You should sell these. (Carousel, 7)
  photo(1, '1', 'c1-evening.jpg', 'You should|sell these.', { big: true, foot: PROP,
    sub: 'Trove is a new website where people in Dubai and Abu Dhabi sell what they make by hand.',
    upgrade: 'Two friends at a kitchen table, one holding up a cushion cover the other embroidered (shot 1–2)' }),
  photo(1, '2', 'c1-qalam.jpg', 'The cousin who letters every|name on the Eid envelopes.'),
  photo(1, '3', 'c1-chair.jpg', 'The father who brings old|chairs back at the weekend.'),
  { post: 1, id: '4', kind: 'slide', bg: 'cream', layout: 'grid', title: 'What you can|sell on Trove',
    items: ['Candles', 'Ceramics', 'Embroidery', 'Crochet and knits', 'Calligraphy prints', 'Necklaces and bracelets', 'Baby blankets', 'Wheat bags', 'Pet collars'] },
  phone(1, '5', 'shop-template-full.png', 0, 'Your own shop page,|with your name on it.', 'Your story at the top, your pieces below. Our photographer can take the photos.', { label: 'Illustration' }),
  { post: 1, id: '6', kind: 'slide', bg: 'cream', layout: 'steps', title: 'What happens next',
    steps: ['Apply in about ten minutes', 'A real person reads it', 'We reply, usually in a day or two', 'We photograph, or you use your photos', 'A courier collects sales at your door'] },
  end(1, '7', { title: 'Send this to the one|you thought of.', body: 'Or, if it’s you, apply. No company needed to start.' }),

  // 2. Someone in your building is making something. (Reel, about 30 s, sound-led)
  { post: 2, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'c2-street.jpg', mood: true,
    kicker: 'Trove · sell what you make at home', title: 'Someone in your|building is making|something.' },
  ...[
    ['c2-apartment.jpg', 'A sewing machine after dinner: cushion covers.'],
    ['c2-gate.jpg', 'Sandpaper on a Saturday: a chair for a cousin.'],
    ['c2-townhouse.jpg', 'A wheel on the balcony: six bowls for a friend.'],
    ['c2-majlis.jpg', 'An oud being tuned for a wedding on Thursday.'],
  ].map(([file, text], i) => ({ post: 2, id: 'scene-' + (i + 1), kind: 'reel', bg: 'cream', layout: 'reel-photo', photo: file, mood: true, text })),
  { post: 2, id: 'scene-5', kind: 'reel', bg: 'clay', layout: 'reel-phone', screen: 'sell-full.png', offset: 47,
    title: 'Trove gives that work|a shop page of its own.', size: 76, upgrade: 'Hands scrolling the Sell on Trove page on a phone at a kitchen table (shot 8)' },
  { post: 2, id: 'scene-6', kind: 'reel', bg: 'cream', layout: 'reel-photo', photo: 'c2-parcel.jpg', mood: true,
    text: 'And a courier collects it from your door.', upgrade: 'Hands passing a packed parcel across a front door (shot 7)' },
  { post: 2, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Your kitchen table|could be a shop.', body: 'Pieces and services, from homes in Dubai and Abu Dhabi.' },

  // 3. You make it. Trove sells it. (Carousel, 7) — what the platform does
  phone(3, '1', 'sell-full.png', 47, 'You make it.|Trove sells it.', 'We photograph it, give it a shop, look after the buyer and send a courier to your door.', { foot: PROP }),
  { post: 3, id: '2', kind: 'slide', bg: 'cream', layout: 'steps', title: 'Your part',
    steps: ['Make at your own pace', 'Set your own price', 'Choose how many orders a month', 'Pack each sale in your own packaging'] },
  photo(3, '3', 'c3-setup.jpg', 'Our photographer|shoots your pieces.', { sub: 'Or use your own photos. Either way, your shop looks cared for.',
    upgrade: 'The in-house photographer at a kitchen table shooting a piece in window light (shot 6)' }),
  phone(3, '4', 'shop-template-full.png', 0, 'Your name. Your story.|Your pieces.', 'Every maker gets a shop page on troveathome.com. This one is waiting for a name.', { bg: 'sage', label: 'Illustration' }),
  photo(3, '5', 'c3-parcel.jpg', 'A courier collects|from your door.', { sub: 'In Dubai or Abu Dhabi. Trove books it; you hand over the parcel.',
    upgrade: 'Hands holding out a packed parcel at the front door (shot 7)' }),
  phone(3, '6', 'apply-top.png', 120, 'About ten minutes|to apply.', 'Have ready: photos of your work, a WhatsApp number and rough prices.'),
  end(3, '7', { body: 'A real person reads every application, usually within a day or two.' }),

  // 4. Who do you call? (Carousel, 7) — handy people who would never call it a service
  photo(4, '1', 'c4-bowl.jpg', 'Grandmother’s bowl has|cracked. Who do you call?', { big: true, size: 72, foot: PROP,
    sub: 'Trove is a new website for people here who offer repairs, styling and workshops.' }),
  photo(4, '2', 'c4-cards.jpg', 'The wedding cards need every|name lettered by hand.'),
  photo(4, '3', 'c4-kids.jpg', 'Eight six-year-olds,|one craft table.'),
  photo(4, '4', 'c4-armchair.jpg', 'The armchair your father|won’t let go of.'),
  { post: 4, id: '5', kind: 'slide', bg: 'blue', layout: 'grid', title: 'Services you can|offer on Trove',
    items: ['Kintsugi repair', 'Furniture restoration', 'Calligraphy and lettering', 'Tablescapes', 'Gift wrapping', 'Pottery workshops', 'Kids’ craft parties', 'Portraits at home', 'Oud sets'] },
  phone(4, '6', 'sell-services-top.png', 47, 'Your service gets|its own page.', 'Booking requests arrive in one dashboard. You visit homes in Dubai and Abu Dhabi.', { bg: 'cream' }),
  end(4, '7', { bg: 'blue', title: 'Your family calls you.|Let others book you.', body: 'Teach, style, letter, repair, shoot or play.' }),

  // 5. Who's the one everyone asks? (Carousel, 3; frame 1 can run alone) — nominations
  photo(5, '1', 'c5-doorway.jpg', 'Who’s the one|everyone asks?', { big: true, foot: PROP,
    sub: 'Tag them. Trove is a new website where people in Dubai and Abu Dhabi sell handmade work.',
    upgrade: 'Two pairs of hands at a table, one holding out a crocheted blanket, the other pointing at the stitches (shot 2 or 9)' }),
  { post: 5, id: '2', kind: 'slide', bg: 'cream', layout: 'grid', title: 'Tag the one|who does the…',
    items: ['Cushions', 'Candles', 'Crochet blankets', 'Wedding-card lettering', 'Party tables', 'Chair repairs', 'Pottery', 'Gift wrapping'] },
  { post: 5, id: '3', kind: 'slide', bg: 'sage', layout: 'steps', title: 'What we do|with your tag',
    steps: ['We look at their work', 'We write to them within two days', 'We name you only if you’re happy to', 'No reply? One reminder, then we stop'] },

  // 6. Keep your stall. Add a Trove shop. (Carousel, 5) — established makers, Downtown Design week
  photo(6, '1', 'c6-market.jpg', 'Keep your stall.|Add a Trove shop.', { big: true, foot: PROP,
    sub: 'Trove is a new curated website for makers in Dubai and Abu Dhabi. It isn’t instead.',
    upgrade: 'An established maker who has applied, at their own stall, wrapping a piece (collab)' }),
  phone(6, '2', 'shop-template-full.png', 0, 'Your shop, with|your name on it.', 'Your story, your pieces, your prices. Founding makers get a badge on their shop.', { label: 'Illustration' }),
  { post: 6, id: '3', kind: 'slide', bg: 'cream', layout: 'steps', title: 'What Trove handles',
    steps: ['Product photos, if you’d like them', 'The buyer’s questions and payment', 'Booking the courier to your door', 'A spotlight for founding makers'] },
  { post: 6, id: '4', kind: 'slide', bg: 'cream', layout: 'hero', title: 'Keep all of it.',
    body: 'Your Instagram, your market days, your own customers. Trove isn’t exclusive. It’s one more place people can find your work.' },
  end(6, '5', { title: 'One more home|for your work.', body: 'We’re walking Downtown Design this week. Say hello.' }),

  // 7. You style every party. Now take bookings. (Carousel, 7) — providers, Diwali
  photo(7, '1', 'c7-tower.jpg', 'You style every party.|Now take bookings.', { big: true, size: 80, foot: PROP,
    sub: 'Trove is a new website for stylists, gift wrappers and letterers in Dubai and Abu Dhabi.' }),
  photo(7, '2', 'c7-diyas.jpg', 'Diyas on the fourth|floor tonight.', { upgrade: 'Hands placing diyas and marigolds in a real home (a real stylist who has applied)' }),
  photo(7, '3', 'c7-tree.jpg', 'A tree going up on|the ninth next month.'),
  { post: 7, id: '4', kind: 'slide', bg: 'cream', layout: 'grid', title: 'Services for|the season ahead',
    items: ['Diwali tables', 'Christmas trees dressed', 'National Day home styling', 'Gift wrapping', 'Hand-lettered place cards', 'Party setups', 'Kids’ craft birthdays', 'Family portraits at home'] },
  phone(7, '5', 'services-top.png', 47, 'Your service, on the|Services Marketplace.', 'A page of your own. People request a date, and it arrives in your dashboard.'),
  { post: 7, id: '6', kind: 'slide', bg: 'clay', layout: 'hero', title: 'From December,|your service|can be a gift.', size: 100,
    body: 'People will be able to buy a tablescape, a workshop or a portrait session as a present for someone else.' },
  end(7, '7', { title: 'Style, wrap or letter?|There’s a page for you.' }),

  // 8. Just a hobby, No. 1 (Collab Reel) — the first real founding maker
  { post: 8, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'c8-cover.jpg',
    slot: 'Real: the maker’s work on a shelf at home, their hands in frame', kicker: 'Just a hobby · Dubai & Abu Dhabi makers', title: '[Name] said it|was just a hobby.' },
  { post: 8, id: 'words', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '“[Their own words]”' },
  { post: 8, id: 'craft', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '[Craft] at the dining table in [area], since [year].' },
  { post: 8, id: 'shop', kind: 'reel', bg: 'clear', layout: 'lower-third', text: 'Now [Name] has a shop page on Trove.' },
  { post: 8, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Know someone|like [Name]?', body: 'Tag them. Made here. Made home.' },

  // 9. Something of our own. (Carousel, 3; frame 1 can run alone) — Trove Collection tease
  photo(9, '1', 'c9-drape.jpg', 'Something of|our own.', { big: true,
    sub: 'Trove has two sides: our own Collection, and a Marketplace for Dubai and Abu Dhabi makers.' }),
  { post: 9, id: '2', kind: 'slide', bg: 'clay', layout: 'hero', title: 'The Collection is ours.|The Marketplace|is yours.', size: 96,
    body: 'Both on troveathome.com. Ours comes next year. Yours starts when you apply.' },
  end(9, '3', { title: 'While we make ours,|we’re looking for yours.', body: 'Made here. Made home.' }),

  // 10. What Trove costs, and what you keep. (Carousel, 8) — the one post about money
  phone(10, '1', 'apply-top.png', 0, 'What Trove costs,|and what you keep.', 'Nothing to join, nothing to pay if nothing sells. You set the price. All answered inside.', { foot: PROP }),
  ...[
    ['Do I need a company?', 'Not to start. Trove buys each piece and resells it. We check your Emirates ID and home address before your first payout, and may ask for an e-Trader licence if sales grow a lot.'],
    ['What does it cost me?', 'Nothing to join, and nothing to pay if nothing sells. You set the price and keep 60% when a piece sells.'],
    ['When am I paid?', 'Every other Tuesday, by bank transfer, once the buyer’s 15-day return window has closed.'],
    ['I offer a service. What do I pay?', 'Nothing during launch, then AED 30 a month, with 30 days’ notice. Paid directly by the customer, you keep 100%. Paid by card through Trove, you keep 90%.'],
    ['How much do I need to start?', 'Four lovely pieces is a shop. You choose how many orders a month you can take, and pack them in your own packaging.'],
  ].map(([q, a], i) => ({ post: 10, id: String(i + 2), kind: 'slide', bg: i % 2 ? 'clay' : 'cream', layout: 'qa', q, a })),
  { post: 10, id: '7', kind: 'slide', bg: 'cream', layout: 'steps', title: 'After you press Apply',
    steps: ['A real person reads your application', 'We reply, usually within a day or two', 'Add your story, pieces and prices', 'Photos by us, or by you', 'A courier collects each sale'] },
  end(10, '8', { title: 'Have a wander.|There’s no rush.', body: 'Made here. Made home.' }),
];
