'use strict';
/**
 * Demo-data purge — empties a live database of everything that was only
 * ever there to demonstrate the site. It can keep shops, pieces and service
 * providers you name (each optional), and it always keeps every admin
 * account and the Trove Collection.
 *
 * Owner instructions: 2026-09-22 "apart from 1 shop with 1 product, and 1
 * service provider, remove all the test info"; 2026-10-15 "remove all the
 * test items & services & shops" (no keepers at all).
 *
 * plan(db, opts) is read-only and returns what run() would remove, so the
 * CLI (scripts/purge-demo.js) can show it before anything happens. run()
 * writes a VACUUM INTO backup first (src/backup.js), then deletes in one
 * transaction — children before parents, because several foreign keys here
 * carry no ON DELETE CASCADE (order_items.shop_id, shipments.shop_id,
 * seller_balances, settlement_items, return_requests.buyer_id,
 * return_collections.shipment_id, provider_payout_batches.provider_id …) —
 * and finally sweeps the upload and private folders the app writes of every
 * file no surviving row refers to.
 *
 * What survives: the Trove Collection (every is_house shop, its pieces and
 * its owner's account — F258: an earlier version removed it), the kept
 * shops (profile, photo, payout setup and documents untouched) with their
 * pieces — only the named ones when --keep-product is given — the kept
 * providers with their listings, admin accounts, the keepers' accounts,
 * site_content (homepage picks pruned to the survivors), schema_migrations,
 * and the owner's records that are not demo data: contact messages, the admin
 * audit log, the privacy log, blocked customers, background-job runs.
 *
 * What goes: every other user, shop, piece, provider and listing; ALL
 * orders, shipments, returns, reviews, bookings, payouts, settlements,
 * ledger rows, purchase notes, webhook receipts, addresses, analytics,
 * search log and sessions (everyone signs in again), and the Arabic
 * translations of anything removed.
 */
const fs = require('fs');
const path = require('path');

const TABLES_WIPED = [
  // children first — order matters for the foreign keys without cascade
  // (reviews and seller_balances point at orders, return items at order items,
  // return collections at shipments, payout batches at providers …)
  'return_collections', 'return_request_items', 'return_requests', 'reviews',
  'purchase_notes', 'settlement_items', 'seller_balances', 'settlements', 'payouts',
  'shipment_events', 'shipments', 'order_cancellation_items', 'order_cancellations', 'order_items', 'orders', 'webhook_events',
  'analytics_events', 'search_log', 'provider_credits', 'provider_payout_batches', 'service_bookings',
  'addresses', 'sessions',
];

/* The folders the app writes (src/uploads.js, settlement.js); nothing else
   under uploads/ or private/ is ever touched. */
const UPLOAD_FOLDERS = ['shops', 'products', 'reviews', 'services'];
const PRIVATE_FOLDERS = ['ids', 'licenses', 'returns', 'purchase-notes'];

/* Translated entities (src/translate.js ENTITIES) and the table each lives in. */
const TRANSLATED = { product: 'products', shop: 'shops', service: 'services', provider: 'service_providers', review: 'reviews' };

function uploadsDir() {
  return process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
}
function privateDir() {
  return process.env.PRIVATE_DIR || path.join(uploadsDir(), '..', 'private');
}

function parseList(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

// Tables come and go with migrations (the sessions table is even created by
// session-store.js at boot), so only the ones this database has are touched.
function haveTables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}
function existingTables(db) {
  const have = haveTables(db);
  return TABLES_WIPED.filter((t) => have.has(t));
}

const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const listOf = (v) => (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);

