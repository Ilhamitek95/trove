'use strict';
const express = require('express');
const db = require('../db');
const { requireSeller } = require('../middleware');
const { requireStripe } = require('../stripe');

const router = express.Router();
const CLIENT = () => process.env.CLIENT_URL || 'http://localhost:3000';

/* ---------------- Shop profile ---------------- */
router.get('/me', requireSeller, (req, res) => res.json({ shop: req.shop }));

router.patch('/me', requireSeller, (req, res) => {
  const { name, bio, location, color } = req.body || {};
  db.prepare('UPDATE shops SET name=COALESCE(?,name), bio=COALESCE(?,bio), location=COALESCE(?,location), color=COALESCE(?,color) WHERE id=?')
    .run(name, bio, location, color, req.shop.id);
  res.json({ shop: db.prepare('SELECT * FROM shops WHERE id=?').get(req.shop.id) });
});

/* ---------------- Products ---------------- */
const toCents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

router.get('/products', requireSeller, (req, res) => {
  res.json({ products: db.prepare('SELECT * FROM products WHERE shop_id=? ORDER BY created_at DESC').all(req.shop.id) });
});

router.post('/products', requireSeller, (req, res) => {
  const { name, description = '', category = 'Home', price, compareAt, stock = 0, status = 'draft', imageSeed = 'new' } = req.body || {};
  if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
  const info = db.prepare(`INSERT INTO products (shop_id,name,description,category,price_cents,compare_at_cents,stock,status,image_seed)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(req.shop.id, name, description, category, toCents(price), toCents(compareAt), stock, status, imageSeed);
  res.status(201).json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid) });
});

router.patch('/products/:id', requireSeller, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=? AND shop_id=?').get(req.params.id, req.shop.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare(`UPDATE products SET name=COALESCE(?,name), description=COALESCE(?,description), category=COALESCE(?,category),
    price_cents=COALESCE(?,price_cents), compare_at_cents=?, stock=COALESCE(?,stock), status=COALESCE(?,status) WHERE id=?`)
    .run(b.name, b.description, b.category, toCents(b.price),
         b.compareAt === undefined ? p.compare_at_cents : toCents(b.compareAt),
         b.stock, b.status, p.id);
  res.json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(p.id) });
});

router.delete('/products/:id', requireSeller, (req, res) => {
  const r = db.prepare('DELETE FROM products WHERE id=? AND shop_id=?').run(req.params.id, req.shop.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/* ---------------- Orders for this shop ---------------- */
router.get('/orders', requireSeller, (req, res) => {
  const items = db.prepare(`
    SELECT oi.*, o.public_id, o.status AS order_status, o.created_at, o.email
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.shop_id = ? AND o.status != 'pending'
    ORDER BY o.created_at DESC`).all(req.shop.id);
  res.json({ items });
});

/* ---------------- Stripe Connect (Express) ---------------- */
// POST /api/seller/connect -> creates/links a connected account, returns an onboarding URL.
router.post('/connect', requireSeller, async (req, res, next) => {
  try {
    const stripe = requireStripe();
    let acctId = req.shop.stripe_account_id;
    if (!acctId) {
      const acct = await stripe.accounts.create({
        type: 'express',
        email: req.user.email,
        business_profile: { name: req.shop.name },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      acctId = acct.id;
      db.prepare('UPDATE shops SET stripe_account_id=? WHERE id=?').run(acctId, req.shop.id);
    }
    const link = await stripe.accountLinks.create({
      account: acctId,
      refresh_url: `${CLIENT()}/trove-seller.html?connect=refresh`,
      return_url: `${CLIENT()}/trove-seller.html?connect=done`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (e) { next(e); }
});

// GET /api/seller/connect/status -> refreshes onboarding flags from Stripe.
router.get('/connect/status', requireSeller, async (req, res, next) => {
  try {
    if (!req.shop.stripe_account_id) return res.json({ connected: false });
    const stripe = requireStripe();
    const acct = await stripe.accounts.retrieve(req.shop.stripe_account_id);
    db.prepare('UPDATE shops SET charges_enabled=?, payouts_enabled=? WHERE id=?')
      .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0, req.shop.id);
    res.json({ connected: true, accountId: acct.id, chargesEnabled: acct.charges_enabled, payoutsEnabled: acct.payouts_enabled });
  } catch (e) { next(e); }
});

// POST /api/seller/connect/login-link -> one-time link into the Stripe Express dashboard.
router.post('/connect/login-link', requireSeller, async (req, res, next) => {
  try {
    if (!req.shop.stripe_account_id) return res.status(400).json({ error: 'Not connected yet' });
    const stripe = requireStripe();
    const link = await stripe.accounts.createLoginLink(req.shop.stripe_account_id);
    res.json({ url: link.url });
  } catch (e) { next(e); }
});

module.exports = router;
