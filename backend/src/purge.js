'use strict';
/**
 * Demo-data purge — empties a live database of everything that was only
 * ever there to demonstrate the site, keeping ONE shop with ONE piece and
 * ONE service provider (each optional) plus every admin account.
 *
 * Owner instruction (2026-09-22): "apart from 1 shop with 1 product, and
 * 1 service provider, remove all the test info."
 *
 * plan(db, opts) is read-only and returns what run() would remove, so the
 * CLI (scripts/purge-demo.js) can show it before anything happens. run()
 * writes a VACUUM INTO backup first (src/backup.js), then deletes in one
 * transaction — children before parents, because several foreign keys here
 * carry no ON DELETE CASCADE (order_items.shop_id, shipments.shop_id,
 * seller_balances, settlement_items, return_requests.buyer_id …) — and
 * finally sweeps the upload and private folders of every file no surviving
 * row refers to.
 *
 * What survives: the kept shop (its profile, photo, payout setup and
 * documents untouched), the kept piece, the kept provider with its live
 * listings, admin accounts, the two keepers' accounts, site_content (with
 * homepage picks pruned to the survivors), schema_migrations.
 *
 * What goes: every other user, shop, piece, provider and listing; ALL
 * orders, shipments, returns, reviews, bookings, payouts, settlements,
 * ledger rows, purchase notes, webhook receipts, addresses, analytics,
 * search log and sessions (everyone signs in again).
 */
const fs = require('fs');
const path = require('path');

const TABLES_WIPED = [
  // children first — order matters for the foreign keys without cascade
  // (reviews and seller_balances point at orders, return items at order items …)
  'return_request_items', 'return_requests', 'reviews',
  'purchase_notes', 'settlement_items', 'seller_balances', 'settlements', 'payouts',
  'shipment_events', 'shipments', 'order_items', 'orders', 'webhook_events',
  'analytics_events', 'search_log', 'service_bookings',
  'addresses', 'sessions',
];

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

// The sessions table is created by session-store.js when the app boots, so a
// database the server has never opened may not have it yet.
function existingTables(db) {
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  return TABLES_WIPED.filter((t) => have.has(t));
}

const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** Resolve --keep-* values (slug or numeric id) to rows. Throws on a miss. */
function resolveKeepers(db, opts = {}) {
  const out = { shop: null, product: null, provider: null, users: new Set() };

  if (given(opts.keepShop)) {
    const key = String(opts.keepShop).trim();
    out.shop = /^\d+$/.test(key)
      ? db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(key))
      : db.prepare('SELECT * FROM shops WHERE slug = ?').get(key);
    if (!out.shop) throw new Error(`No shop matches "${key}" (use the slug or the id)`);
    out.users.add(out.shop.user_id);
  }

  if (given(opts.keepProduct)) {
    const key = String(opts.keepProduct).trim();
    if (!/^\d+$/.test(key)) throw new Error('--keep-product takes the piece id (a number)');
    out.product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(key));
    if (!out.product) throw new Error(`No piece has id ${key}`);
    if (!out.shop) throw new Error('--keep-product needs --keep-shop (the piece must belong to the kept shop)');
    if (out.product.shop_id !== out.shop.id) {
      throw new Error(`Piece ${key} "${out.product.name}" belongs to shop ${out.product.shop_id}, not to "${out.shop.slug}"`);
    }
  }

  if (given(opts.keepProvider)) {
    const key = String(opts.keepProvider).trim();
    out.provider = /^\d+$/.test(key)
      ? db.prepare('SELECT * FROM service_providers WHERE id = ?').get(Number(key))
      : db.prepare('SELECT * FROM service_providers WHERE slug = ?').get(key);
    if (!out.provider) throw new Error(`No service provider matches "${key}" (use the slug or the id)`);
    out.users.add(out.provider.user_id);
  }

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

const inList = (set) => (set.size ? `(${[...set].join(',')})` : '(-1)');

/** Everything run() would remove, without touching anything. */
function plan(db, opts = {}) {
  const keep = resolveKeepers(db, opts);
  const keptShopId = keep.shop ? keep.shop.id : -1;
  const keptProductId = keep.product ? keep.product.id : -1;
  const keptProviderId = keep.provider ? keep.provider.id : -1;

  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const p = {
    keep: {
      shop: keep.shop ? { id: keep.shop.id, slug: keep.shop.slug, name: keep.shop.name } : null,
      product: keep.product ? { id: keep.product.id, name: keep.product.name } : null,
      provider: keep.provider ? { id: keep.provider.id, slug: keep.provider.slug, name: keep.provider.name } : null,
      users: db.prepare(`SELECT id, email, role FROM users WHERE id IN ${inList(keep.users)} ORDER BY id`).all(),
    },
    users: db.prepare(`SELECT id, email, role FROM users WHERE id NOT IN ${inList(keep.users)} ORDER BY id`).all(),
    shops: db.prepare('SELECT id, slug, name, is_house FROM shops WHERE id != ? ORDER BY id').all(keptShopId),
    products: db.prepare('SELECT id, name, shop_id FROM products WHERE id != ? ORDER BY id').all(keptProductId),
    providers: db.prepare('SELECT id, slug, name FROM service_providers WHERE id != ? ORDER BY id').all(keptProviderId),
    services: count('SELECT COUNT(*) n FROM services WHERE provider_id != ?', keptProviderId),
    tables: {},
  };
  for (const t of existingTables(db)) p.tables[t] = count(`SELECT COUNT(*) n FROM ${t}`);
  p.content = contentPrunePlan(db, keep).map((c) => c.section);
  p.files = filePlan(db, keep);
  return p;
}

