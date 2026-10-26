// Every frame for Phase 1, v6 (26 Oct 2026): the series re-dated and rebuilt after the 22 Oct feedback
// (FEEDBACK-2026-10-22.md). Owner, 26 Oct: "amend the social calendar. I would like to have more image/videos rather
// than text." Plan and asset list for the producer: V6-PLAN.md.
//
// What v6 changes here
// - Calendar: 31 Oct to 28 Nov, then post 14 on Wed 2 Dec. Same order: what Trove is (1, 2, 3), makers (4, 12, 5, 6),
//   providers (7, 13, 8), money (9), a founding maker (10), the Collection (11); buyers in December (14).
// - Eight of fourteen posts are Reels: 2, 3, 5, 8, 10, 12, 13, 14 (3, 5 and 8 were carousels; shots in video/reels.js).
//   Carousels left: 1, 4, 6, 7, 9, 11 (and post 10's back-up). Every slide is a photo; at most about twelve words on an
//   inner slide; the caption does the explaining.
// - Colour: each post has a lead colour and each carousel one colour family (posts.json `colour`). Colour sits in the
//   band under each photo, never on a pure type card. No two slides in a row share a band. The key slide (the offer,
//   the 60%) sits on a Charcoal band with Cream text. Pastel Orange only inside images. End cards are always Cream.
// - Where Trove works: maker- and provider-facing frames say Dubai, Abu Dhabi and Sharjah (ONE); buyer-facing frames
//   keep the delivery area, Dubai and Abu Dhabi (ONE_BUYERS). Buyer delivery to Sharjah is not decided.
// - Every kind of maker: the new images (photos/prompts.json, status "to-generate") vary craft, colour, style and hands.
//
// Fields
// band: the colour under a photo (cream, clay, sage, blue = Light Blue, pink, green = Light Green, tan, char = Charcoal).
//   v6 needs render.js to know pink/green/tan/char, to set text, the URL line and the wordmark dot in Cream on `char`, and
//   to never draw the Orange wordmark dot on `char` or `blue` (V6-PLAN.md, "Renderer changes").
// card: the colour of the headline card on a Reel cover (reel-cover-photo; default cream).
// pos: CSS object-position for a 16:9 photo cropped into a 4:5 photo slide (default centre).
// Square-bracketed text renders as a dashed placeholder box: fill it in before posting.
// photo: a file name in ./photos, rendered when present, otherwise a labelled "Real photo" slot.
// img: a file name in ./photos shown as a strip across the top of a closing card, or behind a phone screen.
// mood: true = a generated image. upgrade: the real shot that replaces a frame once it is taken.
// screen: a phone capture in ./screens (1170px wide); offset = CSS pixels to skip at the top (cuts the delivery bar).

const SIGN = 'Made here. Made home.';
const OFFER = 'Free to join · We photograph it · We collect it';
const OFFER_P = 'Free to list during launch · Bookings in one place';
// The one-liner (22 Oct feedback): on every maker- and provider-facing end card.
const ONE = 'Trove is a new online marketplace for handmade pieces and creative services in Dubai, Abu Dhabi and Sharjah.';
// Buyer-facing frames keep the current delivery area (buyer delivery to Sharjah is the owner's open decision).
const ONE_BUYERS = 'Handmade pieces and creative services for homes in Dubai and Abu Dhabi.';

