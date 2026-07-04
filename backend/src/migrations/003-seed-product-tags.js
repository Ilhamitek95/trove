'use strict';
/**
 * Backfill search tags onto the demo catalogue. Products are matched by their
 * image_seed and only touched while their tags are still empty, so anything a
 * seller has already tagged (or will tag) is never overwritten. seed.js
 * imports SEED_TAGS so fresh databases get the same tags.
 */
const SEED_TAGS = {
  mug7:     ['stoneware', 'coffee mug', 'handmade pottery', 'matte glaze', 'kitchen', 'tea cup', 'wheel thrown', 'gift for coffee lover'],
  tee4:     ['organic cotton', 't-shirt', 'garment dyed', 'heavyweight tee', 'wardrobe basic', 'unisex', 'everyday wear'],
  knit5:    ['wool sweater', 'icelandic knit', 'lopi wool', 'chunky knit', 'winter layer', 'undyed yarn', 'jumper'],
  tray3:    ['brass tray', 'hammered metal', 'catch-all', 'entryway', 'key dish', 'decor', 'housewarming gift'],
  candle8:  ['soy candle', 'cedar scent', 'smoky', 'long burn', 'cosy home', 'fragrance', 'gift for him'],
  note2:    ['notebook', 'linen bound', 'a5 journal', 'lay flat', 'writing', 'desk goods', 'stationery gift'],
  bag6:     ['weekender bag', 'waxed canvas', 'leather trim', 'travel bag', 'duffle', 'carry on', 'heirloom quality'],
  bowl9:    ['serving bowl', 'speckled clay', 'salad bowl', 'fruit bowl', 'tableware', 'handmade pottery', 'kitchen'],
  cap2:     ['merino beanie', 'watch cap', 'ribbed knit', 'winter hat', 'itch free', 'packable'],
  wallet3:  ['leather wallet', 'vegetable tanned', 'card holder', 'slim wallet', 'patina', 'gift for him', 'monogram'],
  mist5:    ['room spray', 'fig leaf', 'home fragrance', 'botanical', 'fine mist', 'fresh scent'],
  planter4: ['ceramic planter', 'plant pot', 'drainage saucer', 'indoor plants', 'glazed pot', 'plant lover gift'],
  clip1:    ['brass clip', 'page holder', 'bookmark', 'desk accessory', 'reader gift', 'paperweight'],
  throw7:   ['wool throw', 'chunky blanket', 'hand knotted', 'sofa throw', 'fringed', 'undyed wool', 'cosy home'],
  melt3:    ['wax melts', 'fig and vetiver', 'burner melts', 'flame free', 'home fragrance', 'slow scent'],
  socks2:   ['cotton socks', 'combed cotton', 'sock set', 'reinforced heel', 'everyday basics', 'stocking filler'],
  ring1:    ['signet ring', 'recycled silver', 'raw stone', 'handmade jewellery', 'one of a kind', 'statement ring'],
};

module.exports = {
  id: '003-seed-product-tags',
  SEED_TAGS,
  up(db) {
    const set = db.prepare(`UPDATE products SET tags=?
      WHERE image_seed=? AND (tags IS NULL OR tags='' OR tags='[]')`);
    for (const [seed, tags] of Object.entries(SEED_TAGS)) set.run(JSON.stringify(tags), seed);
  },
};
