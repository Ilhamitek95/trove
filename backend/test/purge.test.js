'use strict';
/**
 * Demo-data purge (src/purge.js): keep one shop, one piece, one provider and
 * the admins; everything else goes, files included, after a backup.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { testEnv } = require('./helpers');
testEnv({
  ADMIN_EMAIL: 'owner@example.com',
  BACKUPS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'trove-purge-backups-')),
});
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
require('../src/session-store'); // the app creates the sessions table at boot
require('../src/seed');          // demo catalogue: 7 shops, 22 pieces, 7 providers, 1 paid order …
const purge = require('../src/purge');

const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const UP = process.env.UPLOADS_DIR;
const PRIV = process.env.PRIVATE_DIR;
function touch(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file; }

test('keeps one shop, one piece, one provider and the admins - nothing else survives', () => {
  // Mirror prod: the owner is the only admin; the house account is a plain seller.
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@example.com','x','Owner','admin')").run();
  db.prepare("UPDATE users SET role='seller' WHERE email='hello@trove.com'").run();
  const kiln = db.prepare("SELECT * FROM shops WHERE slug='kiln-and-clay'").get();
  const loom = db.prepare("SELECT * FROM shops WHERE slug='northbound-loom'").get();
  const mug = db.prepare("SELECT * FROM products WHERE name='Reeded Stoneware Mug'").get();
  const bowl = db.prepare("SELECT * FROM products WHERE name='Glazed Serving Bowl'").get();
  assert.equal(mug.shop_id, kiln.id);
  assert.equal(bowl.shop_id, kiln.id, 'the kept shop has a second piece that must go');

  // Files: the kept shop's photo and the kept piece's photo survive; a removed
  // piece's photo, a removed shop's Emirates ID scan and an orphan do not.
  const keepShopImg = touch(path.join(UP, 'shops', 'shop-kiln.jpg'));
  const keepProdImg = touch(path.join(UP, 'products', 'prod-mug.jpg'));
  const goneProdImg = touch(path.join(UP, 'products', 'prod-bowl.jpg'));
  const goneEid = touch(path.join(PRIV, 'ids', 'shop-loom-front.enc'));
  const orphan = touch(path.join(UP, 'reviews', 'orphan.jpg'));
  db.prepare('UPDATE shops SET image=? WHERE id=?').run('/uploads/shops/shop-kiln.jpg', kiln.id);
  db.prepare('UPDATE products SET images=? WHERE id=?').run(JSON.stringify(['/uploads/products/prod-mug.jpg']), mug.id);
  db.prepare('UPDATE products SET images=? WHERE id=?').run(JSON.stringify(['/uploads/products/prod-bowl.jpg']), bowl.id);
  db.prepare('UPDATE shops SET eid_front_file=? WHERE id=?').run('ids/shop-loom-front.enc', loom.id);

  // Homepage picks that name pieces and makers about to go.
  db.prepare("INSERT INTO site_content (section, value) VALUES ('home.weekly', ?)").run(JSON.stringify({
    eyebrow: 'x', productIds: [mug.id, bowl.id], crops: { [mug.id]: { x: 50, y: 50, z: 1 }, [bowl.id]: { x: 1, y: 1, z: 2 } },
  }));
  db.prepare("INSERT INTO site_content (section, value) VALUES ('home.makers', ?)").run(JSON.stringify({
    shopSlugs: ['kiln-and-clay', 'northbound-loom'],
  }));
  db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES ('s1', '{}', 9999999999999)").run();
  db.prepare("INSERT INTO search_log (q, results) VALUES ('mug', 1)").run();

  const opts = { keepShop: 'kiln-and-clay', keepProduct: String(mug.id), keepProvider: 'noor-letters' };
  const before = { users: count('users'), shops: count('shops'), products: count('products'), providers: count('service_providers') };
  assert.ok(before.shops >= 7 && before.products >= 10, 'seed in place');
  assert.equal(before.providers, 7);
  assert.equal(count('orders'), 1);

  // A piece from another shop is refused up front.
  assert.throws(() => purge.plan(db, { keepShop: 'northbound-loom', keepProduct: String(mug.id) }), /belongs to shop/);

  // plan() is read-only.
  const p = purge.plan(db, opts);
  assert.equal(count('shops'), before.shops);
  assert.equal(count('users'), before.users);
  assert.equal(p.keep.shop.slug, 'kiln-and-clay');
  assert.equal(p.keep.product.id, mug.id);
  assert.equal(p.keep.provider.slug, 'noor-letters');
  assert.deepEqual(p.keep.users.map((u) => u.email).sort(), ['mara@kilnandclay.com', 'noor@noorletters.ae', 'owner@example.com']);
  assert.equal(p.shops.length, before.shops - 1);
  assert.equal(p.products.length, before.products - 1);
  assert.equal(p.providers.length, 6);
  assert.ok(p.users.some((u) => u.email === 'hello@trove.com'), 'the demoted house account goes');
  assert.ok(p.users.some((u) => u.email === 'layla@email.com'), 'the demo buyer goes');
  assert.deepEqual([...p.content].sort(), ['home.makers', 'home.weekly']);
  assert.deepEqual(p.files.map((f) => path.basename(f)).sort(), ['orphan.jpg', 'prod-bowl.jpg', 'shop-loom-front.enc']);
  assert.ok(p.tables.orders === 1 && p.tables.sessions === 1 && p.tables.search_log === 1);

  const r = purge.run(db, opts);
  assert.ok(r.backup && fs.existsSync(r.backup), 'backup written before removing anything');
  assert.ok(r.backup.startsWith(process.env.BACKUPS_DIR));
  assert.ok(fs.statSync(r.backup).size > 0);

  // Survivors.
  assert.deepEqual(db.prepare('SELECT slug FROM shops').all().map((s) => s.slug), ['kiln-and-clay']);
  assert.deepEqual(db.prepare('SELECT id FROM products').all().map((x) => x.id), [mug.id]);
  assert.deepEqual(db.prepare('SELECT slug FROM service_providers').all().map((x) => x.slug), ['noor-letters']);
  assert.equal(count('services'), 4, "the kept provider's listings stay");
  assert.deepEqual(db.prepare('SELECT email FROM users ORDER BY email').all().map((u) => u.email),
    ['mara@kilnandclay.com', 'noor@noorletters.ae', 'owner@example.com']);
  for (const t of purge.TABLES_WIPED) assert.equal(count(t), 0, `${t} emptied`);
  assert.equal(db.prepare('SELECT image FROM shops WHERE id=?').get(kiln.id).image, '/uploads/shops/shop-kiln.jpg', 'kept shop untouched');

  // Picks pruned to the survivors, other copy untouched.
  const weekly = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='home.weekly'").get().value);
  assert.deepEqual(weekly.productIds, [mug.id]);
  assert.deepEqual(Object.keys(weekly.crops), [String(mug.id)]);
  assert.equal(weekly.eyebrow, 'x');
  const makers = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='home.makers'").get().value);
  assert.deepEqual(makers.shopSlugs, ['kiln-and-clay']);

  // Files.
  assert.ok(fs.existsSync(keepShopImg) && fs.existsSync(keepProdImg));
  assert.ok(!fs.existsSync(goneProdImg) && !fs.existsSync(goneEid) && !fs.existsSync(orphan));
  assert.deepEqual(r.removedFiles.map((f) => path.basename(f)).sort(), ['orphan.jpg', 'prod-bowl.jpg', 'shop-loom-front.enc']);

  // Referential integrity intact; a second pass finds nothing left to do.
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const again = purge.plan(db, opts);
  assert.equal(again.users.length + again.shops.length + again.products.length + again.providers.length + again.files.length, 0);
  assert.equal(again.services, 0);
});

test('keeper mistakes are refused before anything happens', () => {
  assert.throws(() => purge.plan(db, { keepShop: 'no-such-shop' }), /No shop matches/);
  assert.throws(() => purge.plan(db, { keepShop: 'kiln-and-clay', keepProduct: '999999' }), /No piece has id/);
  const piece = db.prepare('SELECT id FROM products').get();
  assert.throws(() => purge.plan(db, { keepProduct: String(piece.id) }), /needs --keep-shop/);
  assert.throws(() => purge.plan(db, { keepProvider: 'nobody' }), /No service provider matches/);
  assert.throws(() => purge.plan(db, { keepUsers: ['ghost@example.com'] }), /no account with email/);
  assert.equal(count('shops'), 1, 'nothing changed');
});