/** Resolve --keep-* values (slugs or numeric ids, comma-separated) to rows. Throws on a miss. */
function resolveKeepers(db, opts = {}) {
  const out = { shops: [], products: [], providers: [], house: [], users: new Set() };
  const byKey = (table, key, what) => {
    const row = /^\d+$/.test(key)
      ? db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(key))
      : db.prepare(`SELECT * FROM ${table} WHERE slug = ?`).get(key);
    if (!row) throw new Error(`No ${what} matches "${key}" (use the slug or the id)`);
    return row;
  };

  if (given(opts.keepShop)) {
    for (const key of listOf(opts.keepShop)) out.shops.push(byKey('shops', key, 'shop'));
  }

  if (given(opts.keepProduct)) {
    if (!out.shops.length) throw new Error('--keep-product needs --keep-shop (the piece must belong to a kept shop)');
    for (const key of listOf(opts.keepProduct)) {
      if (!/^\d+$/.test(key)) throw new Error('--keep-product takes piece ids (numbers)');
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(key));
      if (!p) throw new Error(`No piece has id ${key}`);
      if (!out.shops.some((s) => s.id === p.shop_id)) {
        throw new Error(`Piece ${key} "${p.name}" belongs to shop ${p.shop_id}, not to ${out.shops.map((s) => `"${s.slug}"`).join(' or ')}`);
      }
      out.products.push(p);
    }
  }

  if (given(opts.keepProvider)) {
    for (const key of listOf(opts.keepProvider)) out.providers.push(byKey('service_providers', key, 'service provider'));
  }

  // The Trove Collection is the owner's own shop, never demo data (F258).
  out.house = db.prepare('SELECT * FROM shops WHERE is_house = 1 ORDER BY id').all();

  for (const s of [...out.shops, ...out.house]) out.users.add(s.user_id);
  for (const p of out.providers) out.users.add(p.user_id);

  // Admins are never removed — the owner's account is the one thing that can
  // put the site back together. ADMIN_EMAIL is honoured even if that row is
  // (wrongly) not an admin yet.
  for (const u of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) out.users.add(u.id);
  const adminEmail = String(opts.adminEmail !== undefined ? opts.adminEmail : (process.env.ADMIN_EMAIL || '')).trim().toLowerCase();
  if (adminEmail) {
    const u = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(adminEmail);
    if (u) out.users.add(u.id);
  }
  for (const email of opts.keepUsers || []) {
    const u = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(String(email).trim().toLowerCase());
    if (!u) throw new Error(`--keep-user: no account with email ${email}`);
    out.users.add(u.id);
  }
  return out;
}

/** The ids that survive: shops (kept + house), pieces, providers. */
function survivors(db, keep) {
  const shops = new Set([...keep.shops, ...keep.house].map((s) => s.id));
  const products = new Set();
  // A kept shop keeps the named pieces, or all of its pieces when none are named.
  const named = new Set(keep.products.map((p) => p.id));
  for (const s of keep.shops) {
    for (const { id } of db.prepare('SELECT id FROM products WHERE shop_id = ?').all(s.id)) {
      if (!named.size || named.has(id)) products.add(id);
    }
  }
  for (const s of keep.house) {
    for (const { id } of db.prepare('SELECT id FROM products WHERE shop_id = ?').all(s.id)) products.add(id);
  }
  const providers = new Set(keep.providers.map((p) => p.id));
  return { shops, products, providers };
}

const inList = (set) => (set.size ? `(${[...set].join(',')})` : '(-1)');

/** Everything run() would remove, without touching anything. */
function plan(db, opts = {}) {
  const keep = resolveKeepers(db, opts);
  const live = survivors(db, keep);

  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const p = {
    keep: {
      shops: keep.shops.map((s) => ({ id: s.id, slug: s.slug, name: s.name })),
      house: keep.house.map((s) => ({ id: s.id, slug: s.slug, name: s.name, pieces: count('SELECT COUNT(*) n FROM products WHERE shop_id = ?', s.id) })),
      products: db.prepare(`SELECT id, name, shop_id FROM products WHERE id IN ${inList(live.products)} ORDER BY id`).all(),
      providers: keep.providers.map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
      users: db.prepare(`SELECT id, email, role FROM users WHERE id IN ${inList(keep.users)} ORDER BY id`).all(),
    },
    users: db.prepare(`SELECT id, email, role FROM users WHERE id NOT IN ${inList(keep.users)} ORDER BY id`).all(),
    shops: db.prepare(`SELECT id, slug, name, status FROM shops WHERE id NOT IN ${inList(live.shops)} ORDER BY id`).all(),
    products: db.prepare(`SELECT id, name, shop_id FROM products WHERE id NOT IN ${inList(live.products)} ORDER BY id`).all(),
    providers: db.prepare(`SELECT id, slug, name, status FROM service_providers WHERE id NOT IN ${inList(live.providers)} ORDER BY id`).all(),
    services: count(`SELECT COUNT(*) n FROM services WHERE provider_id NOT IN ${inList(live.providers)}`),
    tables: {},
  };
  for (const t of existingTables(db)) p.tables[t] = count(`SELECT COUNT(*) n FROM ${t}`);
  p.translations = haveTables(db).has('translations') ? translationOrphans(db, live, true) : 0;
  p.content = contentPrunePlan(db, live).map((c) => c.section);
  p.files = filePlan(db, live);
  return p;
}

