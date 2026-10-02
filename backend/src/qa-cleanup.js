'use strict';
/**
 * One-time, TARGETED removal of the QA test data created on the live site on
 * 2026-09-30 by review agents and live checks. Unlike purge.js (which empties
 * everything but a few keepers) this touches ONLY rows that can be proven to
 * be QA data — the live database may already hold real customers and orders.
 *
 * What counts as QA data (and nothing else):
 *   - accounts whose email is exactly ilhamitek95+trove-qa-<something>@gmail.com
 *     (never an admin, never the ADMIN_EMAIL account);
 *   - shops / service providers owned by those accounts whose name starts
 *     with 'QA TEST' or whose slug starts with 'qa-test', with their pieces
 *     and listings;
 *   - orders placed with a QA email or by a QA account, and service bookings
 *     made with a QA email / by a QA account or against a QA listing.
 *
 * Safety: anything where real money moved, or that a real customer's record
 * still points at, is SKIPPED and reported instead of deleted (see plan()).
 *
 * plan(db) is read-only. run(db, { backup, stripe }) confirms each order's
 * PaymentIntent with Stripe first (a paid intent means money moved even if
 * the webhook has not landed yet), writes a VACUUM INTO backup, deletes in
 * one transaction (children first — several foreign keys carry no ON DELETE
 * CASCADE), removes the files only the deleted rows referred to, and then,
 * fire-and-forget, cancels the removed orders' still-open PaymentIntents.
 * bootOnce() is the server.js hook: runs once, guarded by a marker row in
 * schema_migrations, and keeps the summary for GET /api/admin/maintenance/qa-cleanup.
 */
const fs = require('fs');
const path = require('path');

// Bumped for each QA pass on live: a new marker makes the boot step run once more.
// r2 (2026-09-30 evening): the second full review's test accounts, shops and listings.
const MARKER = 'qa-cleanup-2026-09-30-r2';
const QA_EMAIL_RE = /^ilhamitek95\+trove-qa-[^@\s]+@gmail\.com$/i;
const QA_EMAIL_LIKE = 'ilhamitek95+trove-qa-%@gmail.com';
// Order states in which no money has moved.
const UNPAID_ORDER = new Set(['pending', 'cancelled', 'failed']);
// PaymentIntent states that can still be cancelled (never refund, never touch a succeeded intent).
const CANCELLABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

const isQaEmail = (e) => QA_EMAIL_RE.test(String(e || '').trim());
const isQaNamed = (row) => /^QA TEST/.test(String(row.name || '')) || /^qa-test/.test(String(row.slug || ''));
const inList = (ids) => { const a = [...ids].map(Number).filter(Number.isInteger); return a.length ? `(${a.join(',')})` : '(-1)'; };

function uploadsDir() { return process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'); }
function privateDir() { return process.env.PRIVATE_DIR || path.join(uploadsDir(), '..', 'private'); }
function parseList(json) { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
function tableSet(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)); }

/**
 * Everything run() would remove, and everything it deliberately leaves.
 * opts.holdOrders / opts.holdBookings: Map id → reason, treated as "money
 * moved" (run() fills these from Stripe before the real plan).
 */
