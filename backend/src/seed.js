'use strict';
/** Seeds demo data that mirrors the storefront. Run: npm run seed */
const db = require('./db');
const { hashPassword } = require('./middleware');

const c = (aed) => Math.round(aed * 100);

db.exec(`DELETE FROM shipment_events; DELETE FROM shipments; DELETE FROM purchase_notes;
  DELETE FROM settlement_items; DELETE FROM seller_balances; DELETE FROM settlements;
  DELETE FROM webhook_events; DELETE FROM payouts; DELETE FROM order_items; DELETE FROM orders;
  DELETE FROM products; DELETE FROM addresses; DELETE FROM shops; DELETE FROM users;`);

const mkUser = db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)');
const mkShop = db.prepare(`INSERT INTO shops (user_id,name,slug,bio,location,color,is_house,payout_type,payout_bank_name,payout_account_name,payout_iban)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const mkProd = db.prepare(`INSERT INTO products (shop_id,name,description,category,price_cents,compare_at_cents,stock,status,image_seed) VALUES (?,?,?,?,?,?,?,?,?)`);
const pw = hashPassword('demo1234');

// Buyer
const layla = mkUser.run('layla@email.com', pw, 'Layla Hassan', 'buyer').lastInsertRowid;
db.prepare('INSERT INTO addresses (user_id,label,name,line,city,is_default) VALUES (?,?,?,?,?,1)')
  .run(layla, 'Home', 'Layla Hassan', 'Apt 1204, Marina Gate 2', 'Dubai Marina, Dubai');

// A seller (+ their shop) in one step. House brand owner is role 'admin'.
function shop(email, ownerName, shopName, slug, bio, location, color, isHouse, payout = {}) {
  const uid = mkUser.run(email, pw, ownerName, isHouse ? 'admin' : 'seller').lastInsertRowid;
  return mkShop.run(uid, shopName, slug, bio, location, color, isHouse ? 1 : 0,
    payout.type || 'managed', payout.bankName || '', payout.accountName || '', payout.iban || '').lastInsertRowid;
}

const house = shop('hello@trove.com', 'Trove', 'trove label', 'trove-label',
  'Our own line — designed in-house, made with vetted partners, priced honestly. The standard we hold the marketplace to.',
  'In-house · Dubai', '#262321', true,
  { type: 'managed', bankName: 'Emirates NBD', accountName: 'Trove Marketplace FZ-LLC', iban: 'AE600260001015079130500' });
const kiln = shop('mara@kilnandclay.com', 'Mara', 'Kiln & Clay', 'kiln-and-clay',
  "Small-batch stoneware thrown and glazed by hand. Each piece is a little different — that's the point.",
  'Alserkal Avenue, Dubai', '#A98B7D', false,
  { type: 'managed', bankName: 'Mashreq Bank', accountName: 'Mara Ceramics Studio', iban: 'AE930330000010101010101' });
const loom = shop('hello@northboundloom.com', 'Northbound Loom', 'Northbound Loom', 'northbound-loom',
  'Heavyweight knitwear and woven goods from a family workshop running since 1978.',
  'Al Quoz, Dubai', '#B9D0E0', false, { type: 'connect' });
const ember = shop('hello@embergoods.com', 'Ember Goods', 'Ember Goods', 'ember-goods',
  'Leather and brass made the slow way, in our Deira workshop.',
  'Deira, Dubai', '#F5C68A', false,
  { type: 'managed', bankName: 'Abu Dhabi Commercial Bank', accountName: 'Ember Goods Trading LLC', iban: 'AE120350000004567890123' });
const fern = shop('hello@fernapothecary.com', 'Fern Apothecary', 'Fern Apothecary', 'fern-apothecary',
  'Small-batch home scent — candles, room mists and botanicals. Nothing we make is applied to the skin.',
  'Masdar City, Abu Dhabi', '#C7D9AC', false,
  { type: 'managed', bankName: 'Dubai Islamic Bank', accountName: 'Fern Apothecary FZE', iban: 'AE980030001234567890123' });
const paper = shop('hello@foliopaper.com', 'Folio Paper Co.', 'Folio Paper Co.', 'folio-paper',
  'Stationery, notebooks and desk goods for people who still write things down.',
  'Al Zahiyah, Abu Dhabi', '#F4CFE0', false, { type: 'connect' });

// A shop still waiting for approval, so the super-admin review queue has
// something to demo. Hidden from the storefront until approved.
const sable = shop('nadia@sableandstone.com', 'Nadia', 'Sable & Stone', 'sable-and-stone',
  "I'm Nadia, a self-taught silversmith working from a small studio in Khalifa City, Abu Dhabi. Everything is made to order in recycled silver — I cut and set each stone by hand, so no two pieces ever match. I've sold at local markets for three years and want to reach people who value slow-made jewellery.",
  'Khalifa City, Abu Dhabi', '#B8AFA6', false, { type: 'managed' });
db.prepare(`UPDATE shops SET status='pending', category='Accessories',
  pitch_products='Raw stone signet rings — AED 220–260\nHammered silver stacking bands\nDesert stone pendants on silk cord\nOne-off statement cuffs (small batches of 5)',
  pitch_instagram='instagram.com/sableandstone.uae', pitch_links='sableandstone.com',
  pitch_experience='3+ years', pitch_maker='I make everything myself',
  pitch_channels='Markets & pop-ups', pitch_capacity='10–30', pitch_phone='+971 50 234 5678'
  WHERE id=?`).run(sable);
mkProd.run(sable, 'Raw Stone Signet Ring', 'Recycled silver band with an unpolished desert stone. Each one unique.', 'Accessories', c(240), null, 8, 'live', 'ring1');

/* ---- Two-rail supplier setup ----
 * Approved consignment suppliers arrive with payout setup already complete
 * (Emirates ID last-4, IBAN, seller agreement) so the settlement flow works
 * out of the box. IBANs are encrypted when PAYOUT_ENC_KEY is present;
 * otherwise they stay in payout_iban and the boot sweep in server.js encrypts
 * them on the first keyed start. Loom & Folio keep their old "own Stripe"
 * choice as tier 'connect' (no Stripe account attached — demo only, their
 * sales credit nobody until Rail B onboarding exists).
 */
const pcrypto = require('./crypto');
db.exec(`UPDATE shops SET tier='connect' WHERE payout_type='connect'`);
const stampSetup = db.prepare(`UPDATE shops SET
  emirates_id_last4=?, emirates_id_issue='2023-05-01', emirates_id_expiry='2033-05-01',
  iban_masked=?, iban_encrypted=?, payout_iban=?,
  agreement_version='v1', agreement_accepted_at=datetime('now','-21 days'), agreement_hash=''
  WHERE id=?`);
const SUPPLIER_IDS = { [house]: '1201', [kiln]: '4417', [ember]: '7830', [fern]: '2954' };
for (const [shopId, last4] of Object.entries(SUPPLIER_IDS)) {
  const s = db.prepare('SELECT payout_iban FROM shops WHERE id=?').get(shopId);
  const enc = pcrypto.hasKey() ? pcrypto.encrypt(s.payout_iban) : null;
  stampSetup.run(last4, pcrypto.maskIban(s.payout_iban), enc, enc ? '' : s.payout_iban, shopId);
}

const products = [
  [kiln,  'Reeded Stoneware Mug',     'Hand-thrown stoneware with a reactive matte glaze. Holds 320ml. No two are quite alike.', 'Ceramics',    c(64),  null,   38,  'live', 'mug7'],
  [house, 'The Everyday Tee',         'Heavyweight organic cotton, garment-dyed by hand. Our most returned-to basic.',         'Apparel',     c(95),  null,   120, 'live', 'tee4'],
  [loom,  'Lopapeysa Wool Sweater',   'Traditional Icelandic yoke sweater in undyed lopi wool. Warm enough to skip the coat.', 'Apparel',     c(420), c(480), 18,  'live', 'knit5'],
  [ember, 'Hammered Brass Tray',      'Hand-hammered brass catch-all for keys, cards and the small things that wander.',       'Home',        c(140), null,   26,  'live', 'tray3'],
  [fern,  'Cedar & Smoke Candle',     "Coconut-soy wax, fifty-five hour burn. Smells like a cabin you don't want to leave.",   'Home',        c(88),  null,   64,  'live', 'candle8'],
  [paper, 'Linen-Bound Notebook',     "A5, 192 pages of cream paper that won't bleed through. Lay-flat binding.",              'Stationery',  c(72),  null,   90,  'live', 'note2'],
  [house, 'Waxed Canvas Weekender',   'Waxed canvas and bridle leather, built to be handed down. Our house staple.',           'Accessories', c(285), null,   30,  'live', 'bag6'],
  [kiln,  'Glazed Serving Bowl',      'Wide low bowl in speckled clay — equally good for salad or fruit on the counter.',      'Ceramics',    c(128), null,   12,  'live', 'bowl9'],
  [loom,  'Merino Watch Cap',         'Ribbed merino beanie, double-folded. Itch-free and packs flat.',                        'Apparel',     c(110), null,   44,  'live', 'cap2'],
  [ember, 'Folded Leather Wallet',    'Vegetable-tanned leather, six cards plus notes. Ages to a deep honey patina.',          'Accessories', c(195), null,   33,  'live', 'wallet3'],
  [fern,  'Botanical Room Mist',      'Fig leaf and green stems in a fine-mist bottle — one spray resets a room.',            'Home',        c(54),  null,   110, 'live', 'mist5'],
  [house, 'Glazed Ceramic Planter',   'House-label planter with drainage and matching saucer, in three sizes.',               'Home',        c(76),  c(95),  44,  'live', 'planter4'],
  [paper, 'Weighted Brass Clip',      "A weighted brass clip that keeps the page you're on, open.",                            'Stationery',  c(38),  null,   75,  'live', 'clip1'],
  [loom,  'Hand-Knotted Wool Throw',  'Chunky undyed throw, fringed by hand. The one everyone fights over.',                   'Home',        c(360), null,   9,   'live', 'throw7'],
  [fern,  'Fig & Vetiver Wax Melts',  'Six unscented-wick-free melts for the burner. The slow way to scent a room.',           'Home',        c(32),  null,   140, 'live', 'melt3'],
  [house, 'Combed Cotton Socks · 3',  "House-label combed-cotton socks, reinforced heel and toe. The ones you'll look for.",   'Apparel',     c(58),  null,   88,  'live', 'socks2'],
];
for (const p of products) mkProd.run(...p);

// Search tags — shared with the 003 migration so live databases that were
// seeded before tags existed get the same backfill.
const { SEED_TAGS } = require('./migrations/003-seed-product-tags');
const setTags = db.prepare('UPDATE products SET tags=? WHERE image_seed=?');
for (const [seed, tags] of Object.entries(SEED_TAGS)) setTags.run(JSON.stringify(tags), seed);

// Etsy-style personalisation on a few pieces so the option is visible end to end:
// the mug requires it (monogram), the wallet and notebook offer it optionally.
const setPerso = db.prepare(`UPDATE products SET personalization_enabled=1, personalization_required=?,
  personalization_prompt=?, personalization_char_limit=? WHERE image_seed=?`);
setPerso.run(1, 'Initials to stamp on the base (up to 3 letters)', 3, 'mug7');
setPerso.run(0, 'Add a monogram — up to 4 letters, embossed by hand', 4, 'wallet3');
setPerso.run(0, 'A word or name for the cover, foil-pressed (max 20 characters)', 20, 'note2');

// A demo PAID order (normally created by checkout) so the managed payout flow
// has something to settle: a Kiln & Clay mug + an Ember wallet — both managed shops.
const mug = db.prepare("SELECT id, price_cents, shop_id, name FROM products WHERE image_seed='mug7'").get();
const wallet = db.prepare("SELECT id, price_cents, shop_id, name FROM products WHERE image_seed='wallet3'").get();
const demoSub = mug.price_cents + wallet.price_cents;
const demoDelivery = demoSub >= 50000 ? 0 : 2500;
const demoShip = JSON.stringify({ name: 'Layla Hassan', line: 'Apt 1204, Marina Gate 2', city: 'Dubai Marina, Dubai', country: 'United Arab Emirates', phone: '+971 50 123 4567' });
const demoOrder = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,currency,shipping_json,status,rail,title_transferred_at)
  VALUES (?,?,?,?,?,?,?, 'aed', ?, 'paid', 'consignment', datetime('now','-12 days'))`).run('TRV-SEED01', layla, 'layla@email.com', demoSub, demoDelivery, 900, demoSub + demoDelivery + 900, demoShip).lastInsertRowid;