/* ---- Arabic translations of removed rows (src/translate.js) ---- */
function translationOrphans(db, live, countOnly) {
  // Reviews are all removed; the rest survive exactly as their tables will.
  const keepIds = {
    product: live.products, shop: live.shops, provider: live.providers,
    service: new Set(db.prepare(`SELECT id FROM services WHERE provider_id IN ${inList(live.providers)}`).all().map((r) => r.id)),
    review: new Set(),
  };
  let n = 0;
  for (const entity of Object.keys(TRANSLATED)) {
    for (const t of ['translations', 'translation_queue']) {
      const sql = `${countOnly ? 'SELECT COUNT(*) n FROM' : 'DELETE FROM'} ${t} WHERE entity = ? AND CAST(entity_id AS INTEGER) NOT IN ${inList(keepIds[entity])}`;
      if (countOnly) { if (t === 'translations') n += db.prepare(sql).get(entity).n; } else db.prepare(sql).run(entity);
    }
  }
  return n;
}

/* ---- site_content: homepage picks must only name survivors ---- */
function contentPrunePlan(db, live) {
  const keptSlugs = new Set(db.prepare(`SELECT slug FROM shops WHERE id IN ${inList(live.shops)}`).all().map((s) => s.slug));
  const changes = [];
  for (const row of db.prepare('SELECT section, value FROM site_content').all()) {
    let obj;
    try { obj = JSON.parse(row.value); } catch (_) { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    let changed = false;
    if (Array.isArray(obj.productIds)) {
      const next = obj.productIds.filter((id) => live.products.has(Number(id)));
      if (next.length !== obj.productIds.length) { obj.productIds = next; changed = true; }
    }
    if (Array.isArray(obj.shopSlugs)) {
      const next = obj.shopSlugs.filter((s) => keptSlugs.has(s));
      if (next.length !== obj.shopSlugs.length) { obj.shopSlugs = next; changed = true; }
    }
    if (obj.crops && typeof obj.crops === 'object' && !Array.isArray(obj.crops)) {
      const next = {};
      for (const [id, crop] of Object.entries(obj.crops)) if (live.products.has(Number(id))) next[id] = crop;
      if (Object.keys(next).length !== Object.keys(obj.crops).length) { obj.crops = next; changed = true; }
    }
    if (changed) changes.push({ section: row.section, value: JSON.stringify(obj) });
  }
  return changes;
}

/* ---- files: anything in the app's folders that no survivor refers to ---- */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function survivingFileRefs(db, live) {
  // Computed as if the deletes had happened: only the survivors' rows count.
  const ups = new Set();   // public /uploads/... urls
  const priv = new Set();  // absolute paths under PRIVATE_DIR
  const privRoot = privateDir();
  const addPrivate = (p) => { if (p) priv.add(path.resolve(path.isAbsolute(p) ? p : path.join(privRoot, p))); };
  for (const s of db.prepare(`SELECT * FROM shops WHERE id IN ${inList(live.shops)}`).all()) {
    if (s.image) ups.add(s.image);
    addPrivate(s.license_image); addPrivate(s.eid_front_file); addPrivate(s.eid_back_file);
  }
  for (const pr of db.prepare(`SELECT images FROM products WHERE id IN ${inList(live.products)}`).all()) {
    for (const u of parseList(pr.images)) ups.add(u);
  }
  // A kept provider's service photos and video cover frames.
  for (const sv of db.prepare(`SELECT media FROM services WHERE provider_id IN ${inList(live.providers)}`).all()) {
    for (const m of parseList(sv.media)) { if (m && m.url && m.type === 'image') ups.add(m.url); if (m && m.poster) ups.add(m.poster); }
  }
  // Anything the site's own copy points at (an image in Site content) stays.
  const content = db.prepare('SELECT value FROM site_content').all().map((r) => r.value).join('\n');
  // reviews, returns and purchase notes are all wiped, so nothing of theirs survives.
  return { ups, priv, content };
}

function filePlan(db, live) {
  const { ups, priv, content } = survivingFileRefs(db, live);
  const upRoot = path.resolve(uploadsDir());
  const privRoot = path.resolve(privateDir());
  const remove = [];
  // A kept photo's 480 px copy (<name>.w480.<ext>, see uploads.smallOf) stays with it.
  const keptStems = new Set([...ups].map((u) => u.replace(/\.(jpg|png|webp)$/, '')));
  const isKeptSmall = (url) => { const m = /^(.*)\.w480\.(jpg|png|webp)$/.exec(url); return !!m && keptStems.has(m[1]); };
  for (const folder of UPLOAD_FOLDERS) {
    for (const f of walk(path.join(upRoot, folder))) {
      const url = '/uploads/' + path.relative(upRoot, f).split(path.sep).join('/');
      if (!ups.has(url) && !isKeptSmall(url) && !content.includes(url)) remove.push(f);
    }
  }
  for (const folder of PRIVATE_FOLDERS) {
    for (const f of walk(path.join(privRoot, folder))) {
      if (!priv.has(path.resolve(f))) remove.push(f);
    }
  }
  return remove;
}

/** Back up, then remove. Returns the plan that was executed plus the backup file. */
function run(db, opts = {}) {
  const keep = resolveKeepers(db, opts);
  const live = survivors(db, keep);
  const p = plan(db, opts);
  const backup = opts.backup === false ? null : require('./backup').run().file;

  const contentChanges = contentPrunePlan(db, live);
  const tables = existingTables(db);
  const translated = haveTables(db).has('translations');

  db.transaction(() => {
    if (translated) translationOrphans(db, live, false);
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM services WHERE provider_id NOT IN ${inList(live.providers)}`).run();
    // Their videos live in R2, not on this disk: hand them to the hourly
    // never-saved sweep (service-media.js sweepPending), which deletes them there.
    if (haveTables(db).has('service_media_uploads')) {
      db.prepare(`UPDATE service_media_uploads SET attached_at = NULL, created_at = '2000-01-01 00:00:00' WHERE provider_id NOT IN ${inList(live.providers)}`).run();
    }
    db.prepare(`DELETE FROM service_providers WHERE id NOT IN ${inList(live.providers)}`).run();
    db.prepare(`DELETE FROM products WHERE id NOT IN ${inList(live.products)}`).run();
    db.prepare(`DELETE FROM shops WHERE id NOT IN ${inList(live.shops)}`).run();
    db.prepare(`DELETE FROM users WHERE id NOT IN ${inList(keep.users)}`).run();
    const upd = db.prepare("UPDATE site_content SET value = ?, updated_at = datetime('now') WHERE section = ?");
    for (const c of contentChanges) upd.run(c.value, c.section);
  })();

  const removedFiles = [];
  for (const f of p.files) {
    try { fs.unlinkSync(f); removedFiles.push(f); } catch (_) { /* already gone */ }
  }
  return { ...p, backup, removedFiles };
}

module.exports = { plan, run, resolveKeepers, TABLES_WIPED, UPLOAD_FOLDERS, PRIVATE_FOLDERS };
