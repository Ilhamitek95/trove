'use strict';
/**
 * Admin — marketplace oversight and the fortnightly settlement run.
 *
 * On the consignment rail Trove purchases each sold item from its supplier
 * (list price minus the purchase margin) and resells it to the buyer. What
 * Trove owes suppliers accrues on the seller_balances ledger; once a parcel
 * is delivered and the buyer's 15-day return window closes, the credit becomes
 * payable and the fortnightly settlement run (src/settlement.js) batches it into a bank
 * transfer with self-billed purchase documentation.
 */
const express = require('express');
const db = require('../db');
const { requireAdmin, publicUser, startSession } = require('../middleware');
const shipments = require('../shipments');

const router = express.Router();

/* ---------------- Marketplace overview ---------------- */

// GET /api/admin/stats → the numbers on the admin overview.
router.get('/stats', requireAdmin, (_req, res) => {
  const shopRows = db.prepare('SELECT status, COUNT(*) AS c FROM shops GROUP BY status').all();
  const shops = { total: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 };
  for (const r of shopRows) { shops[r.status] = r.c; shops.total += r.c; }
  const orders = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status IN ('paid','fulfilled')").get().c;
  const gmv = db.prepare("SELECT COALESCE(SUM(total_cents),0) AS c FROM orders WHERE status IN ('paid','fulfilled')").get().c;
  const buyers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='buyer'").get().c;
  const products = db.prepare("SELECT COUNT(*) AS c FROM products WHERE status='live'").get().c;
  // Licensed sellers: applied with a trade/e-Trader license (connect_queue)
  // or later admin-verified. Rejected applications don't count.
  const lic = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN license_verified_at IS NOT NULL THEN 1 ELSE 0 END),0) AS verified
    FROM shops WHERE (connect_queue=1 OR license_verified_at IS NOT NULL) AND status!='rejected'`).get();
  // Service providers (the services marketplace) — same approval workflow.
  const provRows = db.prepare('SELECT status, COUNT(*) AS c FROM service_providers GROUP BY status').all();
  const providers = { total: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 };
  for (const r of provRows) { providers[r.status] = r.c; providers.total += r.c; }
  res.json({ shops, orders, gmvCents: gmv, buyers, liveProducts: products, providers,
    licensed: { total: lic.total, verified: lic.verified, awaiting: lic.total - lic.verified } });
});

// GET /api/admin/search-trends → what shoppers typed in the last 30 days.
// avgResults near 0 flags demand the catalogue isn't meeting yet.
// GET /api/admin/maintenance/qa-cleanup → the one-time QA data cleanup's
// last run: marker time, what was removed (ids + counts), the backup file
// and anything it skipped on purpose. See src/qa-cleanup.js.
router.get('/maintenance/qa-cleanup', requireAdmin, (_req, res) => {
  res.json(require('../qa-cleanup').lastSummary(db));
});

router.get('/search-trends', requireAdmin, (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
  res.json({ days, terms: require('../trends').topSearchTerms(days, 40) });
});

/* ---------------- Review moderation ---------------- */

// GET /api/admin/reviews → newest first, hidden ones included.
router.get('/reviews', requireAdmin, (_req, res) => {
  const reviews = require('../reviews');
  const rows = db.prepare(`
    SELECT r.*, u.name AS buyer_name, u.email AS buyer_email, p.name AS product_name, s.name AS shop_name
    FROM reviews r
    JOIN users u ON u.id = r.buyer_id
    JOIN shops s ON s.id = r.shop_id
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY r.created_at DESC LIMIT 500`).all();
  res.json({ reviews: rows.map((r) => ({
    ...reviews.shape(r),
    buyerEmail: r.buyer_email, shopName: r.shop_name, status: r.status,
  })) });
});

// PATCH /api/admin/reviews/:id {status} → hide a review (or publish it again).
router.patch('/reviews/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['published', 'hidden'].includes(status)) return res.status(400).json({ error: 'status must be published or hidden' });
  const r = db.prepare('UPDATE reviews SET status=? WHERE id=?').run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/* ---------------- Catalogue moderation ---------------- */
const { parseTags, normalizeTags } = require('../tags');

// GET /api/admin/products → every product in every shop, any status.
router.get('/products', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*, s.name AS shop_name, s.slug, s.color, s.image AS shop_image, s.is_house, s.status AS shop_status
    FROM products p JOIN shops s ON s.id = p.shop_id
    ORDER BY p.created_at DESC`).all();
  res.json({ products: rows.map((p) => ({
    id: p.id, name: p.name, description: p.description, category: p.category,
    priceCents: p.price_cents, stock: p.stock, status: p.status, adminHidden: !!p.admin_hidden_at,
    imageSeed: p.image_seed, tags: parseTags(p.tags), createdAt: p.created_at,
    images: (() => { try { const v = JSON.parse(p.images || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } })(),
    shop: { id: p.shop_id, name: p.shop_name, slug: p.slug, color: p.color, image: p.shop_image, isHouse: !!p.is_house, status: p.shop_status },
  })) });
});

// PATCH /api/admin/products/:id — moderation: pull a piece off the storefront
// (status → hidden) or fix its discovery data (category, tags).
router.patch('/products/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.status !== undefined && !['live', 'draft', 'hidden'].includes(b.status))
    return res.status(400).json({ error: 'status must be live, draft or hidden' });
  if (b.category != null) {
    const shop = db.prepare('SELECT is_house FROM shops WHERE id=?').get(p.shop_id);
    const catErr = require('../categories').categoryError(b.category, { house: !!(shop && shop.is_house) });
    if (catErr) return res.status(422).json({ error: catErr.message });
  }
  db.prepare('UPDATE products SET status=COALESCE(?,status), category=COALESCE(?,category) WHERE id=?')
    .run(b.status, b.category, p.id);
  // An admin hide is a moderation lock: the seller sees 'Hidden by Trove'
  // and can't put the piece back on sale. Only an admin status change
  // (live or draft) lifts it.
  if (b.status === 'hidden') db.prepare("UPDATE products SET admin_hidden_at=COALESCE(admin_hidden_at, datetime('now')) WHERE id=?").run(p.id);
  else if (b.status !== undefined) db.prepare('UPDATE products SET admin_hidden_at=NULL WHERE id=?').run(p.id);
  if (b.tags !== undefined)
    db.prepare('UPDATE products SET tags=? WHERE id=?').run(JSON.stringify(normalizeTags(b.tags)), p.id);
  res.json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(p.id) });
});

