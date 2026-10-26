'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireStripe } = require('../stripe');
const { SERVICE_FEE_CENTS, deliveryFor } = require('../fees');
const { SERVICE_AREAS, isDeliverable } = require('../service-area');
const receipt = require('../order-receipt');
const { normalizeUAEMobile } = require('../phone');
const options = require('../options');
const extras = require('../extras');
const customerBlock = require('../customer-block');

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
/* The delivery address reaches the shop's order view, the admin lists and
 * the courier's payload: only these fields are kept (never a phone — that
 * lives on orders.phone), each a trimmed string within its limit (F215), and
 * no markup. */
const ADDRESS_LIMITS = { name: 100, line: 200, line2: 200, city: 120, emirate: 40, area: 80, country: 60, notes: 300 };
const ADDRESS_FIELDS = Object.keys(ADDRESS_LIMITS);
const BAD_ADDRESS = "The delivery address can't contain < or >";
const LONG_ADDRESS = 'Part of the delivery address is too long — please shorten it';
const ODD_ADDRESS = 'Check the delivery address and try again';
/** { address } (null when none was sent) or { error }. */
function cleanAddress(address) {
  if (address == null || address === '') return { address: null };
  if (typeof address !== 'object' || Array.isArray(address)) return { error: ODD_ADDRESS };
  const out = {};
  for (const k of ADDRESS_FIELDS) {
    const v = address[k];
    if (v == null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number') return { error: ODD_ADDRESS };
    const text = String(v).trim();
    if (text.length > ADDRESS_LIMITS[k]) return { error: LONG_ADDRESS };
    if (text) out[k] = text;
  }
  if (require('../validate').markupField(out, ADDRESS_FIELDS)) return { error: BAD_ADDRESS };
  return { address: out };
}

/* The buyer's email carries the receipt, the return emails and a guest's
 * only link to the order: the same shape check as sign-up (F214). */
const { emailError, EMAIL_ERROR } = require('../validate');
/** A trimmed, valid email from the body, '' when none was sent, or null when it is not valid. */
function emailFrom(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  const e = raw.trim();
  return emailError(e) ? null : e;
}
/* A piece that is gone (unlisted, shop paused, deleted) is named, never
 * numbered (F422): the buyer must know which line to take out. `code` and
 * `productId` let a client drop that line from the basket. */
function unavailable(res, productId) {
  const pid = Number.isInteger(Number(productId)) && Number(productId) > 0 ? Number(productId) : null;
  const p = pid ? db.prepare('SELECT name FROM products WHERE id=?').get(pid) : null;
  return res.status(400).json({
    code: 'unavailable', productId: pid,
    error: p ? `“${p.name}” is no longer available — remove it from your basket to continue` : 'One of the pieces in your basket is no longer available — remove it to continue',
  });
}
const MAX_LINES = 50;
const PAYMENTS_DOWN = 'We can’t take payments right now — please try again in a few minutes';
const CURRENCY = () => process.env.CURRENCY || 'aed';
const defaultPublicId = () => 'TRV-' + crypto.randomBytes(2).toString('hex').toUpperCase() + Math.floor(Math.random() * 90 + 10);
let publicId = defaultPublicId;
const PUBLIC_ID_ATTEMPTS = 8;
const isPublicIdClash = (e) => e && /UNIQUE constraint failed: orders\.public_id/.test(e.message || '');

/**
 * POST /api/checkout
 * body: { items:[{productId, qty}], email, address:{...} }
 *
 * The server is the source of truth for prices — it never trusts amounts from the
 * client. It creates a pending order and opens ONE PaymentIntent on Trove's own
 * Stripe account. On `payment_intent.succeeded` the webhook records Trove's
 * purchase from each supplier on the consignment ledger (settled fortnightly);
 * connect-tier shops (Rail B, feature-flagged) are paid per sale instead.
 */
router.post('/', async (req, res, next) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });
    if (items.length > MAX_LINES) return res.status(400).json({ error: 'Your basket has too many lines — split it into two orders' });
    // Production never falls back to the free demo-payments mode (F211): no
    // Stripe there means no orders, never unpaid ones.
    if (!require('../stripe').getStripe() && require('../stripe').paymentsRequired()) return res.status(503).json({ error: PAYMENTS_DOWN });
    // The address can arrive later via /checkout/update (the payment form
    // mounts before the form is filled) — but if one is given, it must be
    // inside the service area.
    const { address, error: addressError } = cleanAddress((req.body || {}).address);
    if (addressError) return res.status(400).json({ error: addressError });
    if (address && !isDeliverable(address)) return res.status(400).json({ error: OUT_OF_AREA });
    const email = emailFrom((req.body || {}).email);
    if (email === null) return res.status(400).json({ error: EMAIL_ERROR });
    // Resolve the signed-in buyer ONCE, and only if they still exist: a
    // session outliving its user (deleted account, reseeded dev database)
    // would otherwise write a dangling buyer_id and fail the whole order on
    // a foreign key.
    const buyer = req.session.userId ? db.prepare('SELECT id, email FROM users WHERE id=?').get(req.session.userId) : null;
    const buyerEmail = email || (buyer && buyer.email);
    if (!buyerEmail) return res.status(400).json({ error: 'Email is required' });
    // A blocked customer (F199): the owner's switch in Admin → Messages →
    // customer lookup. They keep their account; new orders are refused.
    if (customerBlock.isBlocked({ email: buyerEmail, userId: buyer && buyer.id })) {
      return res.status(403).json({ code: 'blocked', error: customerBlock.ORDER_REFUSED });
    }
    // Like the address, the number can arrive later via /checkout/update when
    // the payment form mounts before the form is filled in.
    const { phone, error: phoneError } = phoneFrom(req.body);
    if (phoneError) return res.status(400).json({ error: phoneError });

    // Resolve products + recompute everything from the DB.
    const get = db.prepare(`SELECT p.*, s.id AS shop_id, s.is_house FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=? AND p.status='live' AND s.status='approved' AND ${require('../agreements').sellableSql('s')}`);
    const lines = [];
    let subtotal = 0;
    // Two lines can point at the same piece (different personalisation), so
    // stock is checked against the running total, not line by line.
    const claimed = new Map();
    const claim = (id, qty) => { const n = (claimed.get(id) || 0) + qty; claimed.set(id, n); return n; };
    for (const it of items) {
      if (!it || typeof it !== 'object' || !Number.isInteger(Number(it.productId))) return unavailable(res, null);
      const p = get.get(Number(it.productId));
      const qty = Math.max(1, parseInt(it.qty, 10) || 1);
      if (!p) return unavailable(res, it.productId);
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

      // Priced extras: the buyer only names them; the amounts come from the
      // product row, and the cost rides inside the unit price so settlement
      // and returns keep reading the one number they always have.
      const picked = extras.selectionError(p.extras, it.extras, p.name);
      if (picked.error) return res.status(400).json({ error: picked.error });
      unitPrice += extras.totalCents(picked.value);
      // Belt and braces behind the seller-side price rules: a line that would
      // take money OFF the order (or give a piece away) never reaches payment.
      if (!Number.isFinite(unitPrice) || unitPrice <= 0)
        return res.status(400).json({ error: `${p.name} can't be bought right now — please remove it from your basket` });

      const line = { product_id: p.id, shop_id: p.shop_id, lead_days: p.lead_days, name: p.name, price_cents: unitPrice, qty, personalization: perso, options: JSON.stringify(chosen.value), extras: JSON.stringify(picked.value) };
      lines.push(line);
      subtotal += unitPrice * qty;
    }

    // Buyer fees: the service fee (0 since Aug 2026 — no buyer fee; the plumbing
    // stays for a future change) plus delivery (free over the threshold).
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

    // Persist a pending order + items in one transaction. The public id is
    // short and random, so a clash with an earlier order is possible: roll a
    // new one and try again rather than failing the checkout.
    let pid, orderId;
    for (let attempt = 1; ; attempt++) {
      pid = publicId();
      try {
        orderId = db.transaction(() => {
          const info = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,currency,shipping_json,status,rail,lang)
            VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`).run(pid, buyer ? buyer.id : null, buyerEmail, phone, subtotal, delivery, serviceFee, total, CURRENCY(), JSON.stringify(address), rail,
              req.lang === 'ar' ? 'ar' : 'en'); // the checkout page's language: a guest's order emails follow it
          const oid = info.lastInsertRowid;
          // lead_days is snapshotted so a later edit never moves this order's promise.
          const ins = db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,personalization,options,extras,lead_days) VALUES (?,?,?,?,?,?,?,?,?,?)');
          for (const l of lines) ins.run(oid, l.product_id, l.shop_id, l.name, l.price_cents, l.qty, l.personalization, l.options, l.extras, l.lead_days ?? null);
          return oid;
        })();
        break;
      } catch (e) {
        if (!isPublicIdClash(e) || attempt >= PUBLIC_ID_ATTEMPTS) throw e;
      }
    }

    // Demo-payments mode: hand back the order for /checkout/demo-complete.
    // The session stamp is the ownership proof (demo orders have no client
    // secret) — only the session that opened the order can complete or claim it.
    if (!stripeClient) {
      req.session.pendingOrderId = orderId;
      return res.json({ orderId: pid, demo: true, amount: total, currency: CURRENCY(), receiptKey: receipt.token(pid) });
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
    // One PaymentIntent per order, whatever the network does (F444).
    }, { idempotencyKey: `trove-order-pi-${orderId}` });
    db.prepare('UPDATE orders SET stripe_payment_intent_id=? WHERE id=?').run(intent.id, orderId);

    res.json({
      orderId: pid,
      clientSecret: intent.client_secret, // client confirms with Stripe.js
      receiptKey: receipt.token(pid), // opens /order/<id>/thanks on this device (src/order-receipt.js)
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
router.post('/update', async (req, res, next) => {
  try {
    const { orderId, clientSecret } = req.body || {};
    const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(String(orderId || ''));
    if (!order || order.status !== 'pending') return res.status(404).json({ error: 'Order not found' });
    if (!order.stripe_payment_intent_id
      || !String(clientSecret || '').startsWith(order.stripe_payment_intent_id + '_secret'))
      return res.status(403).json({ error: 'Not your order' });
    const { address, error: addressError } = cleanAddress((req.body || {}).address);
    if (addressError) return res.status(400).json({ error: addressError });
    if (!address || !address.name || !address.line)
      return res.status(400).json({ error: 'A delivery name and address are required' });
    if (!isDeliverable(address)) return res.status(400).json({ error: OUT_OF_AREA });
    const email = emailFrom((req.body || {}).email);
    if (email === null) return res.status(400).json({ error: EMAIL_ERROR });
    // This is the last stop before the card is charged, so the courier number
    // has to be here — whether it arrived with the original call or not.
    const { phone, error: phoneError } = phoneFrom(req.body);
    if (phoneError) return res.status(400).json({ error: phoneError });
    if (!phone && !order.phone) return res.status(400).json({ error: BAD_PHONE });
    db.prepare('UPDATE orders SET email=COALESCE(?,email), phone=COALESCE(NULLIF(?,\'\'),phone), shipping_json=? WHERE id=?')
      .run(email || null, phone, JSON.stringify(address), order.id);
    // A corrected email: Stripe's own receipt follows it (F444). Best-effort —
    // Trove's receipt reads the order row, which is already right.
    if (email && email !== order.email) {
      const stripe = require('../stripe').getStripe();
      if (stripe && stripe.paymentIntents && typeof stripe.paymentIntents.update === 'function') {
        try { await stripe.paymentIntents.update(order.stripe_payment_intent_id, { receipt_email: email }); }
        catch (e) { console.warn(`order ${order.public_id}: receipt email not updated at Stripe:`, e.message); }
      }
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
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
 * GET /api/checkout/receipt/:publicId  (?t=<receipt key> or X-Receipt-Key)
 * What the confirmation page at /order/<id>/thanks shows — the pieces, the
 * amounts paid, the delivery address and mobile. Only for the order's
 * signed-in buyer, the session that placed it, or the holder of its receipt
 * key (src/order-receipt.js); anyone else gets the same 404 as no order.
 */
router.get('/receipt/:publicId', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(String(req.params.publicId || ''));
  res.set('Cache-Control', 'private, no-store');
  if (!receipt.canRead(order, req)) return res.status(404).json({ error: 'Order not found' });
  res.json({ receipt: receipt.shape(order) });
});

/**
 * POST /api/checkout/demo-complete  { orderId }
 * Completes an order WITHOUT payment — exists ONLY while Stripe is not
 * configured (the endpoint refuses once a key is set, so it dies by itself
 * at go-live). Runs the exact same paid effects as the real webhook: stock,
 * shipments, courier pickups, supplier ledger credits. Only the session
 * that opened the order (or its signed-in owner) can complete it.
 */
router.post('/demo-complete', async (req, res, next) => {
  try {
    // Never on the live site, whatever the Stripe configuration (F211).
    if (require('../stripe').paymentsRequired()) return res.status(404).json({ error: 'Not found' });
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
    const result = db.transaction(() => pe.paidDbEffects(order, groups))();
    if (!result.ok) {
      // Someone else took the last one first. Demo mode takes no money, so
      // there is nothing to refund — the order is simply cancelled.
      const names = [...new Set(result.shortfall.map((i) => i.name_snapshot))].join(', ');
      return res.status(409).json({ code: 'sold_out', error: `Sorry — ${names} sold out a moment ago, so this order couldn't go ahead. Nothing has been charged.` });
    }
    // Lines that sold out meanwhile are cancelled; the rest goes ahead (F212).
    await pe.afterPaid(order, groups, result, null);
    // The session stamp survives completion: the confirmation page's
    // create-an-account offer still needs it to /claim the order.

    const soldOut = [...new Set(result.shortfall.map((i) => i.name_snapshot))];
    res.json({ ok: true, orderId: order.public_id, demo: true, ...(soldOut.length ? { soldOut } : {}) });
  } catch (e) { next(e); }
});

module.exports = router;
// Test hook: swap the public-id generator (null restores the default).
module.exports.setPublicIdGenerator = (fn) => { publicId = fn || defaultPublicId; };