// The closing card, the same every time (feedback: Cream, the wordmark and the apply link): a photo across the top,
// the call to action, the one-liner, the apply pill and the sign-off.
const end = (post, id, title, img, extra = {}) => ({ post, id, kind: 'slide', bg: 'cream', layout: 'cta', title, body: ONE, img, mood: true, sign: SIGN, ...extra });
// A carousel cover: the photo above a band in the post's lead colour, one headline, one line, the offer along the bottom.
const cover = (post, id, file, band, slot, caption, sub, foot, extra = {}) => ({ post, id, kind: 'slide', bg: band, band, layout: 'photo', big: true, photo: file, slot, caption, sub, foot, ...extra });
// An inner photo slide: the picture above a band in the slide's colour, with the headline and one short line
const pic = (post, id, file, band, caption, sub, extra = {}) => ({ post, id, kind: 'slide', bg: band, band, layout: 'photo', photo: file, caption, sub, foot: '', mood: true, ...extra });
// A real Trove page (or the example shop page) on a phone, over a full-bleed photo (img)
const phone = (post, id, screen, offset, title, sub, img, extra = {}) => ({ post, id, kind: 'slide', bg: 'cream', layout: 'phone', screen, offset, title, sub, img, mood: true, ...extra });
// Reel frames: the cover, the opening line, one line per shot and the closing card (Cream, like the carousels')
const rcover = (post, photo, card, title, sub, extra = {}) => ({ post, id: 'cover', kind: 'reel', bg: card, card, layout: 'reel-cover-photo', photo, mood: true, title, sub, size: 92, ...extra });
const hook = (post, title, extra = {}) => ({ post, id: 'hook', kind: 'reel', bg: 'clear', layout: 'reel-hook', title, ...extra });
const line = (post, id, text) => ({ post, id, kind: 'reel', bg: 'clear', layout: 'lower-third', text });
const rend = (post, title, extra = {}) => ({ post, id: 'end', kind: 'reel', bg: 'cream', layout: 'end', title, body: ONE, lead: null, sign: SIGN, size: 104, ...extra });
const EXAMPLE = 'shop-example-full.png';