// POST /api/admin/products/:id/suggest-tags — the same Claude tag writer
// sellers get, so the curation team can fix discovery on any listing.
router.post('/products/:id/suggest-tags', requireAdmin, async (req, res) => {
  const ai = require('../ai');
  if (!ai.enabled()) return res.status(503).json({ error: 'AI tag suggestions are not switched on yet' });
  const p = db.prepare('SELECT p.*, s.name AS shop_name FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const tags = await ai.suggestTags({ name: p.name, description: p.description, category: p.category, shopName: p.shop_name });
    res.json({ tags });
  } catch (e) {
    console.error('admin suggest-tags failed:', e.message);
    res.status(502).json({ error: 'Tag suggestions are unavailable right now — try again in a moment' });
  }
});

/* ---------------- Site content (homepage + sell page CMS) ---------------- */
const content = require('../content');

// GET /api/admin/content → the defaults and any saved overrides, so the
// editor can show current values and mark which sections are customised.
router.get('/content', requireAdmin, (_req, res) => {
  res.json({ sections: content.SECTIONS, defaults: content.DEFAULTS, overrides: content.overrides() });
});

// PUT /api/admin/content/:section → validate + save a whole section.
// Rejects banned money-transmission / greenwashing phrasing (422) so the
// CMS obeys the same copy rules CI enforces on checked-in copy.
router.put('/content/:section', requireAdmin, (req, res) => {
  try {
    const clean = content.save(req.params.section, req.body);
    console.log(`site content: ${req.user.email} updated ${req.params.section}`);
    res.json({ ok: true, section: req.params.section, value: clean });
  } catch (e) {
    if (e instanceof content.ContentError) return res.status(422).json({ error: e.message });
    throw e;
  }
});

// DELETE /api/admin/content/:section → back to the built-in default.
router.delete('/content/:section', requireAdmin, (req, res) => {
  try {
    content.reset(req.params.section);
    console.log(`site content: ${req.user.email} reset ${req.params.section}`);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof content.ContentError) return res.status(422).json({ error: e.message });
    throw e;
  }
});

// GET /api/admin/shops → every shop with its owner, catalogue and sales.
router.get('/shops', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT s.*, u.email AS owner_email, u.name AS owner_name,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS product_count,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status='live') AS live_count,
      (SELECT COALESCE(SUM(oi.price_cents * (oi.qty - oi.cancelled_qty)),0) FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.shop_id = s.id AND o.status IN ('paid','fulfilled')) AS sales_cents
    FROM shops s JOIN users u ON u.id = s.user_id
    ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.created_at DESC`).all();
  res.json({ shops: rows.map((s) => ({
    id: s.id, name: s.name, slug: s.slug, status: s.status,
    owner: { name: s.owner_name, email: s.owner_email },
    location: s.location, bio: s.bio, color: s.color, image: s.image || null, isHouse: !!s.is_house,
    category: s.category || '', pitchProducts: s.pitch_products || '', pitchLinks: s.pitch_links || '',
    pitchInstagram: s.pitch_instagram || '', pitchExperience: s.pitch_experience || '',
    pitchMaker: s.pitch_maker || '', pitchChannels: s.pitch_channels || '',
    pitchCapacity: s.pitch_capacity || '', pitchPhone: s.pitch_phone || '',
    // The courier's pickup number (admin-only, never public): the one to call
    // when a parcel is late or stuck.
    pickupPhone: s.pickup_phone || '',
    tier: s.tier, hasBank: !!(s.iban_encrypted || s.payout_iban), stripeConnected: !!s.stripe_account_id,
    payoutSetupComplete: !!(s.iban_encrypted && s.agreement_accepted_at),
    licenseNumber: s.license_number || '', hasLicenseImage: !!s.license_image,
    licenseVerifiedAt: s.license_verified_at || null,
    sellerAddress: s.seller_address || '', eidFront: !!s.eid_front_file, eidBack: !!s.eid_back_file,
    graduationFlaggedAt: s.graduation_flagged_at || null, connectQueue: !!s.connect_queue,
    products: s.product_count, liveProducts: s.live_count, salesCents: s.sales_cents,
    createdAt: s.created_at,
  })) });
});

// GET /api/admin/shops/:id/license-image → stream a privately stored license.
router.get('/shops/:id/license-image', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT license_image FROM shops WHERE id=?').get(req.params.id);
  if (!shop || !shop.license_image) return res.status(404).json({ error: 'No license image' });
  res.sendFile(require('path').resolve(shop.license_image));
});

// GET /api/admin/shops/:id/eid/front|back → decrypt and stream an Emirates ID
// photo. Admin-only, never cached; the file on disk is AES-256-GCM encrypted.
router.get('/shops/:id/eid/:side', requireAdmin, (req, res, next) => {
  try {
    const side = req.params.side === 'front' ? 'front' : req.params.side === 'back' ? 'back' : null;
    if (!side) return res.status(400).json({ error: 'side must be front or back' });
    const shop = db.prepare(`SELECT eid_${side}_file AS f, eid_${side}_mime AS m FROM shops WHERE id=?`).get(req.params.id);
    if (!shop || !shop.f) return res.status(404).json({ error: 'No Emirates ID image on file' });
    const buf = require('../uploads').readEncryptedPrivate(shop.f);
    res.set({ 'Content-Type': shop.m || 'image/jpeg', 'Cache-Control': 'no-store, private' });
    res.send(buf);
  } catch (e) { next(e); }
});

// PATCH /api/admin/shops/:id { status } → the approval workflow.
// pending → approved/rejected; approved ↔ suspended; anything can be re-reviewed.
// An optional { note } is kept on the shop and quoted in the rejection
// email. The applicant is emailed when a decision changes the status to
// approved or rejected (best-effort, never blocks the change).
const reviewNote = (b) => String((b && b.note) || '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, 600);
router.patch('/shops/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected', 'suspended'].includes(status))
    return res.status(400).json({ error: 'status must be pending, approved, rejected or suspended' });
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  db.prepare('UPDATE shops SET status=? WHERE id=?').run(status, shop.id);
  if (req.body.note !== undefined) db.prepare('UPDATE shops SET review_note=? WHERE id=?').run(reviewNote(req.body), shop.id);
  if (status !== shop.status) require('../notify').shopDecided(shop.id, status);
  res.json({ shop: db.prepare('SELECT * FROM shops WHERE id=?').get(shop.id) });
});

/* ---------------- Service providers (services marketplace) ---------------- */

// GET /api/admin/providers → every provider with their application, listings
// and booking counts, pending first.
router.get('/providers', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*, u.email AS owner_email, u.name AS owner_name,
      (SELECT COUNT(*) FROM services sv WHERE sv.provider_id = p.id) AS service_count,
      (SELECT COUNT(*) FROM services sv WHERE sv.provider_id = p.id AND sv.status='live') AS live_count,
      (SELECT COUNT(*) FROM service_bookings bk WHERE bk.provider_id = p.id) AS booking_count,
      (SELECT COUNT(*) FROM service_bookings bk WHERE bk.provider_id = p.id AND bk.status='requested') AS open_requests
    FROM service_providers p JOIN users u ON u.id = p.user_id
    ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC`).all();
  res.json({ providers: rows.map((p) => ({
    id: p.id, name: p.name, slug: p.slug, status: p.status,
    owner: { name: p.owner_name, email: p.owner_email },
    location: p.location, bio: p.bio, color: p.color,
    categories: (() => { try { const v = JSON.parse(p.categories || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } })(),
    pitchServices: p.pitch_services || '', pitchExperience: p.pitch_experience || '',
    pitchInstagram: p.pitch_instagram || '', pitchLinks: p.pitch_links || '',
    pitchPhone: p.pitch_phone || '',
    subAgreedAt: p.sub_agreed_at || null, subStartedAt: p.sub_started_at || null,
    agreementVersion: p.agreement_version || '', agreementAcceptedAt: p.agreement_accepted_at || null,
    services: p.service_count, liveServices: p.live_count,
    bookings: p.booking_count, openRequests: p.open_requests,
    createdAt: p.created_at,
  })) });
});