/* ---- site_content: homepage picks must only name survivors ---- */
function contentPrunePlan(db, keep) {
  const keptProductId = keep.product ? keep.product.id : null;
  const keptShopSlug = keep.shop ? keep.shop.slug : null;
  const changes = [];
  for (const row of db.prepare('SELECT section, value FROM site_content').all()) {
    let obj;
    try { obj = JSON.parse(row.value); } catch (_) { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    let changed = false;
    if (Array.isArray(obj.productIds)) {
      const next = obj.productIds.filter((id) => Number(id) === keptProductId);
      if (next.length !== obj.productIds.length) { obj.productIds = next; changed = true; }
    }
    if (Array.isArray(obj.shopSlugs)) {
      const next = obj.shopSlugs.filter((s) => s === keptShopSlug);
      if (next.length !== obj.shopSlugs.length) { obj.shopSlugs = next; changed = true; }
    }
    if (obj.crops && typeof obj.crops === 'object' && !Array.isArray(obj.crops)) {
      const next = {};
      for (const [id, crop] of Object.entries(obj.crops)) if (Number(id) === keptProductId) next[id] = crop;
      if (Object.keys(next).length !== Object.keys(obj.crops).length) { obj.crops = next; changed = true; }
    }
    if (changed) changes.push({ section: row.section, value: JSON.stringify(obj) });
  }
  return changes;
}

/* ---- files: anything under uploads/ or private/ that no survivor refers to ---- */
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

function survivingFileRefs(db, keep) {
  // Computed as if the deletes had happened: only the keepers' rows count.
  const ups = new Set();   // public /uploads/... urls
  const priv = new Set();  // absolute paths under PRIVATE_DIR
  const privRoot = privateDir();
  const addPrivate = (p) => { if (p) priv.add(path.resolve(path.isAbsolute(p) ? p : path.join(privRoot, p))); };
  if (keep.shop) {
    const s = db.prepare('SELECT image, license_image, eid_front_file, eid_back_file FROM shops WHERE id = ?').get(keep.shop.id);
    if (s.image) ups.add(s.image);
    addPrivate(s.license_image); addPrivate(s.eid_front_file); addPrivate(s.eid_back_file);
  }
  if (keep.product) {
    const pr = db.prepare('SELECT images FROM products WHERE id = ?').get(keep.product.id);
    for (const u of parseList(pr.images)) ups.add(u);
  }
  // reviews, returns and purchase notes are all wiped, so nothing of theirs survives.
  return { ups, priv };
}

function filePlan(db, keep) {
  const { ups, priv } = survivingFileRefs(db, keep);
  const upRoot = path.resolve(uploadsDir());
  const privRoot = path.resolve(privateDir());
  const remove = [];
  for (const f of walk(upRoot)) {
    const url = '/uploads/' + path.relative(upRoot, f).split(path.sep).join('/');
    if (!ups.has(url)) remove.push(f);
  }
  for (const f of walk(privRoot)) {
    if (!priv.has(path.resolve(f))) remove.push(f);
  }
  return remove;
}

/** Back up, then remove. Returns the plan that was executed plus the backup file. */
function run(db, opts = {}) {
  const keep = resolveKeepers(db, opts);
  const p = plan(db, opts);
  const backup = opts.backup === false ? null : require('./backup').run().file;

  const keptShopId = keep.shop ? keep.shop.id : -1;
  const keptProductId = keep.product ? keep.product.id : -1;
  const keptProviderId = keep.provider ? keep.provider.id : -1;
  const contentChanges = contentPrunePlan(db, keep);
  const tables = existingTables(db);

  db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare('DELETE FROM services WHERE provider_id != ?').run(keptProviderId);
    db.prepare('DELETE FROM service_providers WHERE id != ?').run(keptProviderId);
    db.prepare('DELETE FROM products WHERE id != ?').run(keptProductId);
    db.prepare('DELETE FROM shops WHERE id != ?').run(keptShopId);
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

module.exports = { plan, run, resolveKeepers, TABLES_WIPED };
