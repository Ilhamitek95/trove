'use strict';
/** Seeds demo data that mirrors the front-end. Run: npm run seed */
const db = require('./db');
const { hashPassword } = require('./middleware');

const c = (aed) => Math.round(aed * 100);

db.exec('DELETE FROM order_items; DELETE FROM orders; DELETE FROM products; DELETE FROM addresses; DELETE FROM shops; DELETE FROM users;');

const mkUser = db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)');
const mkShop = db.prepare('INSERT INTO shops (user_id,name,slug,bio,location,color,is_house) VALUES (?,?,?,?,?,?,?)');
const mkProd = db.prepare(`INSERT INTO products (shop_id,name,description,category,price_cents,compare_at_cents,stock,status,image_seed) VALUES (?,?,?,?,?,?,?,?,?)`);
const pw = hashPassword('demo1234');

// Buyer
const layla = mkUser.run('layla@email.com', pw, 'Layla Hassan', 'buyer').lastInsertRowid;
db.prepare('INSERT INTO addresses (user_id,label,name,line,city,is_default) VALUES (?,?,?,?,?,1)')
  .run(layla, 'Home', 'Layla Hassan', 'Apt 1204, Marina Gate 2', 'Dubai Marina, Dubai');

// Platform / house label
const admin = mkUser.run('hello@trove.com', pw, 'Trove', 'admin').lastInsertRowid;
const house = mkShop.run(admin, 'trove label', 'trove-label', 'Our own line, made well.', 'In-house · Dubai', '#262321', 1).lastInsertRowid;

// Seller
const mara = mkUser.run('mara@kilnandclay.com', pw, 'Mara', 'seller').lastInsertRowid;
const kiln = mkShop.run(mara, 'Kiln & Clay', 'kiln-and-clay', 'Small-batch stoneware, thrown by hand.', 'Lisbon, Portugal', '#A98B7D', 0).lastInsertRowid;

const products = [
  [house, 'The Everyday Tee', 'Heavyweight organic cotton, garment-dyed.', 'Apparel', c(95), null, 120, 'live', 'tee4'],
  [house, 'Waxed Canvas Weekender', 'Waxed canvas and bridle leather.', 'Accessories', c(285), null, 30, 'live', 'bag6'],
  [house, 'Glazed Ceramic Planter', 'Drainage and matching saucer.', 'Home', c(76), c(95), 44, 'live', 'planter4'],
  [kiln, 'Reeded Stoneware Mug', 'Hand-thrown, reactive matte glaze. 320ml.', 'Ceramics', c(64), null, 38, 'live', 'mug7'],
  [kiln, 'Glazed Serving Bowl', 'Wide low bowl in speckled clay.', 'Ceramics', c(128), null, 12, 'live', 'bowl9'],
  [kiln, 'Stoneware Vase · Tall', 'A quiet centrepiece.', 'Home', c(140), null, 7, 'live', 'vase5'],
  [kiln, 'Glazed Spoon Rest', 'A small, useful thing.', 'Home', c(34), null, 52, 'draft', 'spoon1'],
];
for (const p of products) mkProd.run(...p);

console.log('Seeded: 3 users (layla@ / mara@ / hello@, password demo1234), 2 shops, %d products.', products.length);