// PATCH /api/admin/providers/:id { status } → the approval workflow. First
// approval stamps sub_started_at — the anchor for the monthly platform
// subscription.
router.patch('/providers/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected', 'suspended'].includes(status))
    return res.status(400).json({ error: 'status must be pending, approved, rejected or suspended' });
  const p = db.prepare('SELECT * FROM service_providers WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  db.prepare('UPDATE service_providers SET status=? WHERE id=?').run(status, p.id);
  if (req.body.note !== undefined) db.prepare('UPDATE service_providers SET review_note=? WHERE id=?').run(reviewNote(req.body), p.id);
  if (status !== p.status) require('../notify').providerDecided(p.id, status);
  if (status === 'approved' && !p.sub_started_at) {
    db.prepare("UPDATE service_providers SET sub_started_at=datetime('now') WHERE id=?").run(p.id);
  }
  res.json({ provider: db.prepare('SELECT * FROM service_providers WHERE id=?').get(p.id) });
});

// The Trove Collection, the owner's own shop. The admin runs it from the
// seller dashboard (/sell) as themselves: requireSeller hands an admin the
// house shop ("house mode", middleware.js), so the admin session is never
// swapped or signed out.
// GET /api/admin/house-shop → { shop: {...} | null }
// POST /api/admin/house-shop → create it now if missing (same rules as the
// boot step, src/house-shop.js), for when the boot had to skip.
function houseShape(s) {
  if (!s) return null;
  const n = db.prepare(`SELECT COUNT(*) AS total, SUM(status='live') AS live FROM products WHERE shop_id=?`).get(s.id);
  return { id: s.id, name: s.name, slug: s.slug, status: s.status, products: n.total || 0, liveProducts: n.live || 0,
    pickupReady: !!(s.pickup_address && s.pickup_phone) };
}
router.get('/house-shop', requireAdmin, (_req, res) => {
  res.json({ shop: houseShape(require('../house-shop').findHouse(db)) });
});
router.post('/house-shop', requireAdmin, (req, res) => {
  const hs = require('../house-shop');
  const r = hs.ensureHouseShop(db, { adminEmail: req.user.email });
  if (r.status === 'skipped') return res.status(409).json({ error: `Could not create the Trove Collection: ${r.reason}` });
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(hs.MARKER);
  res.status(r.status === 'created' ? 201 : 200).json({ created: r.status === 'created', shop: houseShape(r.shop) });
});

// POST /api/admin/impersonate/:shopId → "shop view": switch this session to
// the shop owner's account so the admin sees the seller dashboard exactly as
// they do. The admin's own id stays on the session (impersonatorId), and
// /api/auth/stop-impersonating is the way back — no re-login. While in shop
// view the session genuinely IS the seller, so admin endpoints lock out.
router.post('/impersonate/:shopId', requireAdmin, (req, res, next) => {
  const shop = db.prepare('SELECT s.*, u.email AS owner_email FROM shops s JOIN users u ON u.id = s.user_id WHERE s.id=?').get(req.params.shopId);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  // The Trove Collection needs no shop view: the admin runs it as themselves
  // (house mode, see GET /api/admin/house-shop).
  if (shop.is_house) return res.json({ ok: true, house: true, shop: { id: shop.id, name: shop.name, slug: shop.slug } });
  console.log(`shop view: admin ${req.user.email} → ${shop.slug} (${shop.owner_email})`);
  startSession(req, { impersonatorId: req.user.id, userId: shop.user_id }).then(() => res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(shop.user_id)), shop: { id: shop.id, name: shop.name, slug: shop.slug } })).catch(next);
});

