'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware');
const shipments = require('../shipments');
const { SERVICE_AREAS, isServiceable } = require('../service-area');

const returns = require('../returns');

const router = express.Router();

/* ---------------- Orders (buyer) ---------------- */
router.get('/orders', requireAuth, (req, res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE buyer_id=? AND status!='pending' ORDER BY created_at DESC").all(req.user.id);
  const itemsStmt = db.prepare(`SELECT oi.*, s.name AS shop_name, s.color, s.is_house FROM order_items oi JOIN shops s ON s.id=oi.shop_id WHERE oi.order_id=?`);
  const shipStmt = db.prepare(`SELECT sh.*, s.name AS shop_name, s.color, s.is_house FROM shipments sh JOIN shops s ON s.id=sh.shop_id WHERE sh.order_id=? ORDER BY sh.id`);
  const reqStmt = db.prepare('SELECT * FROM return_requests WHERE order_id=?');
  res.json({
    orders: orders.map((o) => ({
      id: o.public_id,
      status: o.status,
      total: o.total_cents / 100,
      createdAt: o.created_at,
      deliveredAt: o.delivered_at || null,
      returnWindowEndsAt: o.return_window_ends_at || null,
      refundedAt: o.refunded_at || null,
      items: itemsStmt.all(o.id).map((i) => ({
        name: i.name_snapshot, qty: i.qty, price: i.price_cents / 100, personalization: i.personalization || '',
        productId: i.product_id, shopId: i.shop_id,
        shop: { name: i.shop_name, color: i.color, isHouse: !!i.is_house },
      })),
      shipments: shipStmt.all(o.id).map((sh) => shipments.shape(sh)),
      returns: {
        eligible: !returns.ineligibleReason(o) && !reqStmt.get(o.id),
        deadline: returns.deadline(o),
        fee: returns.feeCents(o) / 100,
        refund: returns.refundCents(o) / 100,
        request: returns.shape(reqStmt.get(o.id)),
      },
    })),
  });
});

/* ---------------- Return requests (buyer) ----------------
 * Whole-order returns: reason + a few words + at least one photo. The request
 * lands with Trove's admin (who approves/declines) and shows on the shops'
 * order views. Money rules live in src/returns.js.
 */
router.post('/orders/:publicId/return-request', requireAuth, (req, res, next) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE public_id=? AND buyer_id=?').get(req.params.publicId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const result = returns.create(req.user, order, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json({ ok: true, id: result.id });
  } catch (e) { next(e); }
});

// Withdraw your own request while it's still waiting on a decision.
router.delete('/orders/:publicId/return-request', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE public_id=? AND buyer_id=?').get(req.params.publicId, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!returns.cancelOwn(req.user.id, order.id)) return res.status(404).json({ error: 'No pending return request to withdraw' });
  res.json({ ok: true });
});

/* ---------------- Ratings & reviews (verified purchases) ---------------- */
const reviews = require('../reviews');

// GET /api/account/reviewables → delivered purchases waiting for a review,
// plus the shops behind them. Drives the "Review your purchases" prompts.
router.get('/reviewables', requireAuth, (req, res) => {
  const products = db.prepare(`
    SELECT DISTINCT p.id, p.name, p.image_seed AS imageSeed, s.id AS shopId, s.name AS shopName, s.color
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN shipments sh ON sh.order_id = o.id AND sh.shop_id = oi.shop_id
    JOIN products p ON p.id = oi.product_id
    JOIN shops s ON s.id = oi.shop_id
    WHERE o.buyer_id = ? AND sh.status = 'delivered' AND o.refunded_at IS NULL
      AND o.status IN ('paid','fulfilled')
      AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.buyer_id = o.buyer_id AND r.product_id = p.id)
    ORDER BY o.created_at DESC`).all(req.user.id);
  const shops = db.prepare(`
    SELECT DISTINCT s.id, s.name, s.color, s.slug
    FROM shipments sh
    JOIN orders o ON o.id = sh.order_id
    JOIN shops s ON s.id = sh.shop_id
    WHERE o.buyer_id = ? AND sh.status = 'delivered' AND o.refunded_at IS NULL
      AND o.status IN ('paid','fulfilled')
      AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.buyer_id = o.buyer_id AND r.shop_id = s.id AND r.product_id IS NULL)
    ORDER BY s.name`).all(req.user.id);
  res.json({ products, shops });
});

// GET /api/account/reviews → everything I've written (for edit prefills).
router.get('/reviews', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.name AS buyer_name, p.name AS product_name, p.image_seed AS image_seed, s.name AS shop_name
    FROM reviews r JOIN users u ON u.id = r.buyer_id
    LEFT JOIN products p ON p.id = r.product_id
    JOIN shops s ON s.id = r.shop_id
    WHERE r.buyer_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
  res.json({ reviews: rows.map((r) => ({
    ...reviews.shape(r), shopId: r.shop_id, shopName: r.shop_name, imageSeed: r.image_seed || null, status: r.status,
  })) });
});

// POST /api/account/reviews {productId | shopId, rating, body, images[]}
// Creates the review, or edits yours in place if you've reviewed it before.
router.post('/reviews', requireAuth, (req, res, next) => {
  try {
    const result = reviews.upsert(req.user, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.updated ? 200 : 201).json({ ok: true, id: result.id, updated: result.updated });
  } catch (e) { next(e); }
});

// DELETE /api/account/reviews/:id → remove your own review (and its photos).
router.delete('/reviews/:id', requireAuth, (req, res) => {
  if (!reviews.removeOwn(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/* ---------------- Addresses ---------------- */
router.get('/addresses', requireAuth, (req, res) => {
  res.json({ addresses: db.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id').all(req.user.id) });
});

router.post('/addresses', requireAuth, (req, res) => {
  const { label = 'Home', name, line, city, country = 'United Arab Emirates', phone = '', isDefault } = req.body || {};
  if (!name || !line || !city) return res.status(400).json({ error: 'name, line and city are required' });
  if (!isServiceable(city)) return res.status(400).json({ error: `We currently deliver in ${SERVICE_AREAS.join(' and ')} only` });
  if (isDefault) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.user.id);
  const info = db.prepare('INSERT INTO addresses (user_id,label,name,line,city,country,phone,is_default) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, label, name, line, city, country, phone, isDefault ? 1 : 0);
  res.status(201).json({ address: db.prepare('SELECT * FROM addresses WHERE id=?').get(info.lastInsertRowid) });
});

router.patch('/addresses/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM addresses WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.city !== undefined && !isServiceable(b.city)) return res.status(400).json({ error: `We currently deliver in ${SERVICE_AREAS.join(' and ')} only` });
  if (b.isDefault) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.user.id);
  db.prepare('UPDATE addresses SET label=COALESCE(?,label), name=COALESCE(?,name), line=COALESCE(?,line), city=COALESCE(?,city), country=COALESCE(?,country), phone=COALESCE(?,phone), is_default=COALESCE(?,is_default) WHERE id=?')
    .run(b.label, b.name, b.line, b.city, b.country, b.phone, b.isDefault === undefined ? a.is_default : (b.isDefault ? 1 : 0), a.id);
  res.json({ address: db.prepare('SELECT * FROM addresses WHERE id=?').get(a.id) });
});

router.delete('/addresses/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