function plan(db, opts = {}) {
  const have = tableSet(db);
  const holdOrders = opts.holdOrders || new Map();
  const holdBookings = opts.holdBookings || new Map();
  const adminEmail = String(opts.adminEmail !== undefined ? opts.adminEmail : (process.env.ADMIN_EMAIL || '')).trim().toLowerCase();
  const skipped = [];
  const skip = (kind, id, label, reason) => skipped.push({ kind, id, label, reason });

  /* ---- accounts ---- */
  const qaUsers = new Map();
  for (const u of db.prepare('SELECT id, email, name, role FROM users WHERE lower(email) LIKE ? ORDER BY id').all(QA_EMAIL_LIKE)) {
    if (!isQaEmail(u.email)) continue;
    if (u.role === 'admin' || (adminEmail && u.email.toLowerCase() === adminEmail)) { skip('user', u.id, u.email, 'admin account - never removed'); continue; }
    qaUsers.set(u.id, u);
  }
  const blockedUsers = new Map(); // id → reason
  const block = (uid, reason) => { if (qaUsers.has(uid) && !blockedUsers.has(uid)) blockedUsers.set(uid, reason); };

  /* ---- orders ---- */
  const orders = new Map();
  const orderRows = db.prepare(`SELECT id, public_id, email, buyer_id, status, total_cents, refunded_at, title_transferred_at, stripe_payment_intent_id
    FROM orders WHERE lower(email) LIKE ? OR buyer_id IN ${inList(qaUsers.keys())} ORDER BY id`).all(QA_EMAIL_LIKE);
  const balanceFor = have.has('seller_balances') ? db.prepare('SELECT COUNT(*) n FROM seller_balances WHERE order_id=?') : null;
  const refundedReturn = have.has('return_requests') ? db.prepare('SELECT COUNT(*) n FROM return_requests WHERE order_id=? AND refunded_at IS NOT NULL') : null;
  for (const o of orderRows) {
    if (!isQaEmail(o.email) && !qaUsers.has(o.buyer_id)) continue;
    let reason = '';
    if (!UNPAID_ORDER.has(o.status)) reason = `status ${o.status} - real money moved`;
    else if (o.refunded_at || o.title_transferred_at) reason = 'payment or refund recorded - real money moved';
    else if (balanceFor && balanceFor.get(o.id).n) reason = 'has supplier ledger rows';
    else if (refundedReturn && refundedReturn.get(o.id).n) reason = 'has a refunded return';
    else if (holdOrders.has(o.id)) reason = holdOrders.get(o.id);
    if (reason) { skip('order', o.id, `${o.public_id} (${o.email})`, reason); continue; }
    orders.set(o.id, o);
  }
  const O = inList(orders.keys());

  /* ---- shops and their pieces ---- */
  const shops = new Map();
  for (const s of db.prepare(`SELECT id, user_id, name, slug, image, license_image, eid_front_file, eid_back_file
    FROM shops WHERE user_id IN ${inList(qaUsers.keys())} ORDER BY id`).all()) {
    const reasons = [];
    if (!isQaNamed(s)) reasons.push('owned by a QA account but not named QA TEST');
    const liveOrders = db.prepare(`SELECT DISTINCT o.public_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE (oi.shop_id = ? OR oi.product_id IN (SELECT id FROM products WHERE shop_id = ?)) AND oi.order_id NOT IN ${O}`).all(s.id, s.id);
    if (liveOrders.length) reasons.push(`a kept order contains its pieces (${liveOrders.map((r) => r.public_id).join(', ')})`);
    if (db.prepare(`SELECT COUNT(*) n FROM shipments WHERE shop_id = ? AND order_id NOT IN ${O}`).get(s.id).n) reasons.push('a kept order has a shipment from it');
    for (const t of ['seller_balances', 'settlement_items', 'purchase_notes', 'payouts', 'return_collections']) {
      if (have.has(t) && db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE shop_id = ?`).get(s.id).n) reasons.push(`has ${t} rows (money records)`);
    }
    const foreignReviews = db.prepare(`SELECT COUNT(*) n FROM reviews WHERE (shop_id = ? OR product_id IN (SELECT id FROM products WHERE shop_id = ?))
      AND buyer_id NOT IN ${inList(qaUsers.keys())}`).get(s.id, s.id).n;
    if (foreignReviews) reasons.push('reviewed by a non-QA account');
    if (reasons.length) { skip('shop', s.id, `${s.slug} (${s.name})`, reasons.join('; ')); block(s.user_id, `owns kept shop ${s.slug}`); continue; }
    shops.set(s.id, s);
  }
  const S = inList(shops.keys());
  const products = db.prepare(`SELECT id, shop_id, name, images FROM products WHERE shop_id IN ${S} ORDER BY id`).all();
  const P = inList(products.map((p) => p.id));

  /* ---- service providers, listings and bookings ---- */
  const providers = new Map();
  for (const v of db.prepare(`SELECT id, user_id, name, slug FROM service_providers WHERE user_id IN ${inList(qaUsers.keys())} ORDER BY id`).all()) {
    const reasons = [];
    if (!isQaNamed(v)) reasons.push('owned by a QA account but not named QA TEST');
    for (const b of db.prepare('SELECT id, code, email, buyer_id, paid_at, refunded_at FROM service_bookings WHERE provider_id = ?').all(v.id)) {
      if (b.paid_at || b.refunded_at) reasons.push(`booking ${b.code} was paid - real money moved`);
      else if (!isQaEmail(b.email) && !qaUsers.has(b.buyer_id)) reasons.push(`booking ${b.code} is from a real customer`);
      else if (holdBookings.has(b.id)) reasons.push(`booking ${b.code}: ${holdBookings.get(b.id)}`);
    }
    if (have.has('provider_credits') && db.prepare('SELECT COUNT(*) n FROM provider_credits WHERE provider_id = ?').get(v.id).n) reasons.push('has provider_credits rows (money records)');
    if (reasons.length) { skip('provider', v.id, `${v.slug} (${v.name})`, reasons.join('; ')); block(v.user_id, `owns kept provider ${v.slug}`); continue; }
    providers.set(v.id, v);
  }
  const V = inList(providers.keys());
  const services = db.prepare(`SELECT id, provider_id, title FROM services WHERE provider_id IN ${V} ORDER BY id`).all();

  const bookings = new Map();
  const creditFor = have.has('provider_credits') ? db.prepare('SELECT COUNT(*) n FROM provider_credits WHERE booking_id = ?') : null;
  for (const b of db.prepare(`SELECT id, code, email, buyer_id, provider_id, paid_at, refunded_at, stripe_payment_intent_id
    FROM service_bookings WHERE provider_id IN ${V} OR buyer_id IN ${inList(qaUsers.keys())} OR lower(email) LIKE ? ORDER BY id`).all(QA_EMAIL_LIKE)) {
    if (providers.has(b.provider_id)) { bookings.set(b.id, b); continue; } // vetted with its provider above
    if (!isQaEmail(b.email) && !qaUsers.has(b.buyer_id)) continue;
    let reason = '';
    if (b.paid_at || b.refunded_at) reason = 'paid - real money moved';
    else if (creditFor && creditFor.get(b.id).n) reason = 'has provider_credits rows';
    else if (holdBookings.has(b.id)) reason = holdBookings.get(b.id);
    if (reason) { skip('booking', b.id, `${b.code} (${b.email})`, reason); block(b.buyer_id, `made kept booking ${b.code}`); continue; }
    bookings.set(b.id, b);
  }

  /* ---- which QA accounts can go ---- */
  for (const uid of qaUsers.keys()) {
    const kept = db.prepare(`SELECT public_id FROM orders WHERE buyer_id = ? AND id NOT IN ${O}`).all(uid);
    if (kept.length) block(uid, `buyer on kept order(s) ${kept.map((r) => r.public_id).join(', ')}`);
    if (have.has('return_requests') && db.prepare(`SELECT COUNT(*) n FROM return_requests WHERE buyer_id = ? AND order_id NOT IN ${O}`).get(uid).n) block(uid, 'has a return on a kept order');
    if (db.prepare(`SELECT COUNT(*) n FROM reviews WHERE buyer_id = ? AND order_id IS NOT NULL AND order_id NOT IN ${O}`).get(uid).n) block(uid, 'reviewed a kept order');
    if (db.prepare(`SELECT COUNT(*) n FROM shops WHERE user_id = ? AND id NOT IN ${S}`).get(uid).n) block(uid, 'owns a kept shop');
    if (db.prepare(`SELECT COUNT(*) n FROM service_providers WHERE user_id = ? AND id NOT IN ${V}`).get(uid).n) block(uid, 'owns a kept provider');
  }
  const users = new Map();
  for (const [uid, u] of qaUsers) {
    if (blockedUsers.has(uid)) skip('user', uid, u.email, blockedUsers.get(uid));
    else users.set(uid, u);
  }
  const U = inList(users.keys());

  /* ---- dependent rows ---- */
  const returnIds = have.has('return_requests')
    ? db.prepare(`SELECT id, images FROM return_requests WHERE order_id IN ${O}`).all() : [];
  const R = inList(returnIds.map((r) => r.id));
  const reviewRows = db.prepare(`SELECT id, images FROM reviews WHERE order_id IN ${O} OR product_id IN ${P} OR shop_id IN ${S} OR buyer_id IN ${U}`).all();
  const contactIds = db.prepare('SELECT id, email, user_id FROM contact_messages').all()
    .filter((c) => users.has(c.user_id) || isQaEmail(c.email)).map((c) => c.id);
  const sessionIds = have.has('sessions') ? db.prepare('SELECT sid, sess FROM sessions').all().filter((r) => {
    try { const s = JSON.parse(r.sess); return users.has(Number(s.userId)); } catch (_) { return false; }
  }).map((r) => r.sid) : [];

  // Children before parents. [table, WHERE clause, params]
  const deletes = [
    ['return_collections', `request_id IN ${R}`],
    ['return_request_items', `request_id IN ${R} OR order_item_id IN (SELECT id FROM order_items WHERE order_id IN ${O})`],
    ['return_requests', `id IN ${R}`],
    ['reviews', `id IN ${inList(reviewRows.map((r) => r.id))}`],
    ['shipment_events', `shipment_id IN (SELECT id FROM shipments WHERE order_id IN ${O} OR shop_id IN ${S})`],
    ['shipments', `order_id IN ${O} OR shop_id IN ${S}`],
    ['order_cancellation_items', `cancellation_id IN (SELECT id FROM order_cancellations WHERE order_id IN ${O})`],
    ['order_cancellations', `order_id IN ${O}`],
    ['order_items', `order_id IN ${O}`],
    ['orders', `id IN ${O}`],
    ['analytics_events', `shop_id IN ${S} OR product_id IN ${P}`],
    ['provider_payout_details', `provider_id IN ${V}`],
    ['service_bookings', `id IN ${inList(bookings.keys())}`],
    ['services', `provider_id IN ${V}`],
    ['service_providers', `id IN ${V}`],
    ['products', `id IN ${P}`],
    ['shops', `id IN ${S}`],
    ['addresses', `user_id IN ${U}`],
    ['auth_tokens', `user_id IN ${U}`],
    ['contact_messages', `id IN ${inList(contactIds)}`],
    ['sessions', `sid IN (${sessionIds.map(() => '?').join(',') || "''"})`, sessionIds],
    ['users', `id IN ${U}`],
  ].filter(([t]) => have.has(t));
  const tables = {};
  for (const [t, where, params = []] of deletes) tables[t] = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`).get(...params).n;

  /* ---- files the removed rows refer to ---- */
  const files = { uploads: [], private: [] };
  const addUp = (u) => { if (typeof u === 'string' && u.startsWith('/uploads/') && !files.uploads.includes(u)) files.uploads.push(u); };
  const addPriv = (p) => { if (p && !files.private.includes(p)) files.private.push(p); };
  for (const p of products) parseList(p.images).forEach(addUp);
  for (const s of shops.values()) { addUp(s.image); addPriv(s.license_image); addPriv(s.eid_front_file); addPriv(s.eid_back_file); }
  for (const r of reviewRows) parseList(r.images).forEach(addUp);
  for (const r of returnIds) parseList(r.images).forEach(addUp);

  return {
    users: [...users.values()].map((u) => ({ id: u.id, email: u.email, name: u.name })),
    shops: [...shops.values()].map((s) => ({ id: s.id, slug: s.slug, name: s.name, userId: s.user_id })),
    products: products.map((p) => ({ id: p.id, name: p.name, shopId: p.shop_id })),
    providers: [...providers.values()].map((v) => ({ id: v.id, slug: v.slug, name: v.name, userId: v.user_id })),
    services: services.map((s) => ({ id: s.id, title: s.title, providerId: s.provider_id })),
    orders: [...orders.values()].map((o) => ({ id: o.id, publicId: o.public_id, email: o.email, status: o.status, totalCents: o.total_cents, paymentIntent: o.stripe_payment_intent_id || null })),
    bookings: [...bookings.values()].map((b) => ({ id: b.id, code: b.code, paymentIntent: b.stripe_payment_intent_id || null })),
    tables,
    content: contentPrunePlan(db, products.map((p) => p.id), [...shops.values()].map((s) => s.slug)).map((c) => c.section),
    files,
    skipped,
    _deletes: deletes,
  };
}

const isEmpty = (p) => Object.values(p.tables).every((n) => n === 0);

/* ---- site_content: homepage picks must not name removed pieces or makers ---- */
function contentPrunePlan(db, productIds, shopSlugs) {
  const goneP = new Set(productIds.map(Number));
  const goneS = new Set(shopSlugs);
  if (!goneP.size && !goneS.size) return [];
  const changes = [];
  for (const row of db.prepare('SELECT section, value FROM site_content').all()) {
    let obj;
    try { obj = JSON.parse(row.value); } catch (_) { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    let changed = false;
    if (Array.isArray(obj.productIds)) {
      const next = obj.productIds.filter((id) => !goneP.has(Number(id)));
      if (next.length !== obj.productIds.length) { obj.productIds = next; changed = true; }
    }
    if (Array.isArray(obj.shopSlugs)) {
      const next = obj.shopSlugs.filter((s) => !goneS.has(s));
      if (next.length !== obj.shopSlugs.length) { obj.shopSlugs = next; changed = true; }
    }
    if (obj.crops && typeof obj.crops === 'object' && !Array.isArray(obj.crops)) {
      const next = {};
      for (const [id, crop] of Object.entries(obj.crops)) if (!goneP.has(Number(id))) next[id] = crop;
      if (Object.keys(next).length !== Object.keys(obj.crops).length) { obj.crops = next; changed = true; }
    }
    if (changed) changes.push({ section: row.section, value: JSON.stringify(obj) });
  }
  return changes;
}

/* ---- files: delete only what no surviving row still names ---- */
function removeFiles(db, files) {
  const removed = [], kept = [];
  const upRoot = path.resolve(uploadsDir());
  const privRoot = path.resolve(privateDir());
  const inside = (root, f) => f.startsWith(root + path.sep);
  const stillUsed = (needle) => {
    const like = `%${needle}%`;
    return !!(db.prepare('SELECT 1 FROM shops WHERE image = ? OR license_image = ? OR eid_front_file = ? OR eid_back_file = ? LIMIT 1').get(needle, needle, needle, needle)
      || db.prepare('SELECT 1 FROM products WHERE images LIKE ? LIMIT 1').get(like)
      || db.prepare('SELECT 1 FROM reviews WHERE images LIKE ? LIMIT 1').get(like)
      || db.prepare('SELECT 1 FROM site_content WHERE value LIKE ? LIMIT 1').get(like)
      || (tableSet(db).has('return_requests') && db.prepare('SELECT 1 FROM return_requests WHERE images LIKE ? LIMIT 1').get(like)));
  };
  const unlink = (ref, abs, root) => {
    if (!inside(root, abs)) { kept.push({ file: ref, reason: 'outside the storage folder' }); return; }
    if (stillUsed(ref)) { kept.push({ file: ref, reason: 'still referenced by a kept row' }); return; }
    try { fs.unlinkSync(abs); removed.push(ref); }
    catch (e) { kept.push({ file: ref, reason: e.code === 'ENOENT' ? 'already gone' : e.message }); }
  };
  for (const u of files.uploads) unlink(u, path.resolve(upRoot, u.slice('/uploads/'.length)), upRoot);
  for (const p of files.private) unlink(p, path.resolve(path.isAbsolute(p) ? p : path.join(privRoot, p)), privRoot);
  return { removed, kept };
}

/* ---- Stripe ---- */
async function intentStatus(stripe, id) {
  const pi = await stripe.paymentIntents.retrieve(id);
  return pi && pi.status;
}

// Before deleting: an intent that is paid (or mid-payment) means money moved
// even though the order row still says pending. Hold those back.
async function stripeHolds(db, stripe, p) {
  const holdOrders = new Map(), holdBookings = new Map();
  if (!stripe) return { holdOrders, holdBookings };
  const check = async (id, pi, map) => {
    try {
      const st = await intentStatus(stripe, pi);
      if (!CANCELLABLE.has(st) && st !== 'canceled') map.set(id, `PaymentIntent ${pi} is ${st} - real money may have moved`);
    } catch (e) {
      map.set(id, `could not confirm PaymentIntent ${pi} with Stripe (${e.message})`);
    }
  };
  for (const o of p.orders) if (o.paymentIntent) await check(o.id, o.paymentIntent, holdOrders);
  for (const b of p.bookings) if (b.paymentIntent) await check(b.id, b.paymentIntent, holdBookings);
  return { holdOrders, holdBookings };
}

// After deleting: close any intent that could still be paid. Never refunds.
async function cancelIntents(stripe, intents, log = console) {
  const out = [];
  for (const { ref, pi } of intents) {
    try {
      const st = await intentStatus(stripe, pi);
      if (st === 'canceled') { out.push({ ref, pi, outcome: 'already cancelled' }); continue; }
      if (!CANCELLABLE.has(st)) { out.push({ ref, pi, outcome: `left alone (status ${st})` }); continue; }
      await stripe.paymentIntents.cancel(pi, { cancellation_reason: 'abandoned' });
      out.push({ ref, pi, outcome: 'cancelled' });
    } catch (e) {
      out.push({ ref, pi, outcome: `error: ${e.message}` });
    }
  }
  for (const r of out) log.log(`qa-cleanup stripe: ${r.ref} ${r.pi} - ${r.outcome}`);
  return out;
}

/* ---- the run ---- */
function fkViolations(db) { return db.prepare('PRAGMA foreign_key_check').all().length; }

async function run(db, { backup = true, stripe = null, adminEmail, log = console } = {}) {
  const first = plan(db, { adminEmail });
  if (isEmpty(first)) return summarise(first, { noop: true });
  const holds = await stripeHolds(db, stripe, first);
  const p = plan(db, { adminEmail, ...holds });
  if (isEmpty(p)) return summarise(p, { noop: true });

  // Backup FIRST — if it fails, nothing is deleted (the error propagates).
  const backupFile = backup ? require('./backup').run(new Date(), { prefix: 'trove-qa-cleanup' }).file : null;

  const contentChanges = contentPrunePlan(db, p.products.map((x) => x.id), p.shops.map((x) => x.slug));
  const deleted = {};
  db.transaction(() => {
    const fkBefore = fkViolations(db);
    for (const [t, where, params = []] of p._deletes) deleted[t] = db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(...params).changes;
    const upd = db.prepare("UPDATE site_content SET value = ?, updated_at = datetime('now') WHERE section = ?");
    for (const c of contentChanges) upd.run(c.value, c.section);
    const fkAfter = fkViolations(db);
    if (fkAfter > fkBefore) throw new Error(`qa-cleanup would leave ${fkAfter - fkBefore} dangling reference(s) - rolled back`);
  })();

  const files = removeFiles(db, p.files);
  const summary = summarise(p, { backupFile, deleted, files });

  const intents = [
    ...p.orders.filter((o) => o.paymentIntent).map((o) => ({ ref: o.publicId, pi: o.paymentIntent })),
    ...p.bookings.filter((b) => b.paymentIntent).map((b) => ({ ref: b.code, pi: b.paymentIntent })),
  ];
  const stripeDone = stripe && intents.length
    ? cancelIntents(stripe, intents, log).then((out) => { summary.stripe = out; saveSummary(db, summary); return out; })
      .catch((e) => { log.error('qa-cleanup stripe cancel failed:', e.message); return []; })
    : Promise.resolve([]);
  if (!stripe && intents.length) summary.stripe = intents.map((i) => ({ ...i, outcome: 'not attempted (Stripe not configured)' }));
  Object.defineProperty(summary, 'stripeDone', { value: stripeDone, enumerable: false });
  return summary;
}

function summarise(p, extra = {}) {
  const { _deletes, ...rest } = p;
  return { ranAt: new Date().toISOString(), noop: false, backupFile: null, ...rest, deleted: extra.deleted || {}, ...extra };
}

/* ---- persisted summary for the admin panel ---- */
function ensureLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_log (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}
function saveSummary(db, summary) {
  ensureLog(db);
  db.prepare(`INSERT INTO maintenance_log (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(MARKER, JSON.stringify(summary));
}
function lastSummary(db) {
  ensureLog(db);
  const row = db.prepare('SELECT value, updated_at FROM maintenance_log WHERE key = ?').get(MARKER);
  const marker = db.prepare('SELECT applied_at FROM schema_migrations WHERE id = ?').get(MARKER);
  return { marker: MARKER, appliedAt: marker ? marker.applied_at : null, summary: row ? JSON.parse(row.value) : null };
}

function describe(s) {
  const ids = (list, key = 'id') => list.map((x) => x[key]).join(', ') || '-';
  const lines = [
    `==== QA cleanup ${MARKER} ${s.noop ? '(nothing to remove)' : ''}`,
    `  backup:    ${s.backupFile || '-'}`,
    `  users:     ${s.users.length} [${s.users.map((u) => `${u.id} ${u.email}`).join('; ') || '-'}]`,
    `  shops:     ${s.shops.length} [${ids(s.shops)}]   products: ${s.products.length} [${ids(s.products)}]`,
    `  providers: ${s.providers.length} [${ids(s.providers)}]   services: ${s.services.length} [${ids(s.services)}]`,
    `  orders:    ${s.orders.length} [${ids(s.orders, 'publicId')}]   bookings: ${s.bookings.length} [${ids(s.bookings, 'code')}]`,
    `  rows:      ${Object.entries(s.deleted || {}).filter(([, n]) => n).map(([t, n]) => `${t}=${n}`).join(' ') || '-'}`,
    `  content:   ${(s.content || []).join(', ') || '-'}`,
    `  files:     removed ${s.files && s.files.removed ? s.files.removed.length : 0}${s.files && s.files.kept && s.files.kept.length ? `, kept ${s.files.kept.length}` : ''}`,
    `  skipped:   ${s.skipped.length ? '' : '-'}`,
    ...s.skipped.map((k) => `    - ${k.kind} ${k.id} ${k.label}: ${k.reason}`),
    '====',
  ];
  return lines.join('\n');
}

/**
 * The boot hook. Runs once per database: skipped when the marker exists;
 * on success stores the summary and writes the marker (even for an empty
 * plan); on failure logs loudly and writes neither, so the next boot retries.
 * Never throws.
 */
async function bootOnce(db, { stripe = null, backup = true, log = console } = {}) {
  try {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MARKER)) return { skipped: true };
    const summary = await run(db, { stripe, backup, log });
    saveSummary(db, summary);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MARKER);
    log.log(describe(summary));
    return summary;
  } catch (e) {
    log.error(`!!!! QA cleanup ${MARKER} FAILED - nothing marked, it will retry on the next boot:`, e && e.stack ? e.stack : e);
    return { error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { plan, run, bootOnce, lastSummary, describe, isQaEmail, MARKER, QA_EMAIL_RE };