// GET /api/admin/orders → recent orders across the whole marketplace.
// An unpaid checkout ('pending': the payment form opened, nothing paid yet)
// is not an order — it stays out of the list until it is paid, and the
// hourly sweep cancels it after 24 hours. Cancelled orders stay visible:
// `attention` says when one needs a person (e.g. an automatic refund failed).
router.get('/orders', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
      (SELECT GROUP_CONCAT(DISTINCT s.name) FROM order_items oi JOIN shops s ON s.id = oi.shop_id
        WHERE oi.order_id = o.id) AS shop_names
    FROM orders o
    WHERE o.status != 'pending' AND NOT (o.status = 'cancelled' AND o.attention = '' AND o.title_transferred_at IS NULL)
    ORDER BY o.created_at DESC, o.id DESC LIMIT 200`).all();
  // Each shop parcel: its pack-by day and whether it has gone unpacked, and
  // the courier's side — booked or not (with a Retry), collected or not,
  // and anything a person must look at (src/courier-ops.js ATTENTION).
  const shipStmt = db.prepare(`SELECT sh.*, s.name AS shop_name, s.pickup_phone, s.pitch_phone
    FROM shipments sh JOIN shops s ON s.id = sh.shop_id WHERE sh.order_id=? ORDER BY sh.id`);
  const courier = require('../courier-ops');
  const cancellations = require('../cancellations');
  const live = require('../delivery').isLive();
  const cancelledStmt = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(refund_cents),0) AS cents FROM order_cancellations WHERE order_id=? AND status='refunded'");
  res.json({ orders: rows.map((o) => ({
    parcels: shipStmt.all(o.id).map((sh) => ({
      id: sh.id, shop: sh.shop_name, shopPhone: sh.pickup_phone || sh.pitch_phone || '',
      status: sh.status, statusLabel: shipments.statusLabel(sh), packBy: sh.pack_by_at || null,
      packed: sh.status !== 'processing' || !!sh.ready_at || !!sh.packed_at,
      packOverdue: !o.refunded_at && ['paid'].includes(o.status) && shipments.packOverdue(sh),
      courierRef: sh.delivery_ref || '', carrier: sh.carrier || '',
      collectedAt: sh.collected_at || null, readyAt: sh.ready_at || null,
      bookingError: sh.booking_error || null,
      // Retry is offered while a paid parcel still needs its courier booked.
      canRetryCourier: !o.refunded_at && o.status === 'paid' && sh.status === 'processing'
        && (!!sh.booking_error || (!!sh.packed_at && !sh.ready_at) || (live && !sh.delivery_ref)),
      attention: sh.attention || null, attentionLabel: sh.attention ? (courier.ATTENTION[sh.attention] || sh.attention) : null,
      cancellable: !o.refunded_at && ['paid', 'fulfilled'].includes(o.status) && o.rail !== 'connect' && cancellations.parcelOpen(sh),
    })),
    cancelled: (() => { const c = cancelledStmt.get(o.id); return c.n ? { count: c.n, refundCents: c.cents } : null; })(),
    hold: o.hold_reason || null,
    dispute: o.dispute_status ? { status: o.dispute_status, dueBy: o.dispute_due_by || null } : null,
    externalRefundCents: o.external_refund_cents || 0,
    // Trove is the merchant of record: support and the courier desk reach the
    // customer from here. Sellers get neither the email nor the phone.
    publicId: o.public_id, email: o.email, phone: o.phone || '', status: o.status,
    totalCents: o.total_cents, itemCount: o.item_count,
    shops: o.shop_names ? o.shop_names.split(',') : [],
    createdAt: o.created_at,
    refundedAt: o.refunded_at || null,
    attention: o.attention || null,
    rail: o.rail,
  })) });
});

/* ---------------- Graduation to the Connect rail (Rail B) ---------------- */

const graduation = require('../graduation');
const cfg = require('../config');

// GET /api/admin/graduation → cap-flagged suppliers + licensed direct entries.
router.get('/graduation', requireAdmin, (_req, res) => {
  res.json({ queue: graduation.queue(), railBEnabled: cfg.railBEnabled(), thresholdCents: cfg.graduationThresholdCents() });
});

// POST /api/admin/graduation/:shopId/verify-license → a human checked the license.
router.post('/graduation/:shopId/verify-license', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.shopId);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  if (!shop.license_number) return res.status(400).json({ error: 'This shop has no license number on file' });
  db.prepare("UPDATE shops SET license_verified_at=datetime('now') WHERE id=?").run(shop.id);
  res.json({ ok: true });
});

// POST /api/admin/graduation/:shopId/approve → create the Stripe Connect
// CUSTOM account (UAE platforms cannot use Express/Standard) and return the
// hosted onboarding link. The tier flips in the account.updated webhook once
// Stripe enables payouts — never before.
router.post('/graduation/:shopId/approve', requireAdmin, async (req, res, next) => {
  try {
    if (!cfg.railBEnabled()) return res.status(409).json({ error: 'Rail B is not enabled (RAIL_B_ENABLED)' });
    const shop = db.prepare('SELECT s.*, u.email AS owner_email FROM shops s JOIN users u ON u.id=s.user_id WHERE s.id=?').get(req.params.shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    if (!shop.license_verified_at) return res.status(409).json({ error: 'Verify the license first' });

    const stripe = require('../stripe').requireStripe();
    let acctId = shop.stripe_account_id;
    if (!acctId) {
      const acct = await stripe.accounts.create({
        type: 'custom',
        country: 'AE',
        email: shop.owner_email,
        business_type: 'company',
        company: { name: shop.name, registration_number: shop.license_number },
        business_profile: { name: shop.name },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      acctId = acct.id;
      db.prepare('UPDATE shops SET stripe_account_id=? WHERE id=?').run(acctId, shop.id);
    }
    const CLIENT = process.env.CLIENT_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4242';
    const link = await stripe.accountLinks.create({
      account: acctId,
      refresh_url: `${CLIENT}/sell?connect=refresh`,
      return_url: `${CLIENT}/sell?connect=done`,
      type: 'account_onboarding',
    });
    res.json({ ok: true, accountId: acctId, onboardingUrl: link.url });
  } catch (e) { next(e); }
});

/* ---------------- VAT (quarterly, by rail) ----------------
 * Prices are VAT-inclusive; vat_amount_cents is captured at payment time
 * (consignment: 5/105 of the full charge — Trove is the seller; connect:
 * 5/105 of the margin only). Refunds give VAT back: vat_reversed_cents on
 * the order, one credit note per refunded return (CN-<order>-R<id>) or per
 * whole-order refund (CN-<order>). Rows are by the SALE's quarter (output
 * VAT) and creditNotes by the REFUND's quarter, which is when a credit note
 * adjusts the return. No filing integration — just correct numbers. */
router.get('/vat-report', requireAdmin, (_req, res) => {
  const quarterOf = (col) => `strftime('%Y', ${col}) || '-Q' || ((CAST(strftime('%m', ${col}) AS INTEGER) + 2) / 3)`;
  const rows = db.prepare(`
    SELECT ${quarterOf('title_transferred_at')} AS quarter,
           rail,
           COUNT(*) AS orders,
           SUM(total_cents) AS gross_cents,
           SUM(vat_amount_cents) AS vat_cents,
           SUM(vat_reversed_cents) AS reversed_cents
    FROM orders
    WHERE status IN ('paid','fulfilled') AND vat_amount_cents > 0 AND title_transferred_at IS NOT NULL
    GROUP BY quarter, rail
    ORDER BY quarter DESC, rail`).all();
  const notes = db.prepare(`
    SELECT ${quarterOf('rr.refunded_at')} AS quarter, rr.credit_note_ref AS ref, o.public_id, rr.refund_cents, rr.vat_reversed_cents, rr.refunded_at
    FROM return_requests rr JOIN orders o ON o.id = rr.order_id
    WHERE rr.status = 'refunded' AND rr.vat_reversed_cents > 0
    UNION ALL
    SELECT ${quarterOf('oc.refunded_at')}, oc.credit_note_ref, o.public_id, oc.refund_cents, oc.vat_reversed_cents, oc.refunded_at
    FROM order_cancellations oc JOIN orders o ON o.id = oc.order_id
    WHERE oc.status = 'refunded' AND oc.vat_reversed_cents > 0
    UNION ALL
    -- A whole-order refund's credit note carries only the VAT earlier credit
    -- notes had not already reversed (whole_refund_*; older rows predate it).
    SELECT ${quarterOf('o.refunded_at')}, o.credit_note_ref, o.public_id, COALESCE(o.whole_refund_cents, o.total_cents),
      COALESCE(o.whole_refund_vat_cents, o.vat_reversed_cents), o.refunded_at
    FROM orders o WHERE o.credit_note_ref IS NOT NULL
    ORDER BY 6 DESC`).all();
  res.json({
    vatRegistered: cfg.vatRegistered(),
    rows: rows.map((r) => ({ quarter: r.quarter, rail: r.rail, orders: r.orders, grossCents: r.gross_cents, vatCents: r.vat_cents,
      reversedCents: r.reversed_cents || 0, netVatCents: r.vat_cents - (r.reversed_cents || 0) })),
    creditNotes: notes.map((n) => ({ quarter: n.quarter, reference: n.ref, order: n.public_id, refundCents: n.refund_cents, vatCents: n.vat_reversed_cents, refundedAt: n.refunded_at })),
  });
});

/* ---------------- Refunds (whole order, admin-triggered) ----------------
 * Trove is the seller of record, so refunds are Trove's to make. Stripe is
 * refunded FIRST — if that fails nothing local changes. Then: refunded_at is
 * stamped (which permanently excludes the order's credits from settlement),
 * and any credit that was ALREADY swept into a settlement is mirrored with a
 * debit_refund so it nets against the supplier's next run (an unswept credit
 * needs no debit — the supplier was never paid for it). Parcels on the move
 * get a reverse pickup; unshipped ones are cancelled.                       */
router.post('/orders/:publicId/refund', requireAdmin, async (req, res, next) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(req.params.publicId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.refunded_at) return res.status(409).json({ error: 'Order already refunded' });
    if (!['paid', 'fulfilled'].includes(order.status)) return res.status(409).json({ error: 'Only paid orders can be refunded' });
    if (!order.stripe_payment_intent_id) return res.status(409).json({ error: 'No card payment to refund' });
    // A return still on its way (approved/collected) refunds its own items
    // when the courier has them — a full-order refund now would pay the buyer
    // twice for those. Returns already REFUNDED (and cancellations) are fine:
    // Stripe refunds only what is still paid, and the credit note carries
    // only the VAT not already reversed (returns.applyRefundEffects).
    const inFlight = db.prepare("SELECT COUNT(*) AS c FROM return_requests WHERE order_id=? AND status IN ('approved','collected')").get(order.id).c;
    if (inFlight) return res.status(409).json({ error: 'Items from this order are on their way back in an approved return — let that finish, or use Refund now on the return, before refunding the rest' });

    const stripe = require('../stripe').requireStripe();
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      ...(order.rail === 'connect' ? { reverse_transfer: true, refund_application_fee: true } : {}),
      // Tagged so the charge.refunded webhook knows Trove made this refund
      // (an untagged one is an external refund made in the Stripe dashboard).
      metadata: { trove_kind: 'order_refund', order_id: String(order.id) },
    }, { idempotencyKey: `trove-order-refund-${order.id}` });

    // Parcels the courier hasn't collected are stopped (courier booking
    // cancelled, maker told); delivered ones get a return collection.
    const parcels = await returns.applyRefundEffects(order, { refundRef: (refund && refund.id) || null });

    const fresh = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    res.json({ ok: true, order: { publicId: fresh.public_id, refundedAt: fresh.refunded_at }, parcels });
  } catch (e) { next(e); }
});

/* ---------------- Cancel pieces before dispatch (owner, 2026-10-02) ----------
 * Per order line and unit: refund just those pieces (partial Stripe refund),
 * reverse their makers' credit + VAT, take them off the parcel, cancel a
 * parcel that is now empty (its courier booking too) and email the buyer and
 * the makers. 'Parcel never ships' = every remaining unit of one parcel.
 * See src/cancellations.js.                                                */
const cancellations = require('../cancellations');
const orderByPid = (pid) => db.prepare('SELECT * FROM orders WHERE public_id=?').get(pid);
const sendErr = (res, e, next) => (e.status ? res.status(e.status).json({ error: e.message }) : next(e));

// GET /api/admin/orders/:publicId/cancellable → the picker: every line with
// how many units can still be cancelled (and why not), the delivery fee
// still refundable, and the cancellations already made.
router.get('/orders/:publicId/cancellable', requireAdmin, (req, res) => {
  const order = orderByPid(req.params.publicId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    publicId: order.public_id, blocked: cancellations.orderBlocked(order),
    lines: cancellations.lines(order), deliveryPaid: (order.shipping_cents || 0) / 100,
    deliveryLeft: cancellations.deliveryLeft(order) / 100,
    reasons: cancellations.REASONS, cancellations: cancellations.forOrder(order.id),
  });
});

// POST /api/admin/orders/:publicId/cancel-items
//   { items:[{ id, qty }], reason?, note?, refundDelivery?: boolean, dryRun?: boolean }
// dryRun returns what it would refund without touching anything.
router.post('/orders/:publicId/cancel-items', requireAdmin, async (req, res, next) => {
  try {
    const order = orderByPid(req.params.publicId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const b = req.body || {};
    const refundDelivery = b.refundDelivery === true ? true : b.refundDelivery === false ? false : null;
    if (b.dryRun) {
      const p = cancellations.plan(order, b.items, { refundDelivery });
      return res.json({ ok: true, dryRun: true, itemsCents: p.itemsCents, deliveryCents: p.deliveryCents, refundCents: p.refundCents, whole: p.whole });
    }
    const r = await cancellations.cancel(order, b.items, { reason: b.reason, note: b.note, refundDelivery, byUserId: req.user.id });
    res.json({ ok: true, ...r });
  } catch (e) { sendErr(res, e, next); }
});

// POST /api/admin/orders/:publicId/parcels/:shipmentId/cancel { note?, refundDelivery? }
// The parcel never ships: cancel and refund everything left in it.
router.post('/orders/:publicId/parcels/:shipmentId/cancel', requireAdmin, async (req, res, next) => {
  try {
    const order = orderByPid(req.params.publicId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const b = req.body || {};
    const refundDelivery = b.refundDelivery === true ? true : b.refundDelivery === false ? false : null;
    const r = await cancellations.cancelParcel(order, Number(req.params.shipmentId), { note: b.note, refundDelivery, byUserId: req.user.id });
    res.json({ ok: true, ...r });
  } catch (e) { sendErr(res, e, next); }
});

/* ---------------- Tax documents (admin copy) ---------------- */
router.get('/orders/:publicId/tax-invoice', requireAdmin, (req, res) => {
  const html = require('../tax-docs').invoiceHtml(orderByPid(req.params.publicId));
  if (!html) return res.status(404).json({ error: 'No tax invoice for this order (VAT was not captured on it)' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('html').send(html);
});
router.get('/orders/:publicId/credit-notes/:ref', requireAdmin, (req, res) => {
  const o = orderByPid(req.params.publicId);
  const html = o ? require('../tax-docs').creditNoteHtml(o, String(req.params.ref)) : null;
  if (!html) return res.status(404).json({ error: 'No such credit note on this order' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('html').send(html);
});

/* ---------------- Courier health ----------------
 * Retry a parcel whose courier booking failed (or that is packed with no
 * collection booked), clear a flag once handled, and read the OTO wallet. */
router.post('/shipments/:id/retry-courier', requireAdmin, async (req, res, next) => {
  try {
    const sh = db.prepare('SELECT sh.*, o.status AS order_status, o.refunded_at FROM shipments sh JOIN orders o ON o.id = sh.order_id WHERE sh.id=?').get(req.params.id);
    if (!sh) return res.status(404).json({ error: 'Parcel not found' });
    if (sh.refunded_at || sh.order_status !== 'paid' || sh.status !== 'processing') return res.status(409).json({ error: 'Only a paid parcel that is still waiting for its courier can be re-booked' });
    const courier = require('../courier-ops');
    try {
      if (sh.packed_at) await courier.handOver(sh.id);
      else if (!(await courier.book(sh.id))) {
        const err = db.prepare('SELECT booking_error FROM shipments WHERE id=?').get(sh.id).booking_error;
        if (err) return res.status(502).json({ error: `The courier still refused: ${err}` });
      }
    } catch (e) { return res.status(502).json({ error: `The courier still refused: ${e.message}` }); }
    const fresh = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
    res.json({ ok: true, shipment: { id: fresh.id, status: fresh.status, courierRef: fresh.delivery_ref || '', readyAt: fresh.ready_at || null, bookingError: fresh.booking_error || null } });
  } catch (e) { next(e); }
});

router.post('/shipments/:id/clear-attention', requireAdmin, (req, res) => {
  const r = db.prepare("UPDATE shipments SET attention='', attention_at=NULL WHERE id=? AND attention != ''").run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Nothing flagged on that parcel' });
  res.json({ ok: true });
});

// GET /api/admin/courier → which courier is connected + the OTO wallet as
// last read by the hourly check. POST /api/admin/courier/check-wallet reads it now.
router.get('/courier', requireAdmin, (_req, res) => res.json(require('../courier-ops').walletStatus()));
router.post('/courier/check-wallet', requireAdmin, async (_req, res) => {
  const courier = require('../courier-ops');
  try { await courier.checkWallet(); res.json(courier.walletStatus()); }
  catch (e) { res.status(502).json({ error: `OTO did not answer: ${e.message}`, ...courier.walletStatus() }); }
});

// POST /api/admin/orders/:publicId/release-hold { note? } → a person has
// reconciled a dispute that was won, or a refund made in the Stripe
// dashboard: the makers' credits on this order may settle again.
router.post('/orders/:publicId/release-hold', requireAdmin, (req, res) => {
  const order = orderByPid(req.params.publicId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.hold_reason) return res.status(409).json({ error: 'Nothing is holding this order' });
  if (order.hold_reason === 'dispute' && !['won', 'warning_closed'].includes(order.dispute_status || '')) {
    return res.status(409).json({ error: 'The card dispute is still open — the hold lifts when Stripe closes it in Trove’s favour' });
  }
  db.prepare("UPDATE orders SET hold_reason='', attention=CASE WHEN attention IN ('dispute','external_refund') THEN '' ELSE attention END WHERE id=?").run(order.id);
  res.json({ ok: true });
});

/* ---------------- Return requests (buyer-initiated) ----------------
 * Requests arrive from the account page with photos and name the exact units
 * going back; Trove decides. Approval decides the collection fee (AED 30 only
 * for 'changed my mind' on orders of AED 200 and below, unless the admin
 * overrides it) and BOOKS the courier collection — no money moves yet. The
 * card refund goes out when the courier reports the piece collected (OTO
 * return webhook / mock hand-crank), which also reverses the suppliers'
 * credit for just those units and any captured VAT. 'Refund now' is the
 * admin override for exceptions. The buyer is emailed at every step
 * (best-effort, see src/email.js).
 */
const returns = require('../returns');
const email = require('../email');
const emailItems = (requestId) => returns.emailItems(requestId);
const shapeReturn = (id) => returns.shape(db.prepare('SELECT * FROM return_requests WHERE id=?').get(id));

router.get('/returns', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT rr.*, o.public_id, o.email, o.subtotal_cents, o.shipping_cents, o.total_cents, o.rail,
           o.delivered_at, o.refunded_at AS order_refunded_at, u.name AS buyer_name
    FROM return_requests rr
    JOIN orders o ON o.id = rr.order_id
    LEFT JOIN users u ON u.id = rr.buyer_id
    ORDER BY CASE rr.status WHEN 'requested' THEN 0 WHEN 'collected' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, rr.created_at DESC
    LIMIT 500`).all();
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id=?');
  res.json({ returns: rows.map((r) => {
    const m = returns.money(r, r); // r carries the order's subtotal_cents for the fee rule
    const ruleFee = returns.feeCents(r, r.reason, null);
    return {
      ...returns.shape(r),
      order: {
        publicId: r.public_id, email: r.email, buyer: r.buyer_name || null, rail: r.rail,
        itemsTotal: r.subtotal_cents / 100, deliveryPaid: (r.shipping_cents || 0) / 100, total: r.total_cents / 100, itemCount: countStmt.get(r.order_id).c,
        deliveredAt: r.delivered_at || null, refundedAt: r.order_refunded_at || null,
      },
      // Preview of what approval would refund (stamped for real on approve),
      // plus what the rule says so the override toggle can show both.
      feePreview: m.fee / 100,
      refundPreview: m.refund / 100,
      feeRule: ruleFee / 100,
      feeIfCharged: returns.feeCents(r, r.reason, true) / 100,
      faultReason: returns.FAULT_REASONS.has(r.reason),
      // The original delivery fee: what approval would refund on top of the
      // items (whole order back for a fault), what the rule says, and what
      // an override to refund it would give back.
      deliveryPreview: m.delivery / 100,
      deliveryRule: returns.deliveryRefundRule(r),
      deliveryIfRefunded: returns.deliveryLeftCents(r) / 100,
    };
  }) });
});

