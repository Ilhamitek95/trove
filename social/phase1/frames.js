// Every frame for Phase 1 posts 1–10: the merged campaign "Made here. Made home." (v3, 19 Oct 2026),
// built from agents/brand-strategist.md and agents/social-creative.md. Copy and captions live in posts.js.
// Square-bracketed text renders as a dashed placeholder box: fill it in before posting.
// photo: a file name in ./photos — rendered when present, otherwise a labelled photo slot.
// mood: true = a generated mood image (props, tools, spaces). The strategy allows these only for mood
// and Collection teases, never as a maker's work — real makers' pieces and hands always come from real photos.

const LINE = 'Made here.|Made home.';
const end = (post, id, extra = {}) => ({ post, id, kind: 'slide', bg: 'sage', layout: 'cta', title: LINE, body: 'Apply in about ten minutes.', ...extra });
const photo = (post, id, file, caption, extra = {}) => ({ post, id, kind: 'slide', bg: 'cream', layout: 'photo', photo: file, mood: true, caption, ...extra });

module.exports = [
  // 1. You should sell these. (Carousel, 7) — the gifted person and the friend who keeps telling them
  photo(1, '1', 'c1-evening.jpg', 'You should sell these.', { big: true, sub: 'Everyone knows someone who has heard it.' }),
  photo(1, '2', 'c1-qalam.jpg', 'The cousin who letters every name|on the Eid envelopes.'),
  photo(1, '3', 'c1-hoop.jpg', 'The neighbour whose cushions keep|turning up in other people’s homes.'),
  photo(1, '4', 'c1-chair.jpg', 'The father who spends his weekends|bringing old chairs back to life.'),
  photo(1, '5', 'c1-table.jpg', 'The friend who always does the table.|Iftar, Diwali, Christmas, every birthday.'),
  { post: 1, id: '6', kind: 'slide', bg: 'clay', layout: 'hero', title: 'They’d never call|it a business.',
    body: 'They don’t need to be one to start. Trove is a new home for handmade pieces and creative services from people in Dubai and Abu Dhabi.' },
  end(1, '7', { title: 'Send this to the|one you thought of.', body: 'Made here. Made home.' }),

  // 2. Behind the door (Reel, ~30 s) — manifesto voiceover over doors and the sounds of making
  { post: 2, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'c2-street.jpg', mood: true,
    kicker: 'Somewhere in your building', title: 'someone is|making something.' },
  ...[
    ['c2-gate.jpg', 'Bringing a chair back.'],
    ['c2-townhouse.jpg', 'Throwing a bowl.'],
    ['c2-majlis.jpg', 'Tuning the oud.'],
    ['c2-apartment.jpg', 'Wrapping someone else’s gift.'],
    ['c2-street.jpg', 'Trove is a home for what’s made behind these doors.'],
  ].map(([file, text], i) => ({ post: 2, id: 'scene-' + (i + 1), kind: 'reel', bg: 'cream', layout: 'reel-photo', photo: file, mood: true, text })),
  { post: 2, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: LINE, body: 'Dubai and Abu Dhabi.' },

  // 3. Your part. Our part. (Carousel, 7) — what the platform does
  photo(3, '1', 'c3-setup.jpg', 'You make it.|We help it find a home.', { big: true }),
  ...[
    ['Make at your own pace.', 'Photograph it, or use your own photos.'],
    ['Set the price.', 'Give it a shop of its own.'],
    ['Choose how many orders a month.', 'Look after the buyer.'],
    ['Pack it your way.', 'Send a courier to your door.'],
  ].map(([you, trove], i) => ({ post: 3, id: String(i + 2), kind: 'slide', bg: i % 2 ? 'clay' : 'cream', layout: 'pair', you, trove })),
  { post: 3, id: '6', kind: 'slide', bg: 'cream', layout: 'hero', title: 'Keep your Instagram.|Keep your|market table.', size: 100,
    body: 'Trove isn’t instead. It’s one more home for your work.' },
  end(3, '7'),

  // 4. Who do you call? (Carousel, 7) — handy people who would never call it a service
  photo(4, '1', 'c4-bowl.jpg', 'Your grandmother’s bowl has|cracked. Who do you call?', { big: true, size: 72 }),
  photo(4, '2', 'c4-cards.jpg', 'The wedding cards need every name|lettered by hand.'),
  photo(4, '3', 'c4-diyas.jpg', 'Diwali is at yours this year, and the|table needs to feel like home.'),
  photo(4, '4', 'c4-kids.jpg', 'Eight six-year-olds, one afternoon,|one craft table.'),
  photo(4, '5', 'c4-armchair.jpg', 'The armchair your father|won’t let go of.'),
  { post: 4, id: '6', kind: 'slide', bg: 'blue', layout: 'hero', title: 'Every family here|has someone|they call.', size: 104,
    body: 'Sometimes it’s a business. Often it’s just the handy one.' },
  end(4, '7', { bg: 'blue', title: 'If that’s you,|there’s a place on Trove.', body: 'Teach, style, letter, repair, shoot, perform.' }),

  // 5. Who's the one everyone asks? (Single image) — nominations
  photo(5, 'image', 'c5-doorway.jpg', 'Who’s the one|everyone asks?', { big: true, sub: 'For the cushions. The wedding cards. The chair that wobbles. Tag them.' }),

  // 6. This isn't instead. (Carousel, 6) — established makers, Downtown Design week
  photo(6, '1', 'c6-market.jpg', 'You already have the Instagram, the|market table and the midnight DMs.', { big: true, size: 64 }),
  { post: 6, id: '2', kind: 'slide', bg: 'cream', layout: 'hero', title: 'Trove isn’t instead.', body: 'Keep all of it.' },
  { post: 6, id: '3', kind: 'slide', bg: 'clay', layout: 'hero', title: 'One more home|for your work.',
    body: 'A curated place where people in Dubai and Abu Dhabi will come looking for handmade things for their homes.' },
  { post: 6, id: '4', kind: 'slide', bg: 'cream', layout: 'list', title: 'What we add',
    items: ['Our photographer, if you’d like one', 'A courier at your door', 'The buyer looked after', 'A spotlight for founding makers'] },
  { post: 6, id: '5', kind: 'slide', bg: 'cream', layout: 'hero', title: 'Your price.|Your pace.',
    body: 'You choose how many orders a month you take, and pack in your own packaging.' },
  end(6, '6'),

  // 7. One building. A whole year of celebrations. (Carousel, 7) — providers, Diwali
  photo(7, '1', 'c7-tower.jpg', 'One building.|A whole year of celebrations.', { big: true, size: 76 }),
  photo(7, '2', 'c7-diyas.jpg', 'Lamps in a window on the fourth floor.'),
  photo(7, '3', 'c7-tree.jpg', 'A tree going up on the ninth.'),
  { post: 7, id: '4', kind: 'slide', bg: 'cream', layout: 'hero', title: 'Eid tables.|National Day gatherings.|Birthdays in between.', size: 92 },
  photo(7, '5', 'c7-wrap.jpg', 'Someone makes them beautiful.|Often, a neighbour.'),
  { post: 7, id: '6', kind: 'slide', bg: 'clay', layout: 'hero', title: 'Styling, gift wrapping,|party setups and|hand-lettered names.', size: 92,
    body: 'Trove is opening to you. From December, people can give your services as gifts.' },
  end(7, '7'),

  // 8. Just a hobby, No. 1 (Collab Reel) — the first real founding maker
  { post: 8, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'c8-cover.jpg',
    slot: 'Frame from the real maker’s footage: their work on the shelf', kicker: 'Just a hobby', title: 'Meet [Name].' },
  { post: 8, id: 'name-tag', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '[Name], [neighbourhood]' },
  { post: 8, id: 'words', kind: 'reel', bg: 'clear', layout: 'lower-third', text: '“[Their own words]”' },
  { post: 8, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'Know someone|like [Name]?', body: 'Made here. Made home.' },

  // 9. Something of our own. (Single image) — Trove Collection tease
  photo(9, 'image', 'c9-drape.jpg', 'Something of our own.', { big: true, sub: 'Trove Collection. Not yet. While we make ours, we’re looking for yours.' }),
  { post: 9, id: 'type', kind: 'slide', bg: 'clay', layout: 'hero', title: 'Something|of our own.',
    body: 'Trove Collection. Not yet. While we make ours, we’re looking for yours.', note: 'Text-only fallback' },

  // 10. Before you apply: the honest answers. (Carousel, 8) — the one post about money
  photo(10, '1', 'p4-tag.jpg', 'Before you apply:|the honest answers.', { big: true }),
  ...[
    ['Do I need a company?', 'Not to start. Trove buys each piece and resells it. We check your Emirates ID and address before your first payout, and may ask for an e-Trader licence if sales grow a lot.'],
    ['What does it cost?', 'Nothing to join. Nothing to pay if nothing sells.'],
    ['What do I keep?', 'You set the price and keep 60% when a piece sells.'],
    ['When am I paid?', 'Every other Tuesday, once the buyer’s 15-day return window has closed.'],
    ['I offer a service.', 'Free to list during launch. Paid directly, you keep 100%. Paid by card through Trove, you keep 90%.'],
    ['Can I keep selling elsewhere?', 'Yes. Your Instagram and your markets stay yours.'],
  ].map(([q, a], i) => ({ post: 10, id: String(i + 2), kind: 'slide', bg: i % 2 ? 'clay' : 'cream', layout: 'qa', q, a })),
  end(10, '8', { title: 'Have a wander.|There’s no rush.', body: 'Made here. Made home.' }),
];
