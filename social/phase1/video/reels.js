// The Reels (v6, 26 Oct 2026). Owner, 21 Oct: "create a video post for each pillar"; owner, 26 Oct: "I would like to have
// more image/videos rather than text." v6 has eight Reels: the four pillar Reels (2 Trove, 12 makers, 13 providers,
// 14 buyers), three carousels turned into Reels (3 "Makers. Providers. Buyers.", 5 "You make it. Trove sells it.",
// 8 workshops) and post 10's founding-maker Reel (real footage only, not built here).
// Each Reel is five 5-second shots (post 2 has six) and the closing card. Clips are Higgsfield Kling 3.0 pro, silent,
// 9:16, 5 s (about 8.75 credits a clip), animated from a start frame in video/start/ (photos cropped to 9:16). Hands
// only, no faces; Instagram AI label on; real footage replaces them after the shoot.
//
// Shot fields
// clip: file name in the clips folder (CLIPS, default ~/OneDrive/Downloads/Trove Phase 1 video clips).
// start: the start frame, a file in ./photos (new v6 stills are in photos/prompts.json with status "to-generate").
// overlay: a frame id of the same post in frames.js, rendered to out/post-NN/<id>.png by render.js.
// still: instead of a clip, a rendered 9:16 frame of the same post (out/post-NN/<still>.png) held for the shot with a
//   slow push-in (about 1.00 to 1.05). Needs the small build.js change in V6-PLAN.md ("Renderer changes").
// status: 'keep' = the clip already exists for this Reel; 'reuse' = an existing clip moved here from another Reel
//   (`from` names where it was); 'new' = generate it (start frame + motion below).
// motion: the prompt the clip was (or will be) generated with.
// Build: node render.js, then node video/build.js (needs ffmpeg on the PATH).
const STYLE = ' Slow, gentle, realistic motion; the camera stays almost still with a very slow push-in. Natural hand movement with correct anatomy; nothing new appears in frame. No text, no faces.';