// POST /api/admin/returns/:id/approve { chargeFee?: boolean, refundDelivery?: boolean }
// Either omitted = the rule; true/false = the admin's override.
router.post('/returns/:id/approve', requireAdmin, async (req, res, next) => {
  try {
    const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(req.params.id);
    if (!rr) return res.status(404).json({ error: 'Return request not found' });
    if (rr.status !== 'requested') return res.status(409).json({ error: 'This request was already decided' });
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(rr.order_id);
    if (order.refunded_at) return res.status(409).json({ error: 'Order already refunded' });
    if (order.rail === 'connect') return res.status(409).json({ error: 'Connect-rail orders need the manual refund button' });
    const cf = (req.body || {}).chargeFee;
    const feeOverride = cf === true ? true : cf === false ? false : null;
    const rd = (req.body || {}).refundDelivery;
    const deliveryOverride = rd === true ? true : rd === false ? false : null;

    const fresh = await returns.approve(rr, order, { feeOverride, deliveryOverride });
    const m = { gross: returns.grossCents(returns.requestItems(rr.id)), fee: fresh.fee_cents, delivery: fresh.delivery_refund_cents || 0, refund: fresh.refund_cents };
    const msg = email.returnApproved({ order, items: emailItems(rr.id), money: m });
    email.send({ to: order.email, ...msg }).catch((e) => console.error('return-approved email failed:', e.message));

    res.json({ ok: true, request: returns.shape(fresh) });
  } catch (e) { next(e); }
});

