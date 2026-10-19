// Every frame for Phase 1 posts 1–10. Copy matches the "Trove Phase 1 social drafts" doc.
// Square-bracketed text renders as a dashed placeholder box: fill it in before posting.
// photo: a file name in ./photos — rendered when present, otherwise a labelled photo slot.
// mood: true = a generated mood image (materials, tools, spaces). The strategy allows these only for mood
// and Collection teases, never as a maker's work — real makers' pieces and hands always come from real photos.

const APPLY = 'Apply in ten minutes.';

module.exports = [
  // 1. Made here, by someone (Reel)
  { post: 1, id: 'cover', kind: 'reel', bg: 'cream', layout: 'reel-cover-photo', photo: 'p1-cover.jpg', slot: 'A frame from the real hands-at-work footage',
    kicker: 'Trove is opening to UAE makers', title: 'Made here,|by someone.' },
  { post: 1, id: 'name-tag', kind: 'reel', bg: 'clear', layout: 'lower-third',
    text: '[First name], [neighbourhood]', note: 'One per clip, e.g. Sara, Al Barsha' },
  { post: 1, id: 'end', kind: 'reel', bg: 'sage', layout: 'end',
    title: 'Made here,|by someone.', body: 'Trove is opening to UAE makers.' },

  // 2. What you don't need (Carousel, 7)
  { post: 2, id: '1', kind: 'slide', bg: 'cream', layout: 'photo', big: true, photo: 'p2-bench.jpg', mood: true,
    caption: 'To sell on Trove,|you don’t need…' },
  ...[
    ['A trade licence', 'Not to start. Trove buys each piece from you and resells it.'],
    ['A website', 'Your shop lives on Trove.'],
    ['A photographer', 'Our photographer shoots your pieces.'],
    ['A courier', 'We collect from your door in Dubai and Abu Dhabi.'],
    ['An upfront fee', 'Nothing to join. Nothing to pay if nothing sells.'],
  ].map(([strike, body], i) => ({ post: 2, id: String(i + 2), kind: 'slide', bg: 'cream', layout: 'strike', strike, body })),
  { post: 2, id: '7', kind: 'slide', bg: 'cream', layout: 'photo', big: true, photo: 'p2-materials.jpg', mood: true,
    caption: 'Just your work.', sub: APPLY },

  // 3. Meet our first maker (Reel + carousel, 6)
  { post: 3, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'p3-cover.jpg', slot: 'A frame from the maker’s own footage',
    kicker: 'A founding maker on Trove', title: 'Meet our|first maker.' },
  { post: 3, id: 'end', kind: 'reel', bg: 'cream', layout: 'end',
    title: '[Maker].', body: '[Craft], [neighbourhood].|A founding maker on Trove.' },
  { post: 3, id: '1', kind: 'slide', bg: 'cream', layout: 'photo', photo: 'p3-portrait.jpg',
    slot: 'Portrait of the maker at their bench', caption: 'Meet [maker].' },
  { post: 3, id: '2', kind: 'slide', bg: 'clay', layout: 'hero', title: '[Years] years|of [craft].' },
  { post: 3, id: '3', kind: 'slide', bg: 'cream', layout: 'quote', title: '“[Their sentence, in their own words.]”', body: '[Maker], [neighbourhood]' },
  { post: 3, id: '4', kind: 'slide', bg: 'cream', layout: 'photo', photo: 'p3-workspace.jpg', slot: 'The workspace' },
  { post: 3, id: '5', kind: 'slide', bg: 'cream', layout: 'photo', photo: 'p3-piece.jpg', slot: 'The finished piece' },
  { post: 3, id: '6', kind: 'slide', bg: 'sage', layout: 'cta', title: 'Founding makers|are joining now.', body: APPLY },

  // 4. Set your price. Keep 60% (Carousel, 6)
  { post: 4, id: '1', kind: 'slide', bg: 'cream', layout: 'photo', big: true, photo: 'p4-tag.jpg', mood: true, caption: 'Set your price.|Keep 60%.' },
  { post: 4, id: '2', kind: 'slide', bg: 'cream', layout: 'figure', small: 'Price a piece at', figure: 'AED 150' },
  { post: 4, id: '3', kind: 'slide', bg: 'sage', layout: 'split', small: 'When it sells', figure: 'AED 90', body: 'is yours.' },
  { post: 4, id: '4', kind: 'slide', bg: 'cream', layout: 'list', title: 'The AED 60 covers',
    items: ['Photography', 'Marketing', 'Checkout', 'Customer care', 'Returns', 'The courier'] },
  { post: 4, id: '5', kind: 'slide', bg: 'clay', layout: 'hero', title: 'Paid every|other Tuesday.',
    body: 'To your bank, once the buyer’s 15-day return window has closed.' },
  { post: 4, id: '6', kind: 'slide', bg: 'sage', layout: 'cta', title: 'No joining fee.|No listing fee.',
    body: 'Nothing to pay if nothing sells.|' + APPLY },

  // 5. Teach it, style it, shoot it? (Carousel, 6)
  { post: 5, id: '1', kind: 'slide', bg: 'cream', layout: 'photo', photo: 'p5-studio.jpg', mood: true, big: true, slot: 'A workshop in progress',
    caption: 'Teach it, style it, shoot it?|There’s a place for that too.' },
  { post: 5, id: '2', kind: 'slide', bg: 'cream', layout: 'list', title: 'Trove lists services|from UAE independents',
    items: ['Workshops', 'Interior styling', 'Photography'] },
  { post: 5, id: '3', kind: 'slide', bg: 'cream', layout: 'hero', title: 'Free to list|during launch.',
    body: 'A flat AED 30 a month comes later, never without 30 days’ notice.' },
  { post: 5, id: '4', kind: 'slide', bg: 'blue', layout: 'split', small: 'Paid directly by the customer?', figure: '100%', body: 'is yours.' },
  { post: 5, id: '5', kind: 'slide', bg: 'cream', layout: 'split', small: 'Paid by card through Trove?', figure: '90%',
    body: 'is yours, by bank transfer after the service date.' },
  { post: 5, id: '6', kind: 'slide', bg: 'blue', layout: 'cta', title: 'Booking requests|come straight|to your dashboard.', body: APPLY },

  // 6. Something of our own (Single image)
  { post: 6, id: 'photo', kind: 'slide', bg: 'cream', layout: 'photo', photo: 'p6-sketch.jpg',
    slot: 'A pencil sketch or glaze test on a worktable. No finished product.', caption: 'Something of our own.' },
  { post: 6, id: 'type', kind: 'slide', bg: 'clay', layout: 'hero', title: 'Something|of our own.',
    body: 'The Trove Collection. More when it is ready.', note: 'Text-only fallback if the photo is not ready' },

  // 7. Apply in ten minutes (Reel)
  { post: 7, id: 'cover', kind: 'reel', bg: 'sage', layout: 'reel-cover-photo', photo: 'p7-cover.jpg', slot: 'A frame of the maker at the kitchen table, timer running', kicker: 'We timed it', title: 'Apply in|ten minutes.' },
  ...['Open troveathome.com/apply', 'Tell us about you and your craft', 'List what you plan to sell', 'Submit']
    .map((text, i) => ({ post: 7, id: 'step-' + (i + 1), kind: 'reel', bg: 'clear', layout: 'lower-third', text, step: i + 1 })),
  { post: 7, id: 'end', kind: 'reel', bg: 'cream', layout: 'end', title: 'A real person reads|every application.',
    body: 'Usually within a day or two.' },

  // 8. Meet our first provider (Reel)
  { post: 8, id: 'cover', kind: 'reel', bg: 'blue', layout: 'reel-cover-photo', photo: 'p8-cover.jpg', slot: 'A frame from the class in progress', kicker: 'A founding provider on Trove', title: 'Meet our|first provider.' },
  { post: 8, id: 'end', kind: 'reel', bg: 'cream', layout: 'end',
    title: '[Provider].', body: '[Service], [neighbourhood].|A founding provider on Trove.' },

  // 9. More being made here than you think (Carousel, 8)
  { post: 9, id: '1', kind: 'slide', bg: 'cream', layout: 'photo', big: true, photo: 'p9-window.jpg', mood: true, caption: 'There is more being made|here than you think.' },
  ...[
    ['Stoneware, thrown in [Al Quoz].', 'p9-stoneware.jpg'],
    ['Rugs, woven in [Mirdif].', 'p9-rugs.jpg'],
    ['Silver, set in [Khalifa City].', 'p9-silver.jpg'],
    ['Candles, poured in [Jumeirah].', 'p9-candles.jpg'],
    ['Prints, pulled in [Al Reem].', 'p9-prints.jpg'],
    ['Workshops, taught in [Alserkal Avenue].', 'p9-workshop.jpg'],
  ].map(([caption, photo], i) => ({ post: 9, id: String(i + 2), kind: 'slide', bg: 'cream', layout: 'photo',
    photo, caption, slot: 'Real photo of a real maker’s work' })),
  { post: 9, id: '8', kind: 'slide', bg: 'sage', layout: 'cta', title: 'Made here?', body: APPLY },

  // 10. From sold to paid (Reel)
  { post: 10, id: 'cover', kind: 'reel', bg: 'clay', layout: 'reel-cover-photo', photo: 'p10-scene3.jpg', mood: true, kicker: 'From sold to paid', title: 'We collect.|We deliver.|You get paid.' },
  ...['It sells.', 'You pack it.', 'We collect.', 'It’s delivered.', 'You’re paid. Every other Tuesday.']
    .map((text, i) => ({ post: 10, id: 'scene-' + (i + 1), kind: 'reel', bg: 'cream', layout: 'reel-photo', photo: ['p10-scene1.jpg', 'p10-pack.jpg', 'p10-scene3.jpg', 'p10-parcel.jpg', 'p10-tuesday.jpg'][i], mood: true, text, step: i + 1 })),
  { post: 10, id: 'end', kind: 'reel', bg: 'sage', layout: 'end', title: 'We collect.|We deliver.|You get paid.' },
];