const mkItem = db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,personalization) VALUES (?,?,?,?,?,?,?)');
mkItem.run(demoOrder, mug.id, mug.shop_id, mug.name, mug.price_cents, 1, 'LH');
mkItem.run(demoOrder, wallet.id, wallet.shop_id, wallet.name, wallet.price_cents, 1, '');

// Supplier ledger credits for the demo purchase (normally written by the
// payment webhook): Trove bought each supplier's items at list minus margin.
const fees = require('./fees');
const mkCredit = db.prepare(`INSERT INTO seller_balances (shop_id,order_id,type,amount_cents,created_at)
  VALUES (?,?, 'credit_sale', ?, datetime('now','-12 days'))`);
mkCredit.run(mug.shop_id, demoOrder, fees.split(mug.price_cents).net);
mkCredit.run(wallet.shop_id, demoOrder, fees.split(wallet.price_cents).net);

// Shipments for the demo order so tracking shows on both sides. Kiln's parcel
// was delivered 9 days ago — its 7-day return window has closed, so the next
// settlement run has an eligible credit out of the box. Ember still processing.
const mkShip = db.prepare("INSERT INTO shipments (order_id,shop_id,status,carrier,tracking_number,delivered_at,return_window_ends_at) VALUES (?,?,?,?,?,?,?)");
const mkEv = db.prepare("INSERT INTO shipment_events (shipment_id,status,note,created_at) VALUES (?,?,?,datetime('now',?))");
const kilnShip = mkShip.run(demoOrder, mug.shop_id, 'delivered', 'Quiqup', 'TRVX-4471902',
  db.prepare("SELECT datetime('now','-9 days') AS t").get().t,
  db.prepare("SELECT datetime('now','-2 days') AS t").get().t).lastInsertRowid;
mkEv.run(kilnShip, 'processing', 'Order received — preparing your items', '-12 days');
mkEv.run(kilnShip, 'shipped', 'Handed to the courier (Quiqup) · TRVX-4471902', '-10 days');
mkEv.run(kilnShip, 'delivered', 'Delivered (confirmed by courier)', '-9 days');
const emberShip = mkShip.run(demoOrder, wallet.shop_id, 'processing', '', '', null, null).lastInsertRowid;
mkEv.run(emberShip, 'processing', 'Order received — preparing your items', '-12 days');

console.log('Seeded: 8 users, 7 shops (1 pending approval), %d products, 1 demo paid order (2 shipments).', products.length + 1);
console.log('Suppliers: house, Kiln, Ember, Fern = consignment (weekly settlement, payout setup complete); Loom + Folio = connect tier (Rail B, no Stripe account attached).');
console.log('Kiln has one settlement-eligible credit (delivered 9 days ago, window closed).');
console.log('Logins (password demo1234): layla@email.com (buyer) · mara@kilnandclay.com (seller) · hello@trove.com (admin/house).');