// POST /api/admin/returns/:id/book-collection → retry a failed courier booking.
router.post('/returns/:id/book-collection', requireAdmin, async (req, res, next) => {
  try {
    const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(req.params.id);
    if (!rr) return res.status(404).json({ error: 'Return request not found' });
    if (rr.status !== 'approved') return res.status(409).json({ error: 'Only an approved return waiting for collection can be re-booked' });
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(rr.order_id);
    await returns.bookCollections(order, rr.id);
    res.json({ ok: true, request: shapeReturn(rr.id) });
  } catch (e) { next(e); }
});

// POST /api/admin/returns/:id/refund-now { note? } → the exception path: refund
// before the courier confirms collection (a lost webhook, a buyer who drops
// the piece at the maker's door, a goodwill call).
router.post('/returns/:id/refund-now', requireAdmin, async (req, res, next) => {
  try {
    const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(req.params.id);
    if (!rr) return res.status(404).json({ error: 'Return request not found' });
    if (!['approved', 'collected'].includes(rr.status)) return res.status(409).json({ error: 'Only an approved return can be refunded' });
    const note = String((req.body || {}).note || '').trim().slice(0, 300);
    await returns.refund(rr.id, { by: 'admin', note: note || undefined });
    res.json({ ok: true, request: shapeReturn(rr.id) });
  } catch (e) { next(e); }
});

