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
const identity = require('../identity');

const router = express.Router();
// Arabic (src/translate.js): a save queues its translation; it never waits for it.
const tq = (entity, id) => require('../translate').queue(entity, id);


/**
 * What a maker still owes Trove before approval puts their pieces on sale:
 * acceptance of the Seller Agreement (the consignment terms every sale rests
 * on) and the courier pickup address + phone (where the first collection
 * goes). [] when ready. The Trove Collection is Trove's own line: no
 * agreement, and its pickup is the owner's to set.
 */
function approvalMissing(shop) {
  if (shop.is_house) return [];
  const missing = [];
  if (!shop.agreement_accepted_at) missing.push('agreement');
  if (!(shop.pickup_address && shop.pickup_phone)) missing.push('pickup');
  return missing;
}
const MISSING_LABEL = { agreement: 'accepted the Seller Agreement', pickup: 'added a courier pickup address and phone' };

/* ---------------- Marketplace overview ---------------- */

// GET /api/admin/stats → the numbers on the admin overview.
router.get('/stats', requireAdmin, (_req, res) => {
  const shopRows = db.prepare('SELECT status, COUNT(*) AS c FROM shops GROUP BY status').all();
  const shops = { total: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 };
  for (const r of shopRows) { shops[r.status] = r.c; shops.total += r.c; }
  // Sales are net of refunds (whole-order, returns, cancellations, refunds
  // made in Stripe); Orders leaves out orders refunded in full (F110).
  const sales = require('../admin-ops').salesTotals();
  const orders = sales.orders;
  const gmv = sales.netCents;
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
  res.json({ shops, orders, gmvCents: gmv, grossCents: sales.grossCents, refundedCents: sales.refundedCents, buyers, liveProducts: products, providers,
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

// GET /api/admin/needs-you → ONE to-do list for the Overview (F111): every
// kind of item waiting on the owner, gathered from every tab, with a count and
// where to go — plus when each background job last worked (F145) and the
// Orders badge counts.
router.get('/needs-you', requireAdmin, (_req, res) => {
  const ops = require('../admin-ops');
  res.json({ items: ops.needsYou(), jobs: require('../job-runs').status(), orders: ops.orderCounts() });
});

// GET /api/admin/activity → the latest admin actions (F065): who did what,
// when, in which shop view, and what it was before.
router.get('/activity', requireAdmin, (req, res) => {
  res.json({ actions: require('../admin-audit').latest(Number(req.query.limit) || 100) });
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
  const was = db.prepare('SELECT status FROM reviews WHERE id=?').get(req.params.id);
  if (was) res.locals.auditBefore = { status: was.status };
  const r = db.prepare('UPDATE reviews SET status=? WHERE id=?').run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  if (status === 'published') tq('review', Number(req.params.id));
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
  res.locals.auditBefore = { status: p.status, category: p.category, tags: p.tags };
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
  tq('product', p.id);
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
    tq('content', req.params.section);
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
      ${require('../admin-ops').SHOP_SALES_SQL} AS sales_cents
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
    // What stops the settlement run paying this maker, named (F107): the same
    // checks settlement.preview makes — bank details, the signed agreement and
    // an established identity. The Trove Collection is never paid out.
    payoutMissing: s.is_house || s.tier !== 'consignment' ? [] : [
      !s.iban_encrypted && 'bank details', !s.agreement_accepted_at && 'signed agreement',
      !identity.status(s).verified && 'identity check',
    ].filter(Boolean),
    licenseNumber: s.license_number || '', hasLicenseImage: !!s.license_image,
    licenseVerifiedAt: s.license_verified_at || null,
    sellerAddress: s.seller_address || '', eidFront: !!s.eid_front_file, eidBack: !!s.eid_back_file,
    // The typed Emirates ID details, shown beside the photos so the admin can
    // compare them, plus the identity status settlement uses.
    eid: { last4: s.emirates_id_last4 || '', issue: s.emirates_id_issue || '', expiry: s.emirates_id_expiry || '', state: identity.eidExpiryState(s) },
    identity: (() => { const id = identity.status(s); return { verified: id.verified, method: id.method, reason: id.reason }; })(),
    identityCheckedAt: s.identity_checked_at || null,
    // Whose bank account the payouts go to, and whether it looks like the maker.
    payoutAccountName: s.payout_account_name || '', payoutBankName: s.payout_bank_name || '', ibanMasked: s.iban_masked || '',
    accountNameMatches: identity.payoutNameMatches(s, s.owner_name),
    agreementVersion: s.agreement_version || '', agreementAcceptedAt: s.agreement_accepted_at || null,
    pickupReady: !!(s.pickup_address && s.pickup_phone),
    approvalMissing: approvalMissing(s),
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
  res.locals.auditBefore = { status: shop.status, note: shop.review_note || '' };
  // Approval puts the shop's live pieces on sale, so it waits for the
  // agreement and the pickup details (re-approving an approved shop is a no-op).
  if (status === 'approved' && shop.status !== 'approved') {
    const missing = approvalMissing(shop);
    if (missing.length) {
      return res.status(409).json({ code: 'not_ready', missing,
        error: `Not yet: the maker has not ${missing.map((m) => MISSING_LABEL[m]).join(' or ')}. Approve once they have.` });
    }
  }
  db.prepare('UPDATE shops SET status=? WHERE id=?').run(status, shop.id);
  if (req.body.note !== undefined) db.prepare('UPDATE shops SET review_note=? WHERE id=?').run(reviewNote(req.body), shop.id);
  if (status !== shop.status) require('../notify').shopDecided(shop.id, status);
  if (status === 'approved') { tq('shop', shop.id); for (const x of db.prepare("SELECT id FROM products WHERE shop_id=? AND status='live'").all(shop.id)) tq('product', x.id); }
  res.json({ shop: db.prepare('SELECT * FROM shops WHERE id=?').get(shop.id) });
});

// POST /api/admin/shops/:id/identity-check { checked: true|false } — the
// admin compared the Emirates ID photos with the typed details and the home
// address (and the account holder name) and ticks 'ID checked'. Records who
// and when; settlement pays an Emirates-ID maker only once this is ticked
// and the ID is in date (src/identity.js).
router.post('/shops/:id/identity-check', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  if (shop.is_house) return res.status(409).json({ error: 'The Trove Collection needs no identity check' });
  if ((req.body || {}).checked === false) {
    db.prepare(`UPDATE shops SET identity_checked_at=NULL, identity_checked_by=NULL,
        verification_method=CASE WHEN verification_method='emirates_id' THEN NULL ELSE verification_method END WHERE id=?`).run(shop.id);
  } else {
    if (!identity.eidSubmitted(shop)) return res.status(409).json({ error: 'The maker has not given both Emirates ID photos, the ID details and a home address yet' });
    if (identity.eidExpiryState(shop) === 'expired') return res.status(409).json({ error: 'This Emirates ID has expired — ask the maker to add their renewed ID' });
    db.prepare(`UPDATE shops SET identity_checked_at=datetime('now'), identity_checked_by=?,
        verification_method=CASE WHEN license_verified_at IS NOT NULL THEN 'trade_licence' ELSE 'emirates_id' END WHERE id=?`).run(req.user.id, shop.id);
    console.log(`identity: ${req.user.email} checked the Emirates ID of shop ${shop.slug}`);
  }
  const fresh = db.prepare('SELECT * FROM shops WHERE id=?').get(shop.id);
  const id = identity.status(fresh);
  res.json({ ok: true, identity: { verified: id.verified, method: id.method, reason: id.reason }, identityCheckedAt: fresh.identity_checked_at || null });
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
router.patch('/providers/:id', requireAdmin, async (req, res, next) => { try {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected', 'suspended'].includes(status))
    return res.status(400).json({ error: 'status must be pending, approved, rejected or suspended' });
  const p = db.prepare('SELECT * FROM service_providers WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  res.locals.auditBefore = { status: p.status, note: p.review_note || '' };
  db.prepare('UPDATE service_providers SET status=? WHERE id=?').run(status, p.id);
  if (req.body.note !== undefined) db.prepare('UPDATE service_providers SET review_note=? WHERE id=?').run(reviewNote(req.body), p.id);
  if (status !== p.status) require('../notify').providerDecided(p.id, status);
  if (status === 'approved') { tq('provider', p.id); for (const x of db.prepare("SELECT id FROM services WHERE provider_id=? AND status='live'").all(p.id)) tq('service', x.id); }
  if (status === 'approved' && !p.sub_started_at) {
    db.prepare("UPDATE service_providers SET sub_started_at=datetime('now') WHERE id=?").run(p.id);
  }
  // Suspended or rejected: the provider can no longer confirm or be paid
  // through Trove (service-bookings.js), so requests and unpaid bookings
  // waiting on them are closed now and the customers told. Confirmed
  // bookings still to come are counted for the admin, who can cancel and
  // refund them with POST /providers/:id/cancel-bookings.
  let closedUnpaid = 0;
  if (['suspended', 'rejected'].includes(status)) {
    const svc = require('../service-bookings');
    const open = db.prepare("SELECT * FROM service_bookings WHERE provider_id=? AND status IN ('requested','awaiting_payment') AND paid_at IS NULL").all(p.id);
    for (const bk of open) { const r = await svc.cancel(bk, { by: 'admin' }); if (!r.error) closedUnpaid += 1; }
  }
  res.json({
    provider: db.prepare('SELECT * FROM service_providers WHERE id=?').get(p.id),
    closedUnpaid,
    confirmedOpen: ['suspended', 'rejected'].includes(status) ? confirmedOpen(p.id).length : 0,
  });
} catch (e) { next(e); } });

// Confirmed bookings with the service still to come (today included).
const confirmedOpen = (providerId) => db.prepare(`SELECT * FROM service_bookings WHERE provider_id=? AND status='confirmed'
  AND (service_date IS NULL OR service_date >= ?)`).all(providerId, require('../service-bookings').dubaiToday());

// POST /api/admin/providers/:id/cancel-bookings → cancel a suspended or
// rejected provider's confirmed bookings still to come; paid ones are
// refunded in full and every customer is emailed.
router.post('/providers/:id/cancel-bookings', requireAdmin, async (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM service_providers WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Provider not found' });
    if (p.status === 'approved') return res.status(409).json({ error: 'This provider is approved — suspend them first' });
    const svc = require('../service-bookings');
    let cancelled = 0; let refunded = 0; let refundFailed = 0;
    for (const bk of confirmedOpen(p.id)) {
      const r = await svc.cancel(bk, { by: 'admin' });
      if (r.error) continue;
      cancelled += 1;
      if (r.refunded) refunded += 1; else if (bk.paid_at) refundFailed += 1;
    }
    res.json({ cancelled, refunded, refundFailed });
  } catch (e) { next(e); }
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
// ?q= searches the order number, buyer email, mobile and delivery name;
// ?filter= all | attention | overdue | open | refunded; ?before= pages back
// (the previous page's `next`). 100 a page, newest first (F112).
router.get('/orders', requireAdmin, (req, res) => {
  const ops = require('../admin-ops');
  const page = ops.listOrders({ q: req.query.q, filter: String(req.query.filter || 'all'), before: req.query.before, limit: req.query.limit });
  const rows = page.rows;
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
    totalCents: o.total_cents, itemCount: o.item_count, refundedCents: o.refunded_cents || 0,
    shops: o.shop_names ? o.shop_names.split(',') : [],
    createdAt: o.created_at,
    refundedAt: o.refunded_at || null,
    attention: o.attention || null,
    rail: o.rail,
    deliveryEditedAt: o.delivery_edited_at || null,
  })), next: page.next, counts: ops.orderCounts() });
});

// GET /api/admin/orders/:publicId → the whole order for the detail row:
// lines with options and extras, delivery address and mobile, each parcel
// with tracking and its history, returns, cancellations and refunds.
router.get('/orders/:publicId', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(req.params.publicId);
  if (!order || order.status === 'pending') return res.status(404).json({ error: 'Order not found' });
  res.json({ order: require('../admin-ops').orderDetail(order) });
});

// PATCH /api/admin/orders/:publicId/delivery { address?: {name,line,line2,area,city,emirate,notes}, phone? }
// Correct a mistyped flat number or mobile after payment, until a parcel is
// packed (F199). A courier order that already holds the old address is
// flagged so the owner changes it with the courier too.
router.patch('/orders/:publicId/delivery', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(req.params.publicId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.locals.auditBefore = { ship: (() => { try { return JSON.parse(order.shipping_json || 'null'); } catch (_) { return null; } })(), phone: order.phone || '' };
  const r = require('../admin-ops').editDelivery(order, req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ...r, order: require('../admin-ops').orderDetail(db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)) });
});

