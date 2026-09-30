'use strict';
/**
 * The Trove Collection: the owner's own shop (shops.is_house = 1).
 *
 * The live database lost its house shop in the 2026-09-22 demo purge. The
 * owner wants it back as their own shop (2026-09-30), so a one-time boot step
 * re-creates it when none exists: owned by the ADMIN_EMAIL account, approved,
 * brand charcoal, with a short honest bio. Nothing is invented: no pieces, no
 * pickup address (the owner adds those in the dashboard).
 *
 * Money: house pieces are Trove's own stock. A house sale writes no maker
 * credit, so it never reaches a settlement run, and a return reverses no
 * maker credit (paid-effects.js, returns.js). The courier still collects
 * from the shop's pickup address like any other parcel.
 *
 * bootOnce(db) is the server.js hook: guarded by a marker row in
 * schema_migrations (the qa-cleanup pattern). It marks itself done once the
 * shop exists (made now or already there); when it has to skip (no admin
 * account yet, the slug taken by another shop) it logs why and tries again on
 * the next boot. After that it never runs again, so a house shop the owner
 * later removes on purpose is not re-created behind their back.
 */
const MARKER = 'house-shop-2026-09-30';
const HOUSE = Object.freeze({
  name: 'Trove Collection',
  slug: 'trove-collection',
  color: '#292727', // brand charcoal: the house line's colour everywhere
  location: 'Dubai, UAE',
  bio: 'Trove’s own line: pieces we design and make with partner studios.',
});

/** The house shop row, or null. */
function findHouse(db) {
  return db.prepare('SELECT * FROM shops WHERE is_house = 1 ORDER BY id LIMIT 1').get() || null;
}

/**
 * Create the house shop when there is none. Returns
 * { status: 'exists' | 'created', shop } or { status: 'skipped', reason }.
 */
function ensureHouseShop(db, { adminEmail = process.env.ADMIN_EMAIL } = {}) {
  const existing = findHouse(db);
  if (existing) return { status: 'exists', shop: existing };
  const email = String(adminEmail || '').trim().toLowerCase();
  if (!email) return { status: 'skipped', reason: 'ADMIN_EMAIL is not set' };
  const owner = db.prepare('SELECT id, email, role FROM users WHERE lower(email) = ?').get(email);
  if (!owner) return { status: 'skipped', reason: `no account for ADMIN_EMAIL (${email}) yet` };
  if (owner.role !== 'admin') return { status: 'skipped', reason: `${email} is not an admin` };
  const clash = db.prepare('SELECT id, name FROM shops WHERE slug = ?').get(HOUSE.slug);
  if (clash) return { status: 'skipped', reason: `the address ${HOUSE.slug} belongs to another shop (${clash.name})` };
  const id = db.prepare(`INSERT INTO shops (user_id, name, slug, bio, location, color, is_house, status)
    VALUES (?,?,?,?,?,?, 1, 'approved')`)
    .run(owner.id, HOUSE.name, HOUSE.slug, HOUSE.bio, HOUSE.location, HOUSE.color).lastInsertRowid;
  return { status: 'created', shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(id) };
}

/** Run once at boot (see the header). Never throws. */
function bootOnce(db, { adminEmail = process.env.ADMIN_EMAIL, log = console } = {}) {
  try {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MARKER)) return { status: 'done-before' };
    const r = ensureHouseShop(db, { adminEmail });
    if (r.status === 'skipped') {
      log.warn(`house shop: not created - ${r.reason}. Will try again on the next boot.`);
      return r;
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MARKER);
    if (r.status === 'created') log.log(`house shop: created ${r.shop.name} (/shop/${HOUSE.slug}) for the admin account`);
    return r;
  } catch (e) {
    log.error('house shop: boot step failed - it will retry on the next boot:', e && e.message ? e.message : e);
    return { status: 'error', error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { MARKER, HOUSE, findHouse, ensureHouseShop, bootOnce };