router.post('/returns/:id/decline', requireAdmin, (req, res) => {
  const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(req.params.id);
  if (!rr) return res.status(404).json({ error: 'Return request not found' });
  if (rr.status !== 'requested') return res.status(409).json({ error: 'This request was already decided' });
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Give the buyer a short reason for the decline' });
  db.prepare(`UPDATE return_requests SET status='declined', decline_reason=?, decided_at=datetime('now') WHERE id=?`)
    .run(reason.slice(0, 500), rr.id);

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(rr.order_id);
  const msg = email.returnDeclined({ order, items: emailItems(rr.id), declineReason: reason.slice(0, 500) });
  email.send({ to: order.email, ...msg }).catch((e) => console.error('return-declined email failed:', e.message));

  res.json({ ok: true, request: returns.shape(db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr.id)) });
});

/* ---------------- Fortnightly settlements (consignment purchases) ----------
 * The old order_items sweep (payouts/preview + payouts/run) is retired: money
 * owed to suppliers now lives on the seller_balances ledger and is settled by
 * src/settlement.js. Old payout batches stay readable below for history.    */

const settlement = require('../settlement');

// GET /api/admin/settlements/preview → what the next run would pay, and who
// is held back (payout setup incomplete / netted negative → carry forward).
router.get('/settlements/preview', requireAdmin, (_req, res) => {
  res.json({ ...settlement.preview(), nextRunDate: settlement.nextRunDate(), schedule: settlement.scheduleLabel() });
});

