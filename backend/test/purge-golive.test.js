'use strict';
/**
 * The go-live purge (owner 2026-10-15: "remove all the test items & services
 * & shops"): no keepers at all. Only the admins, the Trove Collection with
 * its pieces, and the owner's own records (contact messages, audit log)
 * survive, and every table added since the first purge is handled — payout
 * batches and return collections point at providers and shipments with no
 * ON DELETE CASCADE, and Arabic translations of removed rows go too.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { testEnv } = require('./helpers');
testEnv({
  ADMIN_EMAIL: 'owner@example.com',
  BACKUPS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'trove-purge-golive-')),
});
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
require('../src/session-store');
require('../src/seed');
const purge = require('../src/purge');

const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const UP = process.env.UPLOADS_DIR;
const PRIV = process.env.PRIVATE_DIR;
function touch(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file; }

test('no keepers: everything demo goes; the admins, the Trove Collection and the owner’s records stay', () => {
  // Prod's shape: the Collection belongs to the owner's admin account.
  const owner = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@example.com','x','Owner','admin')").run().lastInsertRowid;
  db.prepare("UPDATE users SET role='seller' WHERE email='hello@trove.com'").run();
  const house = db.prepare('SELECT * FROM shops WHERE is_house = 1').get();
  db.prepare('UPDATE shops SET user_id = ? WHERE id = ?').run(owner, house.id);
  const housePieces = db.prepare('SELECT id FROM products WHERE shop_id = ? ORDER BY id').all(house.id).map((x) => x.id);
  const kiln = db.prepare("SELECT * FROM shops WHERE slug='kiln-and-clay'").get();
  const mug = db.prepare("SELECT * FROM products WHERE name='Reeded Stoneware Mug'").get();
  const noor = db.prepare("SELECT * FROM service_providers WHERE slug='noor-letters'").get();
  const service = db.prepare('SELECT * FROM services WHERE provider_id = ?').get(noor.id);

  // Rows in the tables added since the first purge.
  db.prepare("INSERT INTO provider_payout_batches (provider_id, reference, amount_cents) VALUES (?, 'TRV-SVC-1', 9000)").run(noor.id);
  const order = db.prepare('SELECT * FROM orders').get();
  const ship = db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(order.id);
  const req = db.prepare("INSERT INTO return_requests (order_id, buyer_id, reason, status) VALUES (?, ?, 'changed-mind', 'approved')").run(order.id, order.buyer_id).lastInsertRowid;
  db.prepare('INSERT INTO return_collections (request_id, shipment_id, shop_id) VALUES (?, ?, ?)').run(req, ship.id, ship.shop_id);
  db.prepare("INSERT INTO identity_sessions (shop_id, session_id, consent_at) VALUES (?, 'didit-1', datetime('now'))").run(kiln.id);
  const tr = db.prepare("INSERT INTO translations (entity, entity_id, field, lang, text, source_hash) VALUES (?, ?, 'name', 'ar', 'x', 'h')");
  tr.run('product', String(mug.id));
  tr.run('product', String(housePieces[0]));
  tr.run('shop', String(kiln.id));
  tr.run('shop', String(house.id));
  tr.run('provider', String(noor.id));
  tr.run('service', String(service.id));
  tr.run('content', 'sell.faq');
  db.prepare("INSERT INTO translation_queue (entity, entity_id, lang) VALUES ('product', ?, 'ar')").run(String(mug.id));
  db.prepare("INSERT INTO contact_messages (name, email, message) VALUES ('A shopper', 'a@example.com', 'Hello')").run();
  db.prepare("INSERT INTO admin_actions (action) VALUES ('Shop approved')").run();

  // Files: the Collection's photo and an image the site copy uses stay; a
  // folder the purge does not own is never walked.
  const houseImg = touch(path.join(UP, 'shops', 'shop-house.jpg'));
  db.prepare('UPDATE shops SET image=? WHERE id=?').run('/uploads/shops/shop-house.jpg', house.id);
  const cmsImg = touch(path.join(UP, 'products', 'cms-hero.jpg'));
  db.prepare("INSERT INTO site_content (section, value) VALUES ('home.hero', ?)").run(JSON.stringify({ image: '/uploads/products/cms-hero.jpg', productIds: [mug.id, housePieces[0]] }));
  const kilnImg = touch(path.join(UP, 'shops', 'shop-kiln.jpg'));
  db.prepare('UPDATE shops SET image=? WHERE id=?').run('/uploads/shops/shop-kiln.jpg', kiln.id);
  const notOurs = touch(path.join(UP, 'brand', 'wordmark.png'));
  const licence = touch(path.join(PRIV, 'licenses', 'license-9.enc'));

  const p = purge.plan(db, {});
  assert.deepEqual(p.keep.shops, []);
  assert.deepEqual(p.keep.house.map((s) => s.slug), ['trove-collection']);
  assert.deepEqual(p.keep.products.map((x) => x.id), housePieces);
  assert.deepEqual(p.keep.users.map((u) => u.email), ['owner@example.com']);
  assert.ok(p.users.some((u) => u.email === 'hello@trove.com'), 'an account that no longer owns the Collection goes');
  assert.equal(p.providers.length, 7, 'every provider goes');
  assert.ok(p.translations >= 4);

  purge.run(db, {});
  assert.deepEqual(db.prepare('SELECT slug FROM shops').all().map((s) => s.slug), ['trove-collection']);
  assert.deepEqual(db.prepare('SELECT id FROM products ORDER BY id').all().map((x) => x.id), housePieces);
  assert.equal(count('service_providers'), 0);
  assert.equal(count('services'), 0);
  assert.deepEqual(db.prepare('SELECT email FROM users').all().map((u) => u.email), ['owner@example.com']);
  for (const t of purge.TABLES_WIPED) assert.equal(count(t), 0, `${t} emptied`);
  assert.equal(count('identity_sessions'), 0, 'went with their shop');

  // Translations: only the survivors' and the site copy's remain.
  const left = db.prepare('SELECT entity, entity_id FROM translations ORDER BY entity, entity_id').all().map((r) => `${r.entity}:${r.entity_id}`);
  assert.deepEqual(left, ['content:sell.faq', `product:${housePieces[0]}`, `shop:${house.id}`]);
  assert.equal(count('translation_queue'), 0);

  // The owner's own records are not demo data.
  assert.equal(count('contact_messages'), 1);
  assert.equal(count('admin_actions'), 1);

  // Homepage picks name only survivors; files.
  const hero = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='home.hero'").get().value);
  assert.deepEqual(hero.productIds, [housePieces[0]]);
  assert.ok(fs.existsSync(houseImg) && fs.existsSync(cmsImg) && fs.existsSync(notOurs));
  assert.ok(!fs.existsSync(kilnImg) && !fs.existsSync(licence));

  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const again = purge.plan(db, {});
  assert.equal(again.users.length + again.shops.length + again.products.length + again.providers.length + again.files.length + again.translations, 0);
});
