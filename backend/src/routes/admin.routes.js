'use strict';
/**
 * Admin — the weekly payout run for MANAGED shops.
 *
 * Managed shops don't connect their own Stripe; Trove collects their sales and
 * pays them out by bank transfer on a weekly cadence. These endpoints show what
 * is owed, batch it into payout records (locking those sales so they're never
 * paid twice), and let the admin mark a batch as sent once the transfer is done.
 *
 * A sale is "owed to a managed shop" when its order is paid, it has NOT already
 * been transferred via Stripe Connect (transfer_id IS NULL), and it has NOT yet
 * been swept into a payout batch (payout_id IS NULL).
 */
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware');
const fees = require('../fees');

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
  res.json({ shops, orders, gmvCents: gmv, buyers, liveProducts: products });
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
    payoutType: s.payout_type, hasBank: !!s.payout_iban, stripeConnected: !!s.stripe_account_id,
    products: s.product_count, liveProducts: s.live_count, salesCents: s.sales_cents,
    createdAt: s.created_at,
  })) });
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
  })) });
});

/* ---------------- Weekly managed payouts ---------------- */

const OUTSTANDING = `
  SELECT s.id AS shop_id, s.name, s.slug,
         s.payout_bank_name, s.payout_account_name, s.payout_iban,
         SUM(oi.price_cents * oi.qty) AS gross, COUNT(oi.id) AS item_count
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN shops  s ON s.id = oi.shop_id
  WHERE s.payout_type = 'managed'
    AND oi.payout_id IS NULL
    AND oi.transfer_id IS NULL
    AND o.status IN ('paid', 'fulfilled')
  GROUP BY s.id
  HAVING gross > 0`;

function withSplit(row) {
  const { fee, net } = fees.split(row.gross);
  return {
    shopId: row.shop_id,
    name: row.name,
    slug: row.slug,
    bank: { name: row.payout_bank_name, accountName: row.payout_account_name, iban: row.payout_iban },
    grossCents: row.gross,
    feeCents: fee,
    netCents: net,
    itemCount: row.item_count,
  };
}

// GET /api/admin/payouts/preview → who is owed what this period, before running.
router.get('/payouts/preview', requireAdmin, (_req, res) => {
  const shops = db.prepare(OUTSTANDING).all().map(withSplit);
  res.json({
    shops,
    totalNetCents: shops.reduce((s, r) => s + r.netCents, 0),
    feePercent: fees.PLATFORM_FEE_PERCENT,
  });
});

// POST /api/admin/payouts/run → batch each shop's outstanding balance into a
// payout record and lock the underlying sales to it. Idempotent: a second run
// with nothing new outstanding simply creates nothing.
router.post('/payouts/run', requireAdmin, (_req, res) => {
  const created = db.transaction(() => {
    const out = [];
    for (const r of db.prepare(OUTSTANDING).all().map(withSplit)) {
      const itemIds = db.prepare(`
        SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.shop_id = ? AND oi.payout_id IS NULL AND oi.transfer_id IS NULL
          AND o.status IN ('paid', 'fulfilled')`).all(r.shopId).map((x) => x.id);
      if (!itemIds.length) continue;
      const info = db.prepare(`INSERT INTO payouts
          (shop_id, amount_cents, gross_cents, fee_cents, item_count, status, bank_snapshot)
        VALUES (?,?,?,?,?, 'pending', ?)`)
        .run(r.shopId, r.netCents, r.grossCents, r.feeCents, r.itemCount, JSON.stringify(r.bank));
      const pid = info.lastInsertRowid;
      const mark = db.prepare('UPDATE order_items SET payout_id=? WHERE id=?');
      for (const id of itemIds) mark.run(pid, id);
      out.push({ payoutId: pid, ...r });
    }
    return out;
  })();
  res.json({ created, count: created.length });
});

// GET /api/admin/payouts → full batch history.
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