// POST /api/admin/settlements/run { runDate? } → create the draft settlement.
router.post('/settlements/run', requireAdmin, (req, res) => {
  const result = settlement.run(req.body?.runDate);
  if (!result) return res.json({ created: false });
  res.status(201).json({ created: true, ...result });
});

// GET /api/admin/settlements → run history with per-supplier items.
router.get('/settlements', requireAdmin, (_req, res) => {
  const sts = db.prepare('SELECT * FROM settlements ORDER BY id DESC').all();
  const itemsStmt = db.prepare(`SELECT si.*, s.name AS shop_name, s.slug AS shop_slug,
      (SELECT pn.id FROM purchase_notes pn WHERE pn.settlement_item_id = si.id ORDER BY pn.id DESC LIMIT 1) AS note_id
    FROM settlement_items si JOIN shops s ON s.id=si.shop_id WHERE si.settlement_id=? ORDER BY si.id`);
  res.json({ settlements: sts.map((st) => ({
    id: st.id, runDate: st.run_date, status: st.status, totalCents: st.total_cents,
    createdAt: st.created_at, exportedAt: st.exported_at, paidAt: st.paid_at,
    items: itemsStmt.all(st.id).map((i) => ({
      id: i.id, shopId: i.shop_id, shopName: i.shop_name, shopSlug: i.shop_slug,
      amountCents: i.amount_cents, creditCents: i.credit_cents, debitCents: i.debit_cents,
      itemCount: i.item_count, bankReference: i.bank_reference,
      bank: i.bank_snapshot ? JSON.parse(i.bank_snapshot) : null,
      purchaseNoteId: i.note_id || null,
    })),
  })) });
});

// GET /api/admin/settlements/:id/export.csv → the bank-upload file. IBANs are
// decrypted here and only here, straight into the response.
router.get('/settlements/:id/export.csv', requireAdmin, (req, res, next) => {
  try {
    const csv = settlement.exportCsv(Number(req.params.id));
    res.type('text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="trove-settlement-${req.params.id}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

// POST /api/admin/settlements/:id/paid → after the bank transfers went out.
router.post('/settlements/:id/paid', requireAdmin, (req, res, next) => {
  try {
    const st = settlement.markPaid(Number(req.params.id));
    res.json({ ok: true, settlement: { id: st.id, status: st.status, paidAt: st.paid_at } });
  } catch (e) { next(e); }
});

// GET /api/admin/purchase-notes/:id → stream a self-billed purchase note.
router.get('/purchase-notes/:id', requireAdmin, (req, res) => {
  const note = db.prepare('SELECT * FROM purchase_notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  res.sendFile(require('path').resolve(note.html_path));
});

// GET /api/admin/payouts → LEGACY batch history (pre-ledger weekly payouts).
router.get('/payouts', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*, s.name AS shop_name, s.slug AS shop_slug
    FROM payouts p JOIN shops s ON s.id = p.shop_id
    ORDER BY p.created_at DESC, p.id DESC`).all();
  res.json({
    payouts: rows.map((p) => ({
      id: p.id,
      shopId: p.shop_id,
      shopName: p.shop_name,
      shopSlug: p.shop_slug,
      amountCents: p.amount_cents,
      grossCents: p.gross_cents,
      feeCents: p.fee_cents,
      itemCount: p.item_count,
      status: p.status,
      bank: p.bank_snapshot ? JSON.parse(p.bank_snapshot) : null,
      createdAt: p.created_at,
      paidAt: p.paid_at,
    })),
  });
});

// POST /api/admin/payouts/:id/paid → mark a batch as sent (after the bank transfer).
router.post('/payouts/:id/paid', requireAdmin, (req, res) => {
  const r = db.prepare("UPDATE payouts SET status='paid', paid_at=datetime('now') WHERE id=? AND status='pending'")
    .run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Payout not found or already paid' });
  res.json({ ok: true });
});

module.exports = router;