module.exports = [
  // 1. Handmade in Dubai, Abu Dhabi and Sharjah. (Carousel, 5, pinned) · Sat 31 Oct · lead Clay · warm family
  cover(1, '1', 'real-01-hands.jpg', 'clay', 'Close-up of hands finishing a real piece (shot 1)',
    'Handmade in|Dubai, Abu Dhabi|and Sharjah.', 'A new online marketplace for handmade pieces and creative services.', OFFER,
    { size: 80, mood: true, upgrade: 'Real shot 1: hands finishing a real piece, close up' }),
  pic(1, '2', 'v-pieces.jpg', 'pink', 'Pieces,|made by hand.', 'From makers who live here.', { size: 84, pos: 'center 30%' }),
  pic(1, '3', 'g-01-services.jpg', 'tan', 'Services,|at home.', 'Workshops, styling and photography.', { size: 84 }),
  phone(1, '4', 'sell-full.png', 47, 'All on|troveathome.com', 'Apply in about ten minutes.', 'p-01-sell.jpg'),
  end(1, '5', 'Make something?|Sell it on Trove.', 'e-01.jpg'),

  // 2. We'd rather know who made it. (Reel, 6 shots, about 30 s) · Mon 2 Nov · lead Cream, a different accent per scene
  // Name tags per the 22 Oct feedback, two-line style; craft only, no names. With real footage, add the maker's first
  // name and area, only with their consent.
  rcover(2, 'real-02-piece.jpg', 'cream', 'We’d rather know|who made it.', 'Pieces made with care, by people you can name.',
    { slot: 'A real piece held in its maker’s two hands (shot 9)', size: 112, upgrade: 'Real shot 9: a real piece held in its maker’s two hands' }),
  hook(2, 'We’d rather know|who made it.'),
  line(2, 'name-1', 'A pair of earrings,|made for a bride'),
  line(2, 'name-2', 'A blanket,|crocheted for a new baby'),
  line(2, 'name-3', 'A cushion cover,|stitched by hand'),
  line(2, 'name-4', 'A painting,|made for a first home'),
  line(2, 'name-5', 'An heirloom chair,|brought back to life'),
  rend(2, 'Makers on Trove get|their own shop.', { size: 96 }),

  // 3. Makers. Providers. Buyers. (Reel, 5 shots, was a carousel) · Wed 4 Nov · one colour per word: Pink (the linocut),
  // Light Blue (the stylist), Light Green (the vase). "Any style. Made by hand." straight after Makers, over four very
  // different pieces.
  rcover(3, 'g-03-intro.jpg', 'pink', 'Makers. Providers.|Buyers.', 'Here’s who Trove is for.'),
  hook(3, 'Makers.|Providers.|Buyers.'),
  line(3, 'l-1', 'Makers make it|by hand'),
  line(3, 'l-2', 'Any style.|Made by hand.'),
  line(3, 'l-3', 'Providers style,|teach and shoot'),
  line(3, 'l-4', 'Buyers find it here,|soon'),
  rend(3, 'Which one|are you?'),

  // 4. Make things by hand? You're a maker. (Carousel, 6) · Fri 6 Nov · lead Pink · warm family
  // Bands: Cream cover with Pink props in the photo, Pink, phone, Tan, Charcoal (the offer), Cream end card.
  cover(4, '1', 'g-04-pink.jpg', 'cream', 'A maker’s own hands holding their own piece (shot 9)',
    'Make things by hand?|You’re a maker.', 'Sell your handmade pieces on your own Trove shop page.', OFFER,
    { mood: true, upgrade: 'Real shot 9: a maker’s own hands holding their own piece' }),
  pic(4, '2', 'g-04-range.jpg', 'pink', 'Pearls to|cobalt glaze.', 'Jewellery, prints, candles, toys, collars and more.', { size: 84, pos: 'center 20%' }),
  phone(4, '3', EXAMPLE, 0, 'Your own|shop page.', 'This one is an example.', 'p-04-shop.jpg', { label: 'Example' }),
  pic(4, '4', 'g-04-first.jpg', 'tan', 'Never sold anything?|That’s fine.', 'Four lovely pieces is a shop.', { size: 80 }),
  pic(4, '5', 'g-06-handles.jpg', 'char', 'Free to join.', 'We photograph it. We collect it from your door.', { size: 96 }),
  end(4, '6', 'Know a maker?|Tag them.', 'e-04.jpg'),

  // 12. From your hands to your own shop. (Makers pillar Reel) · Mon 9 Nov · lead Light Blue yarn
  // Every kind of maker: a crocheted toy, a candle, a dog collar, cobalt plates, jewel-toned beads.
  // The last line on screen before the end card is "Any style. Made by hand." (feedback).
  rcover(12, 'v-toy.jpg', 'blue', 'From your hands|to your own shop.', 'Sell your handmade pieces on Trove.|Free to join.',
    { slot: 'A maker’s hands at work on a real piece', upgrade: 'Real footage from the shoot: a maker’s hands at work' }),
  hook(12, 'Make things|by hand?'),
  line(12, 'l-1', 'You’re a maker'),
  line(12, 'l-2', 'Sell on your own|Trove shop'),
  line(12, 'l-3', 'We photograph it.|We collect it.'),
  line(12, 'l-4', 'Any style.|Made by hand.'),
  rend(12, 'Make something?|Sell it on Trove.'),

  // 5. You make it. Trove sells it. (Process Reel, 5 shots, was a carousel) · Wed 11 Nov · lead Clay
  // Shot 3 is not a clip: the rendered phone frame below ('shop'), held with a slow push-in by video/build.js.
  rcover(5, 'v-notebook.jpg', 'clay', 'You make it.|Trove sells it.', 'Photos, a shop page and a courier|at your door.',
    { upgrade: 'Real shot 6: the photographer shooting a maker’s piece' }),
  hook(5, 'You make it.'),
  line(5, 'l-1', 'We photograph it'),
  { post: 5, id: 'shop', kind: 'reel', bg: 'clay', layout: 'reel-phone', screen: EXAMPLE, offset: 0, title: 'Your own|shop page.', sub: 'This one is an example.', label: 'Example' },
  line(5, 'l-2', 'Someone buys it.|You pack it.'),
  line(5, 'l-3', 'A courier collects|from your door'),
  rend(5, 'Ready when|you are.'),

  // 6. Keep your stall. Add a Trove shop. (Carousel, 4) · Sat 14 Nov · lead Tan, Pastel Orange light in the photo
  // Bands: Tan cover, phone, Charcoal (the key slide), Cream end card. Downtown Design moved to Stories (4 to 8 Nov).
  cover(6, '1', 'g-06-market.jpg', 'tan', '',
    'Keep your stall.|Add a Trove shop.', 'Trove isn’t exclusive.', OFFER,
    { mood: true, upgrade: 'Collab photo: an established maker who has applied, at their own stall' }),
  phone(6, '2', EXAMPLE, 0, 'One more place|to find your work.', 'An example shop page.', 'p-06-shop.jpg', { label: 'Example' }),
  pic(6, '3', 'g-06-keep.jpg', 'char', 'Keep everything|you have.', 'Your Instagram, your market days, your customers.', { size: 96 }),
  end(6, '4', 'Tag a maker|with a stall.', 'e-06.jpg'),

  // 7. Style homes? Run workshops? You're a provider. (Carousel, 5) · Mon 16 Nov · lead Pastel Orange (in the photo
  // only), seasonal family: Cream, Tan, Charcoal. No longer the Diwali post: Diwali (Sun 8 Nov) is a Story greeting.
  cover(7, '1', 'g-07-season.jpg', 'cream', 'Hands placing the last detail on a table styled for a celebration (shot 5)',
    'Style homes? Run workshops?|You’re a provider.', 'List your service on Trove, free during launch.', 'Workshops · Home styling · Photography',
    { size: 76, mood: true, upgrade: 'Real shot 5: hands placing the last detail on a styled table' }),
  pic(7, '2', 'v-kintsugi.jpg', 'tan', 'Styling, workshops,|repairs, portraits.', 'If people book you for it, list it.', { size: 76 }),
  phone(7, '3', 'sell-services-top.png', 47, 'Your service gets|its own page.', 'Booking requests arrive in one place.', 'p-07-services.jpg'),
  pic(7, '4', 'g-07-gift.jpg', 'char', 'Services as gifts,|from December.', 'Free to list during launch.', { size: 84 }),
  end(7, '5', 'Know a provider?|Tag them.', 'e-07.jpg'),

  // 13. Get booked for what you do best. (Providers pillar Reel) · Wed 18 Nov · lead Light Green: plants in the sunlit room
  // Styling, a celebration table, photography, kintsugi, a botanical mural. Workshops have their own Reel (post 8).
  rcover(13, 'g-03-provider.jpg', 'green', 'Get booked for|what you do best.', 'List your service on Trove.|Free during launch.',
    { slot: 'A provider at work in someone’s home', upgrade: 'Real footage from the shoot: a provider at work in a home' }),
  hook(13, 'Style homes?'),
  line(13, 'l-1', 'Set the table|for every celebration?'),
  line(13, 'l-2', 'Take photos at home?'),
  line(13, 'l-3', 'Mend what’s broken?'),
  line(13, 'l-4', 'You’re a provider'),
  rend(13, 'Offer a service?|List it on Trove.'),

  // 8. Run workshops? Take bookings on Trove. (Reel, 5 shots, was a carousel) · Fri 20 Nov · lead Light Blue
  // Pottery, embroidery, calligraphy, a kids' craft birthday, finished pots held up.
  rcover(8, 'real-08-workshop.jpg', 'blue', 'Run workshops?|Take bookings on Trove.', 'Your own service page.|Free to list during launch.',
    { slot: 'A real workshop mid-class at home, hands at work (shot 13)', upgrade: 'Real shot 13: a real workshop mid-class at home, hands at work' }),
  hook(8, 'Teach pottery at|your kitchen table?'),
  line(8, 'l-1', 'Embroidery evenings?'),
  line(8, 'l-2', 'Calligraphy classes?'),
  line(8, 'l-3', 'Kids’ craft birthdays?'),
  line(8, 'l-4', 'Take bookings|on Trove'),
  rend(8, 'Your workshop,|on Trove.'),

  // 9. What Trove costs, and what you keep. (Carousel, 7, was 8) · Mon 23 Nov · lead Sage · cool family
  // One question and one short line per photo; the full answers are in the caption. The 60% goes on Charcoal.
  // Bands: Sage, Cream, Light Blue, Charcoal, Light Green, Light Blue, Cream end card. Photos 2 to 5 are 16:9, cropped
  // to the centre (pos); agent 2 checks each crop.
  cover(9, '1', 'g-09-cover.jpg', 'sage', '', 'What Trove costs,|and what you keep.', 'Plain answers for makers and providers.', 'troveathome.com/apply', { mood: true }),
  pic(9, '2', 'g-09-company.jpg', 'cream', 'Need a company?', 'Not to start.', { size: 96, pos: 'center' }),
  pic(9, '3', 'g-09-cost.jpg', 'blue', 'What does it cost?', 'Nothing to join. Nothing if nothing sells.', { size: 96, pos: 'center' }),
  pic(9, '4', 'g-09-paid.jpg', 'char', 'When a piece sells?', 'You keep 60%, paid every other Tuesday.', { size: 96, pos: 'center' }),
  pic(9, '5', 'g-09-service.jpg', 'green', 'Offer a service?', 'Free to list during launch.', { size: 96, pos: 'center' }),
  pic(9, '6', 'g-09-four.jpg', 'blue', 'How much to start?', 'Four lovely pieces is a shop.', { size: 96 }),
  end(9, '7', 'Have a wander.|There’s no rush.', 'e-09.jpg'),

  // 10. Meet [Name] (Collab Reel, face to camera) · Wed 25 Nov · the maker's own colours
  // Only with a real founding maker; back-up slides below (photo-led, three slides).
  { post: 10, id: 'cover', kind: 'reel', bg: 'clay', card: 'clay', layout: 'reel-cover-photo', photo: 'real-10-maker.jpg',
    slot: 'The founding maker at work, their hands and piece in frame', kicker: 'Meet a founding maker', title: 'Meet [Name].', sub: '[Craft], made in [area].' },
  line(10, 'words', '“[Their own words]”'),
  line(10, 'craft', '[Craft] at home in [area], since [year].'),
  line(10, 'shop', 'Now [Name] has a shop on Trove.'),
  rend(10, 'Know someone|like [Name]?'),
  pic(10, 'alt-1', 'g-10-after.jpg', 'clay', 'What happens|after you apply.', 'From application to your own shop page.', { size: 96,
    note: 'Back-up: runs instead of the Reel if no founding maker is ready by 23 Nov' }),
  pic(10, 'alt-2', 'v-four.jpg', 'pink', 'A real person|reads every one.', 'Usually within a day or two.', { size: 84 }),
  end(10, 'alt-3', 'Your shop,|your name on it.', 'e-05.jpg'),

  // 11. Something of our own. (Carousel, 3) · Sat 28 Nov · Cream and Sage, the Collection palette
  cover(11, '1', 'c9-drape.jpg', 'cream', '', 'Something of|our own.', 'The Trove Collection, our own range. Coming next year.', 'troveathome.com',
    { mood: true, upgrade: 'A real material swatch or sketch from the Collection work' }),
  pic(11, '2', 'g-11-materials.jpg', 'sage', 'The Collection is ours.|The Marketplace is yours.', 'Ours comes next year.', { size: 72 }),
  end(11, '3', 'While we make ours,|we’re looking for yours.', 'e-11.jpg', { size: 96 }),

  // 14. Handmade, by people who live here. (Buyers pillar Reel) · Wed 2 Dec (UAE National Day), only once the
  // Marketplace is open to buyers · Pink and Pastel Orange gift tones · BUYER-FACING: Dubai and Abu Dhabi only.
  rcover(14, 'g-03-buyer.jpg', 'pink', 'Handmade, by people|who live here.', 'Pieces and creative services|for homes in Dubai and Abu Dhabi.',
    { slot: 'Hands unpacking a real handmade piece at home', upgrade: 'Real footage: a buyer unpacking a real maker’s piece, with the maker’s consent' }),
  hook(14, 'Handmade,|by people|who live here.'),
  line(14, 'l-1', 'Pieces for home, delivered|in Dubai and Abu Dhabi'),
  line(14, 'l-2', 'Workshops you can book at home'),
  line(14, 'l-3', 'Or give one as a gift'),
  line(14, 'l-4', 'Beadwork, ceramics, prints|and more'),
  rend(14, 'Have a wander.|There’s no rush.', { body: ONE_BUYERS, lead: 'Shop at', pill: 'troveathome.com' }),
];