/* ---------------- Customers: block / unblock (F199) ---------------- */
// The switch on the customer lookup card (Admin → Messages). A blocked
// customer keeps their account and history; checkout and bookings refuse
// with a neutral 'please contact us'. Both directions land in Activity;
// the log names the account id, never the email.
const customerBlock = require('../customer-block');
router.post('/customers/block', requireAdmin, (req, res) => {
  const b = req.body || {};
  res.locals.auditBefore = { blocked: customerBlock.isBlocked({ email: b.email }) };
  const r = customerBlock.block(b.email, { note: b.note, by: req.user.email });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.locals.auditNote = r.userId ? `Buyer #${r.userId}` : 'Guest (no account)';
  res.json({ ok: true, already: r.already, blocked: customerBlock.describe(r.row) });
});
router.post('/customers/unblock', requireAdmin, (req, res) => {
  const b = req.body || {};
  res.locals.auditBefore = { blocked: customerBlock.isBlocked({ email: b.email }) };
  const r = customerBlock.unblock(b.email);
  res.locals.auditNote = r.userId ? `Buyer #${r.userId}` : 'Guest (no account)';
  res.json({ ok: true, already: r.already, blocked: null });
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
  db.prepare("UPDATE shops SET license_verified_at=datetime('now'), verification_method='trade_licence' WHERE id=?").run(shop.id);
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
 * whole-order refund (CN-<order>). Card bookings on the Services
 * Marketplace are the 'services' rail: VAT captured at payment
 * (service_bookings.vat_amount_cents, fees.SERVICE_VAT_BASIS) and given back
 * on refund (credit note CN-<booking code>).
 *
 * Output VAT is counted in the SALE's quarter; a credit note reduces the
 * quarter it was ISSUED in (the refund date), which is when it adjusts the
 * return — so a row's reversedCents is the credit-note VAT of that quarter
 * and netVatCents = vatCents − reversedCents is what that quarter's return
 * shows for the rail. Timestamps are stored in UTC; quarters follow the
 * Dubai calendar (UTC+4), so a sale at 01:30 on 1 January in Dubai belongs to
 * Q1. No filing integration — just correct numbers. */
const quarterOf = (col) => `strftime('%Y', datetime(${col}, '+4 hours')) || '-Q' || ((CAST(strftime('%m', datetime(${col}, '+4 hours')) AS INTEGER) + 2) / 3)`;
/** 'YYYY-MM-DD HH:MM:SS' (UTC, SQLite) → the calendar day in Dubai. */
const dubaiDay = (utc) => new Date(Date.parse(String(utc).replace(' ', 'T') + 'Z') + 4 * 3600000).toISOString().slice(0, 10);
function vatReport() {
  const sales = db.prepare(`
    SELECT ${quarterOf('title_transferred_at')} AS quarter, rail, COUNT(*) AS n, SUM(total_cents) AS gross_cents, SUM(vat_amount_cents) AS vat_cents
    FROM orders
    WHERE status IN ('paid','fulfilled') AND vat_amount_cents > 0 AND title_transferred_at IS NOT NULL
    GROUP BY 1, 2
    UNION ALL
    SELECT ${quarterOf('paid_at')}, 'services', COUNT(*), SUM(amount_cents), SUM(vat_amount_cents)
    FROM service_bookings
    WHERE paid_at IS NOT NULL AND vat_amount_cents > 0
    GROUP BY 1`).all();
  const notes = db.prepare(`
    SELECT ${quarterOf('rr.refunded_at')} AS quarter, o.rail, rr.credit_note_ref AS ref, o.public_id AS doc, rr.refund_cents, rr.vat_reversed_cents, rr.refunded_at
    FROM return_requests rr JOIN orders o ON o.id = rr.order_id
    WHERE rr.status = 'refunded' AND rr.vat_reversed_cents > 0
    UNION ALL
    SELECT ${quarterOf('oc.refunded_at')}, o.rail, oc.credit_note_ref, o.public_id, oc.refund_cents, oc.vat_reversed_cents, oc.refunded_at
    FROM order_cancellations oc JOIN orders o ON o.id = oc.order_id
    WHERE oc.status = 'refunded' AND oc.vat_reversed_cents > 0
    UNION ALL
    -- A whole-order refund's credit note carries only the VAT earlier credit
    -- notes had not already reversed (whole_refund_*; older rows predate it).
    SELECT ${quarterOf('o.refunded_at')}, o.rail, o.credit_note_ref, o.public_id, COALESCE(o.whole_refund_cents, o.total_cents),
      COALESCE(o.whole_refund_vat_cents, o.vat_reversed_cents), o.refunded_at
    FROM orders o WHERE o.credit_note_ref IS NOT NULL AND o.refunded_at IS NOT NULL
    UNION ALL
    SELECT ${quarterOf('bk.refunded_at')}, 'services', bk.credit_note_ref, bk.code, bk.refund_cents, bk.vat_reversed_cents, bk.refunded_at
    FROM service_bookings bk WHERE bk.refunded_at IS NOT NULL AND bk.vat_reversed_cents > 0
    ORDER BY 7 DESC`).all();
  const byKey = new Map();
  const row = (quarter, rail) => {
    const k = `${quarter}|${rail}`;
    if (!byKey.has(k)) byKey.set(k, { quarter, rail, orders: 0, grossCents: 0, vatCents: 0, reversedCents: 0, creditNotes: 0 });
    return byKey.get(k);
  };
  for (const s of sales) Object.assign(row(s.quarter, s.rail), { orders: s.n, grossCents: s.gross_cents, vatCents: s.vat_cents });
  for (const n of notes) { const r = row(n.quarter, n.rail); r.reversedCents += n.vat_reversed_cents; r.creditNotes += 1; }
  const rows = [...byKey.values()]
    .map((r) => ({ ...r, netVatCents: r.vatCents - r.reversedCents }))
    .sort((a, b) => (a.quarter === b.quarter ? a.rail.localeCompare(b.rail) : b.quarter.localeCompare(a.quarter)));
  return {
    vatRegistered: cfg.vatRegistered(),
    serviceVatBasis: require('../fees').SERVICE_VAT_BASIS,
    rows,
    creditNotes: notes.map((n) => ({ quarter: n.quarter, rail: n.rail, reference: n.ref, order: n.doc, refundCents: n.refund_cents, vatCents: n.vat_reversed_cents, refundedAt: n.refunded_at, issuedOn: n.refunded_at ? dubaiDay(n.refunded_at) : null })),
  };
}
router.get('/vat-report', requireAdmin, (_req, res) => res.json(vatReport()));

// GET /api/admin/vat-report.csv → the same figures for the accountant: one
// line per quarter + rail, then every credit note.
router.get('/vat-report.csv', requireAdmin, (_req, res) => {
  const { csvCell } = require('../csv');
  const r = vatReport();
  const aed = (c) => ((c || 0) / 100).toFixed(2);
  const lines = ['section,quarter,rail,reference,document,count,gross_aed,vat_aed,reversed_vat_aed,net_vat_aed,date'];
  for (const q of r.rows) {
    lines.push(['quarter', q.quarter, q.rail, '', '', String(q.orders), aed(q.grossCents), aed(q.vatCents), aed(q.reversedCents), aed(q.netVatCents), '']
      .map((v, i) => (i >= 5 && i <= 9 ? v : csvCell(v))).join(','));
  }
  for (const n of r.creditNotes) {
    lines.push(['credit_note', n.quarter, n.rail, n.reference, n.order, '', aed(n.refundCents), '', aed(n.vatCents), '', n.issuedOn || '']
      .map((v, i) => (i >= 5 && i <= 9 ? v : csvCell(v))).join(','));
  }
  res.set('Cache-Control', 'no-store');
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="trove-vat-report.csv"');
  res.send(lines.join('\r\n') + '\r\n');
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
    // The buyer hears about the refund (and any collection) by email; makers
    // were told inside applyRefundEffects (parcel stopped / coming back).
    require('../notify').orderRefunded(order.id, parcels);

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
    // Each maker whose pieces are coming back is told too.
    require('../notify').returnApprovedMakers(rr.id);

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
// A runDate later than today (Dubai) is refused: it would sweep purchases
// whose return window is still open. Today's run cuts at the same moment the
// preview card uses (settlement.cutoffFor).
router.post('/settlements/run', requireAdmin, (req, res, next) => {
  try {
    const result = settlement.run(req.body?.runDate);
    if (!result) return res.json({ created: false });
    res.status(201).json({ created: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// POST /api/admin/settlements/:id/cancel → cancel a draft or exported run
// (a wrong IBAN, a run made by mistake): its money waits for the next run.
router.post('/settlements/:id/cancel', requireAdmin, (req, res, next) => {
  try { res.json({ ok: true, ...settlement.cancelRun(Number(req.params.id)) }); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// POST /api/admin/settlements/:id/undo-paid → within 48 hours of 'Mark paid'
// (it was clicked before the transfers went out): back to 'exported'.
router.post('/settlements/:id/undo-paid', requireAdmin, (req, res, next) => {
  try {
    const st = settlement.undoPaid(Number(req.params.id));
    res.json({ ok: true, settlement: { id: st.id, status: st.status, paidAt: st.paid_at } });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// GET /api/admin/settlements → run history with per-supplier items.
router.get('/settlements', requireAdmin, (_req, res) => {
  const sts = db.prepare('SELECT * FROM settlements ORDER BY id DESC').all();
  // bankChangedSinceRun: the shop's live bank details are no longer the ones
  // copied into the run (the bank file still pays the copy) — check with the
  // maker before sending. Ciphertexts are compared, never decrypted.
  const itemsStmt = db.prepare(`SELECT si.*, s.name AS shop_name, s.slug AS shop_slug,
      (si.iban_encrypted IS NOT NULL AND (COALESCE(s.iban_encrypted,'') <> si.iban_encrypted
        OR COALESCE(s.payout_account_name,'') <> COALESCE(si.payout_account_name,'')
        OR COALESCE(s.payout_bank_name,'') <> COALESCE(si.payout_bank_name,''))) AS bank_changed,
      (SELECT pn.id FROM purchase_notes pn WHERE pn.settlement_item_id = si.id ORDER BY pn.id DESC LIMIT 1) AS note_id
    FROM settlement_items si JOIN shops s ON s.id=si.shop_id WHERE si.settlement_id=? ORDER BY si.id`);
  res.json({ settlements: sts.map((st) => ({
    id: st.id, runDate: st.run_date, status: st.status, totalCents: st.total_cents,
    createdAt: st.created_at, exportedAt: st.exported_at, paidAt: st.paid_at,
    canUndoPaid: st.status === 'paid' && !!st.paid_at
      && Date.now() - Date.parse(String(st.paid_at).replace(' ', 'T') + 'Z') <= settlement.UNDO_PAID_HOURS * 3600000,
    items: itemsStmt.all(st.id).map((i) => ({
      id: i.id, shopId: i.shop_id, shopName: i.shop_name, shopSlug: i.shop_slug,
      amountCents: i.amount_cents, creditCents: i.credit_cents, debitCents: i.debit_cents,
      itemCount: i.item_count, bankReference: i.bank_reference,
      bank: i.bank_snapshot ? JSON.parse(i.bank_snapshot) : null,
      bankChangedSinceRun: !!i.bank_changed,
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
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// POST /api/admin/settlements/:id/items/:itemId/remove { hold? } → take one
// supplier out of a draft or exported run; their ledger rows wait for a later
// run, nothing is recorded as paid. hold:true also holds the shop's payouts.
router.post('/settlements/:id/items/:itemId/remove', requireAdmin, (req, res, next) => {
  try {
    const r = settlement.removeItem(Number(req.params.id), Number(req.params.itemId), { hold: (req.body || {}).hold === true });
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// POST /api/admin/shops/:id/payout-hold { hold: true|false } → hold a shop's
// payouts while Trove investigates (Seller Agreement v4), or release a hold —
// including the automatic one after a bank-details change, once the owner has
// checked the change with the maker.
router.post('/shops/:id/payout-hold', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  settlement.setHold(shop.id, (req.body || {}).hold === true);
  const s = db.prepare('SELECT id, status, payout_hold, payout_hold_reason FROM shops WHERE id=?').get(shop.id);
  res.json({ ok: true, shop: { id: s.id, status: s.status, payoutHold: !!s.payout_hold, payoutHoldReason: s.payout_hold_reason } });
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

/* ---------------- Translations (Arabic) ----------------
 * What people create is translated to Arabic automatically (src/translate.js).
 * The admin sees every public item's status, can ask for a fresh machine
 * translation, and can hand-edit an Arabic text — a hand edit is locked, so
 * the machine never overwrites it.                                          */
const translations = () => require('../translate');
const trEntity = (req, res) => {
  const { entity, id } = req.params;
  if (!translations().ENTITIES.includes(entity) || !/^[a-z0-9._-]{1,80}$/i.test(id)) { res.status(404).json({ error: 'Not found' }); return null; }
  return { entity, id: entity === 'content' ? id : Number(id) };
};
router.get('/translations', requireAdmin, (_req, res) => res.json(translations().overview()));
router.get('/translations/:entity/:id', requireAdmin, (req, res) => {
  const e = trEntity(req, res); if (!e) return;
  if (translations().sources(e.entity, e.id) == null) return res.status(404).json({ error: 'Not found' });
  res.json({ entity: e.entity, id: String(e.id), label: translations().label(e.entity, e.id), fields: translations().fieldStatus(e.entity, e.id) });
});
router.post('/translations/:entity/:id/retranslate', requireAdmin, (req, res) => {
  const e = trEntity(req, res); if (!e) return;
  translations().retranslate(e.entity, e.id);
  res.json({ ok: true, queued: true, enabled: translations().enabled() });
});
router.put('/translations/:entity/:id', requireAdmin, (req, res) => {
  const e = trEntity(req, res); if (!e) return;
  const { field, text, locked } = req.body || {};
  if (typeof field !== 'string' || !field) return res.status(400).json({ error: 'field is required' });
  try {
    const out = translations().setManual(e.entity, e.id, field, text, { locked: locked !== false });
    console.log(`translations: ${req.user.email} edited ${e.entity} ${e.id} ${field}`);
    res.json({ ok: true, saved: out, fields: translations().fieldStatus(e.entity, e.id) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.post('/translations/:entity/:id/lock', requireAdmin, (req, res) => {
  const e = trEntity(req, res); if (!e) return;
  const { field, locked } = req.body || {};
  if (!translations().setLocked(e.entity, e.id, String(field || ''), !!locked)) return res.status(404).json({ error: 'No Arabic saved for that field yet' });
  res.json({ ok: true, fields: translations().fieldStatus(e.entity, e.id) });
});
router.post('/translations/sweep', requireAdmin, (_req, res) => {
  const queued = translations().sweep();
  res.json({ ok: true, queued, enabled: translations().enabled() });
});

module.exports = router;
