// One Reel per pillar (owner, 21 Oct 2026: "create a video post for each pillar"): Trove itself (post 2), makers (12),
// providers (13) and buyers (14). Each Reel is five 5-second Higgsfield clips (Kling 3.0 pro, silent, 9:16, 8.75 credits
// a clip) and the closing card. Every clip is animated from a start frame in video/start/: the campaign's own photos
// cropped to 9:16, plus seven new stills (photos/v-*.jpg, prompts in photos/prompts.json). Hands only, no faces.
// clip: file name in the clips folder (CLIPS, default ~/OneDrive/Downloads/Trove Phase 1 video clips).
// overlay: a frame id of the same post in frames.js, rendered to out/post-NN/<id>.png by render.js.
// motion: the prompt the clip was generated with (a few used a close variant of STYLE, e.g. an overhead still camera).
// Build: node render.js, then node video/build.js (needs ffmpeg on the PATH).
const STYLE = ' Slow, gentle, realistic motion; the camera stays almost still with a very slow push-in. Natural hand movement with correct anatomy; nothing new appears in frame. No text, no faces.';

module.exports = [
  { post: 2, pillar: 'Trove', shots: [
    { clip: '02-1.mp4', start: 'real-02-piece.jpg', overlay: 'hook', motion: 'The two hands slowly lift the handmade ceramic bowl a little towards the camera and turn it slightly to show its speckled glaze.' + STYLE },
    { clip: '02-2.mp4', start: 'real-01-hands.jpg', overlay: 'name-1', motion: 'The hand pulls the needle and green thread slowly through the linen cushion cover, continuing the embroidered leaf, while the other hand steadies the fabric.' + STYLE },
    { clip: '02-3.mp4', start: 'v-chair.jpg', overlay: 'name-2', motion: 'The hand sands the worn wooden arm of the chair with short, steady strokes, fine dust drifting in the sunlight, while the other hand holds the chair still.' + STYLE },
    { clip: '02-4.mp4', start: 'v-letters.jpg', overlay: 'name-3', motion: 'The hand draws one slow, smooth curved ink stroke across the top cream card with the brush pen, a single decorative flourish with no letters, while the other hand rests on the stack.' + STYLE },
    { clip: '02-5.mp4', start: 'g-03-intro.jpg', overlay: 'line', motion: 'Around the shared wooden table, one pair of hands keeps glazing the mug with a brush, another hand adjusts a stem in the vase, and a hand slides the small wrapped gift a little across the table.' + STYLE },
  ] },
  { post: 12, pillar: 'Makers', shots: [
    { clip: '12-1.mp4', start: 'g-04-first.jpg', overlay: 'hook', motion: 'The hands crochet the next few stitches of the cream blanket with a calm, steady rhythm, the yarn pulling gently from the basket, soft lamp light.' + STYLE },
    { clip: '12-2.mp4', start: 'g-03-maker.jpg', overlay: 'l-1', motion: 'The hand slowly peels the printed sheet up and away from the carved lino block, revealing more of the green palm-leaf print.' + STYLE },
    { clip: '12-3.mp4', start: 'real-04-own-piece.jpg', overlay: 'l-2', motion: 'The hands gently turn the handmade candle in its speckled ceramic vessel and hold it a little closer to the camera.' + STYLE },
    { clip: '12-4.mp4', start: 'g-05-cover.jpg', overlay: 'l-3', motion: 'The hands set the handmade vase down on the cream paper backdrop, adjust its angle slightly, then draw back out of frame; the camera in the foreground stays still.' + STYLE },
    { clip: '12-5.mp4', start: 'v-door.jpg', overlay: 'l-4', motion: 'The maker’s hands pass the kraft parcel into the courier’s gloved hands, who take hold of it and draw it gently away.' + STYLE },
  ] },
  { post: 13, pillar: 'Providers', shots: [
    { clip: '13-1.mp4', start: 'g-03-provider.jpg', overlay: 'hook', motion: 'The hands plump the linen cushion on the sofa and smooth the woven throw over the sofa arm.' + STYLE },
    { clip: '13-2.mp4', start: 'real-08-workshop.jpg', overlay: 'l-1', motion: 'Around the wooden table, the hands pinch and shape their small clay pots, turning them slowly.' + STYLE },
    { clip: '13-3.mp4', start: 'real-07-table.jpg', overlay: 'l-2', motion: 'The hand sets the lit clay diya down on the table and draws back; the small flames of the diyas flicker softly along the table of marigolds and brass.' + STYLE },
    { clip: '13-4.mp4', start: 'v-camera.jpg', overlay: 'l-3', motion: 'The hands steady the camera and a finger presses the shutter, then the camera lowers slightly after the shot; the styled table beyond stays softly out of focus with the candle flames flickering.' + STYLE },
    { clip: '13-5.mp4', start: 'v-pots.jpg', overlay: 'l-4', motion: 'The hands raise their small finished pinch pots a little higher over the table and turn them gently to show them off.' + STYLE },
  ] },
  { post: 14, pillar: 'Buyers', shots: [
    { clip: '14-1.mp4', start: 'g-03-buyer.jpg', overlay: 'hook', motion: 'The hands lift the handmade speckled vase slowly up out of the kraft box, the tissue paper shifting around it.' + STYLE },
    { clip: '14-2.mp4', start: 'v-shelf.jpg', overlay: 'l-1', motion: 'The hand sets the speckled vase down on the shelf, turns it slightly so the dried stems face the room, and draws back.' + STYLE },
    { clip: '14-3.mp4', start: 'v-candles.jpg', overlay: 'l-2', motion: 'The hands pour melted wax slowly from the small metal jugs into the ceramic jars, the wax rising gently around the wicks.' + STYLE },
    { clip: '14-4.mp4', start: 'g-07-gift.jpg', overlay: 'l-3', motion: 'The hand settles the cream envelope with the green ribbon onto the wrapped gift and smooths it flat; the diya flame and fairy lights flicker softly behind.' + STYLE },
    { clip: '14-5.mp4', start: 'g-01-pieces.jpg', overlay: 'l-4', motion: 'Overhead flat-lay of handmade pieces on linen: soft daylight and the shadows of leaves drift slowly across the cloth, the candle flame flickers gently; the camera slowly pushes in. Nothing moves except light and shadow; nothing new appears in frame. No people, no text.' },
  ] },
];
