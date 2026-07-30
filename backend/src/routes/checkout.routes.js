'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireStripe } = require('../stripe');
const { SERVICE_FEE_CENTS, deliveryFor } = require('../fees');
const { SERVICE_AREAS, isServiceable } = require('../service-area');
const { normalizeUAEMobile } = require('../phone');
const options = require('../options');

const OUT_OF_AREA = `We currently deliver in ${SERVICE_AREAS.join(' and ')} only`;
const BAD_PHONE = 'Enter a UAE mobile number so the courier can reach you on the day';

const router = express.Router();

/* The courier needs a number; the shops never see it (it lives on its own
 * column, not in the address snapshot the seller payload hands over). */
function phoneFrom(body) {
  const raw = String((body || {}).phone || '').trim();
  if (!raw) return { phone: '' };
  const norm = normalizeUAEMobile(raw);
  return norm ? { phone: norm } : { error: BAD_PHONE };
}
/* Belt and braces: a phone must never end up inside shipping_json. */
const shipSnapshot = (address) => {
  if (!address) return null;
  const { phone, ...rest } = address;
  return rest;
};
const CURRENCY = () => process.env.CURRENCY || 'aed';
const publicId = () => 'TRV-' + crypto.randomBytes(2).toString('hex').toUpperCase() + Math.floor(Math.random() * 90 + 10);

/**
 * POST /api/checkout
 * body: { items:[{productId, qty}], email, address:{...} }
 *
 * The server is the source of truth for prices — it never trusts amounts from the
 * client. It creates a pending order and opens ONE PaymentIntent on Trove's own
 * Stripe account. On `payment_intent.succeeded` the webhook records Trove's
 * purchase from each supplier on the consignment ledger (settled weekly);
 * connect-tier shops (Rail B, feature-flagged) are paid per sale instead.
 */
