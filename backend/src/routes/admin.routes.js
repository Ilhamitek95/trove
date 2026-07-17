'use strict';
/**
 * Admin — marketplace oversight and the weekly settlement run.
 *
 * On the consignment rail Trove purchases each sold item from its supplier
 * (list price minus the purchase margin) and resells it to the buyer. What
 * Trove owes suppliers accrues on the seller_balances ledger; once a parcel
 * is delivered and its 7-day return window closes, the credit becomes payable
 * and the weekly settlement run (src/settlement.js) batches it into a bank
 * transfer with self-billed purchase documentation.
 */
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware');

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
  res.json({ shops, orders, gmvCents: gmv, buyers, liveProducts: products,
    licensed: { total: lic.total, verified: lic.verified, awaiting: lic.total - lic.verified } });
});

// GET /api/admin/search-trends → what shoppers typed in the last 30 days.
// avgResults near 0 flags demand the catalogue isn't meeting yet.
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
    ORDER BY r.created_at DESC LIMIT 200`).all();
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
    priceCents: p.price_cents, stock: p.stock, status: p.status,
    imageSeed: p.image_seed, tags: parseTags(p.tags), createdAt: p.created_at,
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
    const catErr = require('../categories').categoryError(b.category);
    if (catErr) return res.status(422).json({ error: catErr.message });
  }
  db.prepare('UPDATE products SET status=COALESCE(?,status), category=COALESCE(?,category) WHERE id=?')
    .run(b.status, b.category, p.id);
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

// GET /api/admin/shops → every shop with its owner, catalogue and sales.
router.get('/shops', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT s.*, u.email AS owner_email, u.name AS owner_name,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS product_count,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status='live') AS live_count,
      (SELECT COALESCE(SUM(oi.price_cents * oi.qty),0) FROM order_items oi
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
router.patch('/shops/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected', 'suspended'].includes(status))
    return res.status(400).json({ error: 'status must be pending, approved, rejected or suspended' });
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  db.prepare('UPDATE shops SET status=? WHERE id=?').run(status, shop.id);
  res.json({ shop: db.prepare('SELECT * FROM shops WHERE id=?').get(shop.id) });
});

// GET /api/admin/orders → recent orders across the whole marketplace.
router.get('/orders', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
      (SELECT GROUP_CONCAT(DISTINCT s.name) FROM order_items oi JOIN shops s ON s.id = oi.shop_id
        WHERE oi.order_id = o.id) AS shop_names
    FROM orders o
    ORDER BY o.created_at DESC, o.id DESC LIMIT 200`).all();
  res.json({ orders: rows.map((o) => ({
    publicId: o.public_id, email: o.email, status: o.status,
    totalCents: o.total_cents, itemCount: o.item_count,
    shops: o.shop_names ? o.shop_names.split(',') : [],
    createdAt: o.created_at,
    refundedAt: o.refunded_at || null,
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
 * 5/105 of the margin only). No filing integration — just correct numbers. */
router.get('/vat-report', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT strftime('%Y', title_transferred_at) || '-Q' ||
           ((CAST(strftime('%m', title_transferred_at) AS INTEGER) + 2) / 3) AS quarter,
           rail,
           COUNT(*) AS orders,
           SUM(total_cents) AS gross_cents,
           SUM(vat_amount_cents) AS vat_cents
    FROM orders
    WHERE status IN ('paid','fulfilled') AND vat_amount_cents > 0 AND title_transferred_at IS NOT NULL
    GROUP BY quarter, rail
    ORDER BY quarter DESC, rail`).all();
  res.json({
    vatRegistered: cfg.vatRegistered(),
    rows: rows.map((r) => ({ quarter: r.quarter, rail: r.rail, orders: r.orders, grossCents: r.gross_cents, vatCents: r.vat_cents })),
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

    const stripe = require('../stripe').requireStripe();
    await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      ...(order.rail === 'connect' ? { reverse_transfer: true, refund_application_fee: true } : {}),
    });

    db.transaction(() => {
      db.prepare("UPDATE orders SET refunded_at=datetime('now') WHERE id=?").run(order.id);
      if (order.rail !== 'connect') {
        const swept = db.prepare(`SELECT * FROM seller_balances
          WHERE order_id=? AND type='credit_sale' AND settlement_id IS NOT NULL`).all(order.id);
        for (const c of swept) {
          db.prepare(`INSERT INTO seller_balances (shop_id, order_id, type, amount_cents)
            VALUES (?,?, 'debit_refund', ?)`).run(c.shop_id, order.id, -c.amount_cents);
        }
      }
    })();

    // Logistics, best-effort after the money is sorted.
    const delivery = require('../delivery');
    for (const sh of db.prepare('SELECT * FROM shipments WHERE order_id=?').all(order.id)) {
      if (['shipped', 'out_for_delivery', 'delivered'].includes(sh.status)) {
        delivery.bookReversePickup(sh.id).then((r) => {
          db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
            .run(sh.id, sh.status, `Return pickup booked${r && r.ref ? ' · ' + r.ref : ''}`);
        }).catch((e) => console.error('Reverse pickup failed for shipment', sh.id, e.message));
      } else if (sh.status === 'processing') {
        db.prepare("UPDATE shipments SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(sh.id);
        db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'cancelled', 'Order refunded — do not ship')").run(sh.id);
      }
    }
    const transferred = db.prepare('SELECT DISTINCT transfer_id FROM order_items WHERE order_id=? AND transfer_id IS NOT NULL').all(order.id);
    if (transferred.length) {
      console.warn(`refund ${order.public_id}: reverse these Stripe Transfers by hand:`, transferred.map((t) => t.transfer_id).join(', '));
    }

    const fresh = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    res.json({ ok: true, order: { publicId: fresh.public_id, refundedAt: fresh.refunded_at } });
  } catch (e) { next(e); }
});

/* ---------------- Weekly settlements (consignment purchases) ----------------
 * The old order_items sweep (payouts/preview + payouts/run) is retired: money
 * owed to suppliers now lives on the seller_balances ledger and is settled by
 * src/settlement.js. Old payout batches stay readable below for history.    */

const settlement = require('../settlement');

// GET /api/admin/settlements/preview → what the next run would pay, and who
// is held back (payout setup incomplete / netted negative → carry forward).
router.get('/settlements/preview', requireAdmin, (_req, res) => {
  res.json(settlement.preview());
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