module.exports = [
  // Post 2, Trove: "We'd rather know who made it." Six shots: the hook, then the five name tags from the 22 Oct feedback.
  // Regenerated: the cushion (now bold terracotta and indigo) and the chair (now carved wood re-covered in a bold print).
  // New: earrings, blanket, painting. Dropped from this Reel: 02-4 (wedding-card lettering, now post 8) and 02-5 (the
  // shared table, now post 3). The old 02-2 and 02-3 files stay in the clips folder, unused.
  { post: 2, pillar: 'Trove', shots: [
    { clip: '02-1.mp4', status: 'keep', start: 'real-02-piece.jpg', overlay: 'hook', motion: 'The two hands slowly lift the handmade ceramic bowl a little towards the camera and turn it slightly to show its speckled glaze.' + STYLE },
    { clip: '02-earrings.mp4', status: 'new', start: 'v-earrings.jpg', overlay: 'name-1', motion: 'The fingers close the small round-nose pliers to finish a tiny loop of fine gold wire around a pearl, then set the finished earring down gently on the small ceramic dish beside its pair.' + STYLE },
    { clip: '02-blanket.mp4', status: 'new', start: 'v-blanket.jpg', overlay: 'name-2', motion: 'The hands work the crochet hook through the soft yarn with a calm, steady rhythm, adding stitches to the pastel striped blanket draped over the knees; the yarn pulls gently from the basket.' + STYLE },
    { clip: '02-cushion.mp4', status: 'new', start: 'v-cushion.jpg', overlay: 'name-3', motion: 'The hand pulls the needle and indigo thread slowly through the linen, finishing the last stitches of the terracotta and indigo geometric pattern, while the other hand steadies the fabric.' + STYLE },
    { clip: '02-painting.mp4', status: 'new', start: 'v-painting.jpg', overlay: 'name-4', motion: 'The hand lifts the brush from the palette and adds one slow final stroke of colour to the small abstract canvas on the table easel, then draws the brush back.' + STYLE },
    { clip: '02-chair.mp4', status: 'new', start: 'v-chair-print.jpg', overlay: 'name-5', motion: 'The hand sands the carved wooden chair leg with short, steady strokes, fine sawdust drifting and catching the sunlight, while the other hand holds the chair still.' + STYLE },
  ] },

  // Post 3: "Makers. Providers. Buyers." (was a carousel). One colour per word: Pink, Light Blue, Light Green.
  { post: 3, pillar: 'Trove', shots: [
    { clip: '02-5.mp4', status: 'reuse', from: 'post 2 (v5 shot 5)', start: 'g-03-intro.jpg', overlay: 'hook', motion: 'Around the shared wooden table, one pair of hands keeps glazing the mug with a brush, another hand adjusts a stem in the vase, and a hand slides the small wrapped gift a little across the table.' + STYLE },
    { clip: '03-linocut.mp4', status: 'new', start: 'v-linocut.jpg', overlay: 'l-1', motion: 'The hand slowly peels the printed sheet up and away from the carved lino block, revealing more of the rose-pink botanical print.' + STYLE },
    { clip: '03-pieces.mp4', status: 'new', start: 'v-four.jpg', overlay: 'l-2', motion: 'Overhead view of four very different handmade pieces on a table: soft daylight and the shadow of a leaf drift slowly across them, the beads catch the light; the camera slowly pushes in. Nothing moves except light and shadow; nothing new appears in frame. No people, no text.' },
    { clip: '03-stylist.mp4', status: 'new', start: 'v-stylist.jpg', overlay: 'l-3', motion: 'The hands set the handmade vase of stems on the console table, turn it a little, then smooth the light blue linen runner beside it.' + STYLE },
    { clip: '03-vase.mp4', status: 'new', start: 'v-vase.jpg', overlay: 'l-4', motion: 'The hands lift the handmade green-glazed vase slowly out of its box and set it down among the potted plants on the sunny windowsill.' + STYLE },
  ] },

  // Post 12, makers: "From your hands to your own shop." Lead colour Light Blue yarn. Kept: the candle (12-3).
  // Moved to post 5: 12-4 (the photo backdrop) and 12-5 (the courier at the door). Dropped: 12-1 (cream blanket; post 2
  // now has a crochet scene) and 12-2 (linocut; post 3 now has a pink linocut).
  { post: 12, pillar: 'Makers', shots: [
    { clip: '12-toy.mp4', status: 'new', start: 'v-toy.jpg', overlay: 'hook', motion: 'The hands crochet the next few stitches of the small light blue toy with a calm rhythm, turning it slightly as they work; the yarn pulls gently from the ball.' + STYLE },
    { clip: '12-3.mp4', status: 'keep', start: 'real-04-own-piece.jpg', overlay: 'l-1', motion: 'The hands gently turn the handmade candle in its speckled ceramic vessel and hold it a little closer to the camera.' + STYLE },
    { clip: '12-collar.mp4', status: 'new', start: 'v-collar.jpg', overlay: 'l-2', motion: 'The hands pull the needle through the bright patterned fabric of the dog collar, then tug the brass buckle gently to check it.' + STYLE },
    { clip: '12-cobalt.mp4', status: 'new', start: 'v-cobalt.jpg', overlay: 'l-3', motion: 'The hands lift the top cobalt-blue glazed plate from the small stack and turn it slowly so the glaze catches the window light.' + STYLE },
    { clip: '12-beads.mp4', status: 'new', start: 'v-beads.jpg', overlay: 'l-4', motion: 'The fingers thread one more jewel-toned glass bead onto the cord and slide it down to join the others.' + STYLE },
  ] },

  // Post 5: "You make it. Trove sells it." (was a carousel): make, photograph, shop page, pack, courier. Lead Clay.
  { post: 5, pillar: 'Makers', shots: [
    { clip: '05-notebook.mp4', status: 'new', start: 'v-notebook.jpg', overlay: 'hook', motion: 'The hands pull the waxed thread through the spine of the hand-bound notebook and draw it tight, the marbled cover resting open on the table.' + STYLE },
    { clip: '12-4.mp4', status: 'reuse', from: 'post 12 (v5 shot 4)', start: 'g-05-cover.jpg', overlay: 'l-1', motion: 'The hands set the handmade vase down on the cream paper backdrop, adjust its angle slightly, then draw back out of frame; the camera in the foreground stays still.' + STYLE },
    { still: 'shop', status: 'still', overlay: null },
    { clip: '05-pack.mp4', status: 'new', start: 'v-pack.jpg', overlay: 'l-2', motion: 'The hands fold tissue paper over the bright patterned silk scarf, lay it in the small box and tie the ribbon.' + STYLE },
    { clip: '12-5.mp4', status: 'reuse', from: 'post 12 (v5 shot 5)', start: 'v-door.jpg', overlay: 'l-3', motion: 'The maker’s hands pass the kraft parcel into the courier’s gloved hands, who take hold of it and draw it gently away.' + STYLE },
  ] },

  // Post 13, providers: "Get booked for what you do best." Lead Light Green. Kept: 13-1, 13-3, 13-4.
  // Moved to post 8: 13-2 (pottery workshop) and 13-5 (finished pots).
  { post: 13, pillar: 'Providers', shots: [
    { clip: '13-1.mp4', status: 'keep', start: 'g-03-provider.jpg', overlay: 'hook', motion: 'The hands plump the linen cushion on the sofa and smooth the woven throw over the sofa arm.' + STYLE },
    { clip: '13-3.mp4', status: 'keep', start: 'real-07-table.jpg', overlay: 'l-1', motion: 'The hand sets the lit clay diya down on the table and draws back; the small flames of the diyas flicker softly along the table of marigolds and brass.' + STYLE },
    { clip: '13-4.mp4', status: 'keep', start: 'v-camera.jpg', overlay: 'l-2', motion: 'The hands steady the camera and a finger presses the shutter, then the camera lowers slightly after the shot; the styled table beyond stays softly out of focus with the candle flames flickering.' + STYLE },
    { clip: '13-kintsugi.mp4', status: 'new', start: 'v-kintsugi.jpg', overlay: 'l-3', motion: 'The fine brush traces gold slowly along the mended crack of the deep green bowl, while the other hand turns the bowl a little.' + STYLE },
    { clip: '13-mural.mp4', status: 'new', start: 'v-mural.jpg', overlay: 'l-4', motion: 'The hand paints one more leaf onto the botanical mural with a slow, steady brushstroke, then lifts the brush away.' + STYLE },
  ] },

  // Post 8: "Run workshops? Take bookings on Trove." (was a carousel). Lead Light Blue.
  { post: 8, pillar: 'Providers', shots: [
    { clip: '13-2.mp4', status: 'reuse', from: 'post 13 (v5 shot 2)', start: 'real-08-workshop.jpg', overlay: 'hook', motion: 'Around the wooden table, the hands pinch and shape their small clay pots, turning them slowly.' + STYLE },
    { clip: '08-embroidery.mp4', status: 'new', start: 'v-embroidery.jpg', overlay: 'l-1', motion: 'Around the table, the hands push their needles through the light blue linen in their hoops and draw the bright threads through.' + STYLE },
    { clip: '02-4.mp4', status: 'reuse', from: 'post 2 (v5 shot 4)', start: 'v-letters.jpg', overlay: 'l-2', motion: 'The hand draws one slow, smooth curved ink stroke across the top cream card with the brush pen, a single decorative flourish with no letters, while the other hand rests on the stack.' + STYLE },
    { clip: '08-kids.mp4', status: 'new', start: 'v-kids.jpg', overlay: 'l-3', motion: 'The small hands dab bright paint onto the wooden shapes while an adult hand steadies the paint pot beside them.' + STYLE },
    { clip: '13-5.mp4', status: 'reuse', from: 'post 13 (v5 shot 5)', start: 'v-pots.jpg', overlay: 'l-4', motion: 'The hands raise their small finished pinch pots a little higher over the table and turn them gently to show them off.' + STYLE },
  ] },

  // Post 14, buyers (December): "Handmade, by people who live here." Pink and Pastel Orange gift tones. Kept: 14-1 to
  // 14-4. Replaced: 14-5 (the neutral flat-lay) with a bright flat-lay, so the Reel shows at least one bold piece.
  { post: 14, pillar: 'Buyers', shots: [
    { clip: '14-1.mp4', status: 'keep', start: 'g-03-buyer.jpg', overlay: 'hook', motion: 'The hands lift the handmade speckled vase slowly up out of the kraft box, the tissue paper shifting around it.' + STYLE },
    { clip: '14-2.mp4', status: 'keep', start: 'v-shelf.jpg', overlay: 'l-1', motion: 'The hand sets the speckled vase down on the shelf, turns it slightly so the dried stems face the room, and draws back.' + STYLE },
    { clip: '14-3.mp4', status: 'keep', start: 'v-candles.jpg', overlay: 'l-2', motion: 'The hands pour melted wax slowly from the small metal jugs into the ceramic jars, the wax rising gently around the wicks.' + STYLE },
    { clip: '14-4.mp4', status: 'keep', start: 'g-07-gift.jpg', overlay: 'l-3', motion: 'The hand settles the cream envelope with the green ribbon onto the wrapped gift and smooths it flat; the diya flame and fairy lights flicker softly behind.' + STYLE },
    { clip: '14-pieces.mp4', status: 'new', start: 'v-pieces.jpg', overlay: 'l-4', motion: 'Overhead flat-lay of colourful handmade pieces: soft daylight and the shadows of leaves drift slowly across them, the candle flame flickers gently; the camera slowly pushes in. Nothing moves except light and shadow; nothing new appears in frame. No people, no text.' },
  ] },
];