router.post('/', async (req, res, next) => {
  try {
    const { items, email, address } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });
    // The address can arrive later via /checkout/update (the payment form
    // mounts before the form is filled) — but if one is given, it must be
    // inside the service area.
    if (address && !isServiceable(address.emirate || address.city)) return res.status(400).json({ error: OUT_OF_AREA });
    // Resolve the signed-in buyer ONCE, and only if they still exist: a
    // session outliving its user (deleted account, reseeded dev database)
    // would otherwise write a dangling buyer_id and fail the whole order on
    // a foreign key.
    const buyer = req.session.userId ? db.prepare('SELECT id, email FROM users WHERE id=?').get(req.session.userId) : null;
    const buyerEmail = email || (buyer && buyer.email);
    if (!buyerEmail) return res.status(400).json({ error: 'Email is required' });
    // Like the address, the number can arrive later via /checkout/update when
    // the payment form mounts before the form is filled in.
    const { phone, error: phoneError } = phoneFrom(req.body);
    if (phoneError) return res.status(400).json({ error: phoneError });

    // Resolve products + recompute everything from the DB.
    const get = db.prepare(`SELECT p.*, s.id AS shop_id, s.is_house FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=? AND p.status='live' AND s.status='approved'`);
    const lines = [];
    let subtotal = 0;
    // Two lines can point at the same piece (different personalisation), so
    // stock is checked against the running total, not line by line.
    const claimed = new Map();
    const claim = (id, qty) => { const n = (claimed.get(id) || 0) + qty; claimed.set(id, n); return n; };
    for (const it of items) {
      const p = get.get(it.productId);
      const qty = Math.max(1, parseInt(it.qty) || 1);
      if (!p) return res.status(400).json({ error: `Product ${it.productId} is unavailable` });
      // Personalisation: only kept when the product allows it; required means the
      // order can't go through without it (mirrors Etsy's listing personalisation).
      let perso = '';
      if (p.personalization_enabled) {
        perso = String(it.personalization || '').trim().slice(0, p.personalization_char_limit || 256);
        if (p.personalization_required && !perso)
          return res.status(400).json({ error: `${p.name} needs your personalisation text before checkout` });
      }
      // Variations (colour, size, …): the buyer must pick one value per group
      // the seller listed, and only their spelling of it is stored.
      const chosen = options.selectionError(p.options, it.options, p.name);
      if (chosen.error) return res.status(400).json({ error: chosen.error });

      // Stock and price come from the exact variant when the piece has
      // variations — the ash glaze selling out must not sell the deep clay's
      // stock. A combination missing from the grid does not exist.
      let unitPrice = p.price_cents;
      if (chosen.value.length) {
        const variant = options.findVariant(p.variants, chosen.value);
        const which = `${p.name} (${options.label(chosen.value)})`;
        if (!variant) return res.status(400).json({ error: `${which} isn't available` });
        if (variant.priceCents) unitPrice = variant.priceCents;
        if (variant.stock < claim(`${p.id}:${variant.key}`, qty))
          return res.status(409).json({ error: variant.stock ? `Only ${variant.stock} left of ${which}` : `${which} is out of stock` });
      } else if (p.stock < claim(String(p.id), qty)) {
        return res.status(409).json({ error: p.stock ? `Only ${p.stock} left of ${p.name}` : `${p.name} is out of stock` });
      }

      const line = { product_id: p.id, shop_id: p.shop_id, name: p.name, price_cents: unitPrice, qty, personalization: perso, options: JSON.stringify(chosen.value) };
      lines.push(line);
      subtotal += unitPrice * qty;
    }

    // Buyer fees: a flat service fee plus delivery (delivery free over the threshold).
    const serviceFee = SERVICE_FEE_CENTS;
    const delivery = deliveryFor(subtotal);
    const total = subtotal + serviceFee + delivery;

    // Demo-payments mode (no Stripe key yet): there is no payment form, so
    // the full delivery details must arrive with this call — no later /update.
    const stripeClient = require('../stripe').getStripe();
    if (!stripeClient) {
      if (!address || !String(address.name || '').trim() || !String(address.line || '').trim())
        return res.status(400).json({ error: 'A delivery name and address are required' });
      if (!phone) return res.status(400).json({ error: BAD_PHONE });
    }

    // Rail B routing: an order whose items ALL belong to one fully-onboarded
    // connect-tier shop becomes a destination charge (never on_behalf_of —
    // unsupported for UAE platforms). Mixed carts and everything else stay on
    // the consignment rail; connect-tier leftovers in a mixed cart are paid
    // by Transfer in the webhook.
    const cfg = require('../config');
    let rail = 'consignment';
    let destShop = null;
    const shopIds = [...new Set(lines.map((l) => l.shop_id))];
    if (cfg.railBEnabled() && shopIds.length === 1) {
      const s = db.prepare('SELECT * FROM shops WHERE id=?').get(shopIds[0]);
      if (s && s.tier === 'connect' && s.stripe_account_id && s.charges_enabled) {
        rail = 'connect';
        destShop = s;
      }
    }

    // Persist a pending order + items in one transaction.
    const pid = publicId();
    const orderId = db.transaction(() => {
      const info = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,currency,shipping_json,status,rail)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`).run(pid, buyer ? buyer.id : null, buyerEmail, phone, subtotal, delivery, serviceFee, total, CURRENCY(), JSON.stringify(shipSnapshot(address)), rail);
      const oid = info.lastInsertRowid;
      const ins = db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,personalization,options) VALUES (?,?,?,?,?,?,?,?)');
      for (const l of lines) ins.run(oid, l.product_id, l.shop_id, l.name, l.price_cents, l.qty, l.personalization, l.options);
      return oid;
    })();

    // Demo-payments mode: hand back the order for /checkout/demo-complete.
    // The session stamp is the ownership proof (demo orders have no client
    // secret) — only the session that opened the order can complete or claim it.
    if (!stripeClient) {
      req.session.pendingOrderId = orderId;
      return res.json({ orderId: pid, demo: true, amount: total, currency: CURRENCY() });
    }

    // One PaymentIntent on Trove's account. On the connect rail the charge is
    // routed to the supplier's account with Trove's cut as the application
    // fee: the margin on the goods PLUS the buyer fees (service + delivery),
    // which are always Trove revenue.
    const stripe = requireStripe();
    const { split } = require('../fees');
    const intent = await stripe.paymentIntents.create({
      amount: total,
      currency: CURRENCY(),
      automatic_payment_methods: { enabled: true },
      transfer_group: `order_${orderId}`,
      metadata: { order_id: String(orderId), public_id: pid },
      receipt_email: buyerEmail,
      ...(destShop ? {
        transfer_data: { destination: destShop.stripe_account_id },
        application_fee_amount: split(subtotal).fee + serviceFee + delivery,
      } : {}),
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
  // This is the last stop before the card is charged, so the courier number
  // has to be here — whether it arrived with the original call or not.
  const { phone, error: phoneError } = phoneFrom(req.body);
  if (phoneError) return res.status(400).json({ error: phoneError });
  if (!phone && !order.phone) return res.status(400).json({ error: BAD_PHONE });
  db.prepare('UPDATE orders SET email=COALESCE(?,email), phone=COALESCE(NULLIF(?,\'\'),phone), shipping_json=? WHERE id=?')
    .run(email || null, phone, JSON.stringify(shipSnapshot(address)), order.id);
  res.json({ ok: true });
});

/**
 * POST /api/checkout/claim  { orderId, clientSecret }
 * A guest who creates an account mid-checkout attaches the order they just
 * opened to it. Possession of the Stripe client secret proves the order is
 * theirs — the public order id alone is guessable, the secret is not. Demo
 * orders have no secret; there the session that opened the order is proof.
 */
router.post('/claim', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in required' });
  const { orderId, clientSecret } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(String(orderId || ''));
  if (!order || order.buyer_id != null) return res.status(404).json({ error: 'Order not found' });
  const secretOk = order.stripe_payment_intent_id
    && String(clientSecret || '').startsWith(order.stripe_payment_intent_id + '_secret');
  const sessionOk = req.session.pendingOrderId === order.id;
  if (!secretOk && !sessionOk) return res.status(403).json({ error: 'Not your order' });
  db.prepare('UPDATE orders SET buyer_id=? WHERE id=?').run(req.session.userId, order.id);
  res.json({ ok: true });
});

/**
 * POST /api/checkout/demo-complete  { orderId }
 * Completes an order WITHOUT payment — exists ONLY while Stripe is not
 * configured (the endpoint refuses once a key is set, so it dies by itself
 * at go-live). Runs the exact same paid effects as the real webhook: stock,
 * shipments, courier pickups, supplier ledger credits. Only the session
 * that opened the order (or its signed-in owner) can complete it.
 */
router.post('/demo-complete', (req, res, next) => {
  try {
    if (require('../stripe').getStripe())
      return res.status(409).json({ error: 'Card payments are live — orders complete through the payment form' });
    const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(String((req.body || {}).orderId || ''));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const mine = req.session.pendingOrderId === order.id
      || (order.buyer_id != null && order.buyer_id === req.session.userId);
    if (!mine) return res.status(403).json({ error: 'Not your order' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Order already completed' });

    const pe = require('../paid-effects');
    const groups = pe.perShopGroups(order.id);
    db.transaction(() => pe.paidDbEffects(order, groups))();
    pe.paidPostEffects(order, groups, null);
    // The session stamp survives completion: the confirmation page's
    // create-an-account offer still needs it to /claim the order.

    res.json({ ok: true, orderId: order.public_id, demo: true });
  } catch (e) { next(e); }
});

module.exports = router;
