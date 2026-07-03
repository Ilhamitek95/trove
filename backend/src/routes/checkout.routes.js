'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireStripe } = require('../stripe');
const { SERVICE_FEE_CENTS, deliveryFor } = require('../fees');
const { SERVICE_AREAS, isServiceable } = require('../service-area');

const OUT_OF_AREA = `We currently deliver in ${SERVICE_AREAS.join(' and ')} only`;

const router = express.Router();
const CURRENCY = () => process.env.CURRENCY || 'aed';
const publicId = () => 'TRV-' + crypto.randomBytes(2).toString('hex').toUpperCase() + Math.floor(Math.random() * 90 + 10);

/**
 * POST /api/checkout
 * body: { items:[{productId, qty}], email, address:{...} }
 *
 * The server is the source of truth for prices — it never trusts amounts from the
 * client. It groups the cart by shop (for the multi-vendor split), creates a
 * pending order, and opens ONE PaymentIntent on the platform account. The payout
 * to each shop happens on `payment_intent.succeeded` in the webhook (separate
 * charges and transfers), tagged with a shared transfer_group.
 */
router.post('/', async (req, res, next) => {
  try {
    const { items, email, address } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });
    // The address can arrive later via /checkout/update (the payment form
    // mounts before the form is filled) — but if one is given, it must be
    // inside the service area.
    if (address && !isServiceable(address.emirate || address.city)) return res.status(400).json({ error: OUT_OF_AREA });
    const buyerEmail = email || (req.session.userId && db.prepare('SELECT email FROM users WHERE id=?').get(req.session.userId)?.email);
    if (!buyerEmail) return res.status(400).json({ error: 'Email is required' });

    // Resolve products + recompute everything from the DB.
    const get = db.prepare(`SELECT p.*, s.id AS shop_id, s.is_house FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=? AND p.status='live' AND s.status='approved'`);
    const lines = [];
    let subtotal = 0;
    for (const it of items) {
      const p = get.get(it.productId);
      const qty = Math.max(1, parseInt(it.qty) || 1);
      if (!p) return res.status(400).json({ error: `Product ${it.productId} is unavailable` });
      if (p.stock < qty) return res.status(409).json({ error: `${p.name} is out of stock` });
      // Personalisation: only kept when the product allows it; required means the
      // order can't go through without it (mirrors Etsy's listing personalisation).
      let perso = '';
      if (p.personalization_enabled) {
        perso = String(it.personalization || '').trim().slice(0, p.personalization_char_limit || 256);
        if (p.personalization_required && !perso)
          return res.status(400).json({ error: `${p.name} needs your personalisation text before checkout` });
      }
      const line = { product_id: p.id, shop_id: p.shop_id, name: p.name, price_cents: p.price_cents, qty, personalization: perso };
      lines.push(line);
      subtotal += p.price_cents * qty;
    }

    // Buyer fees: a flat service fee plus delivery (delivery free over the threshold).
    const serviceFee = SERVICE_FEE_CENTS;
    const delivery = deliveryFor(subtotal);
    const total = subtotal + serviceFee + delivery;

    // Persist a pending order + items in one transaction.
    const pid = publicId();
    const orderId = db.transaction(() => {
      const info = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,currency,shipping_json,status)
        VALUES (?,?,?,?,?,?,?,?,?, 'pending')`).run(pid, req.session.userId || null, buyerEmail, subtotal, delivery, serviceFee, total, CURRENCY(), JSON.stringify(address || null));
      const oid = info.lastInsertRowid;
      const ins = db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,personalization) VALUES (?,?,?,?,?,?,?)');
      for (const l of lines) ins.run(oid, l.product_id, l.shop_id, l.name, l.price_cents, l.qty, l.personalization);
      return oid;
    })();

    // One PaymentIntent on the platform; sellers are paid via transfers in the webhook.
    const stripe = requireStripe();
    const intent = await stripe.paymentIntents.create({
      amount: total,
      currency: CURRENCY(),
      automatic_payment_methods: { enabled: true },
      transfer_group: `order_${orderId}`,
      metadata: { order_id: String(orderId), public_id: pid },
      receipt_email: buyerEmail,
    });
    db.prepare('UPDATE orders SET stripe_payment_intent_id=? WHERE id=?').run(intent.id, orderId);

    res.json({
      orderId: pid,
      clientSecret: intent.client_secret, // client confirms with Stripe.js
      amount: total,
      currency: CURRENCY(),
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/checkout/update  { orderId, clientSecret, email?, address }
 * Called at Place-order time: the PaymentIntent (and order row) are created
 * when the payment form mounts, usually before the buyer has typed their
 * address — this writes the final contact + delivery details onto the still-
 * pending order. The client secret proves the order belongs to the caller.
 */
router.post('/update', (req, res) => {
  const { orderId, clientSecret, email, address } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(String(orderId || ''));
  if (!order || order.status !== 'pending') return res.status(404).json({ error: 'Order not found' });
  if (!order.stripe_payment_intent_id
    || !String(clientSecret || '').startsWith(order.stripe_payment_intent_id + '_secret'))
    return res.status(403).json({ error: 'Not your order' });
  if (!address || !String(address.name || '').trim() || !String(address.line || '').trim())
    return res.status(400).json({ error: 'A delivery name and address are required' });
  if (!isServiceable(address.emirate || address.city)) return res.status(400).json({ error: OUT_OF_AREA });
  db.prepare('UPDATE orders SET email=COALESCE(?,email), shipping_json=? WHERE id=?')
    .run(email || null, JSON.stringify(address), order.id);
  res.json({ ok: true });
});

/**
 * POST /api/checkout/claim  { orderId, clientSecret }
 * A guest who creates an account mid-checkout attaches the order they just
 * opened to it. Possession of the Stripe client secret proves the order is
 * theirs — the public order id alone is guessable, the secret is not.
 */
router.post('/claim', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in required' });
  const { orderId, clientSecret } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(String(orderId || ''));
  if (!order || order.buyer_id != null) return res.status(404).json({ error: 'Order not found' });
  if (!order.stripe_payment_intent_id
    || !String(clientSecret || '').startsWith(order.stripe_payment_intent_id + '_secret'))
    return res.status(403).json({ error: 'Not your order' });
  db.prepare('UPDATE orders SET buyer_id=? WHERE id=?').run(req.session.userId, order.id);
  res.json({ ok: true });
});

module.exports = router;
