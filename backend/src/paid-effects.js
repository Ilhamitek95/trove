'use strict';
/**
 * Everything that happens the moment an order is paid — shared by the Stripe
 * webhook (real payments) and the demo-mode checkout completion (no Stripe
 * key configured yet) so the two paths can never drift.
 *
 * paidDbEffects runs DATABASE effects only and must be called inside the
 * caller's transaction (the webhook wraps it together with its idempotency
 * guard). paidPostEffects does the network IO afterwards — courier pickups
 * and Rail B leftover transfers (skipped without a Stripe client).
 */
const db = require('./db');
const fees = require('./fees');

/** Per-shop item totals for an order, with each shop's payout wiring. */
function perShopGroups(orderId) {
  return db.prepare(`
    SELECT oi.shop_id, s.stripe_account_id, s.charges_enabled, s.tier, SUM(oi.price_cents * oi.qty) AS cents
    FROM order_items oi JOIN shops s ON s.id = oi.shop_id
    WHERE oi.order_id = ? GROUP BY oi.shop_id`).all(orderId);
}

/** Mark paid + VAT, decrement stock, open shipments, credit the ledger. */
function paidDbEffects(order, groups) {
  const cfg = require('./config');
  // VAT is captured per order once Trove is registered. Prices are
  // VAT-inclusive: consignment rail owes 5/105 of the full amount charged
  // (Trove is the seller); connect rail only of the margin.
  const vat = !cfg.vatRegistered() ? 0
    : order.rail === 'connect' ? cfg.vatFromGross(fees.split(order.subtotal_cents).fee)
    : cfg.vatFromGross(order.total_cents);

  // Payment success is the moment Trove purchases the goods from its
  // suppliers: title transfers now, and the buyer-facing order is paid.
  db.prepare("UPDATE orders SET status='paid', title_transferred_at=datetime('now'), vat_amount_cents=? WHERE id=?").run(vat, order.id);
  const options = require('./options');
  for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id)) {
    const p = db.prepare('SELECT options, variants FROM products WHERE id=?').get(it.product_id);
    const chosen = options.parse(it.options);
    // A piece with variations keeps its stock per combination; products.stock
    // stays the sum so every sold-out check in the app still reads one number.
    if (p && chosen.length && options.parse(p.options).length) {
      const variants = options.parse(p.variants);
      const key = options.variantKey(chosen);
      const v = variants.find((x) => x.key === key);
      if (v) v.stock = Math.max(0, v.stock - it.qty);
      db.prepare('UPDATE products SET variants=?, stock=? WHERE id=?')
        .run(JSON.stringify(variants), options.totalStock(variants), it.product_id);
    } else {
      db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?').run(it.qty, it.product_id);
    }
  }
  // One shipment per shop, so each supplier fulfils and tracks their own items.
  for (const { shop_id } of db.prepare('SELECT DISTINCT shop_id FROM order_items WHERE order_id=?').all(order.id)) {
    const exists = db.prepare('SELECT id FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shop_id);
    if (!exists) {
      const r = db.prepare("INSERT INTO shipments (order_id, shop_id, status) VALUES (?,?, 'processing')").run(order.id, shop_id);
      db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'processing', 'Order received — preparing your items')").run(r.lastInsertRowid);
    }
  }
  // Consignment ledger: record what Trove now owes each supplier — their
  // list price minus the purchase margin. Connect-rail orders (destination
  // charges) bypass the ledger entirely; the unique index on (order, shop)
  // is a second line of defence against double credits.
  if (order.rail !== 'connect') {
    const credit = db.prepare("INSERT OR IGNORE INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?, 'credit_sale', ?)");
    for (const g of groups) {
      if (g.tier === 'consignment') credit.run(g.shop_id, order.id, fees.split(g.cents).net);
    }
  }
}

/** The receipt the confirmation page promises. Fire-and-forget: a mail
 *  failure must never unwind a paid order. Without RESEND_API_KEY it logs
 *  "email skipped" and resolves, so local dev and tests need no setup. */
function sendConfirmation(order) {
  const email = require('./email');
  const options = require('./options');
  const items = db.prepare(`SELECT oi.name_snapshot, oi.qty, oi.price_cents, oi.personalization, oi.options, oi.extras, s.name AS shop_name
    FROM order_items oi JOIN shops s ON s.id = oi.shop_id WHERE oi.order_id=? ORDER BY s.name, oi.id`).all(order.id);
  const extras = require('./extras');
  // Extras are named WITH their prices — the line price already includes them,
  // and the receipt should say why it is more than the listing price.
  const meta = (i) => [options.label(i.options), extras.label(i.extras), i.personalization ? `“${i.personalization}”` : ''].filter(Boolean).join(' · ');
  let ship = null;
  try { ship = order.shipping_json ? JSON.parse(order.shipping_json) : null; } catch (_) { /* keep the receipt, drop the block */ }
  const msg = email.orderConfirmation({
    order,
    items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty, price_cents: i.price_cents, meta: meta(i) })),
    shops: [...new Set(items.map((i) => i.shop_name))],
    ship,
  });
  email.send({ to: order.email, ...msg }).catch((e) => console.error('order-confirmation email failed:', e.message));
}

/** Courier pickups, the buyer's receipt + Rail B leftover transfers. Failure
 *  never blocks the payment — the seller stepper still works by hand. */
function paidPostEffects(order, groups, stripe) {
  const delivery = require('./delivery');
  for (const sh of db.prepare('SELECT id FROM shipments WHERE order_id=?').all(order.id)) {
    delivery.bookPickup(sh.id).catch((e) => console.error('Pickup booking failed for shipment', sh.id, e.message));
  }
  try { sendConfirmation(order); } catch (e) { console.error('order-confirmation email failed:', e.message); }

  if (order.rail === 'connect') return;
  // Rail B leftover: a mixed cart can contain a connect-tier shop's items;
  // those are paid per sale via a Transfer (never from the consignment
  // ledger). Only when the flag is on, the shop is fully onboarded, and a
  // Stripe client exists (demo mode has none — funds stay on platform).
  const cfg = require('./config');
  for (const g of groups) {
    if (g.tier !== 'connect') continue;
    const { net } = fees.split(g.cents);
    if (stripe && cfg.railBEnabled() && g.stripe_account_id && g.charges_enabled && net > 0) {
      stripe.transfers.create({
        amount: net,
        currency: order.currency,
        destination: g.stripe_account_id,
        transfer_group: `order_${order.id}`,
        metadata: { order_id: String(order.id), shop_id: String(g.shop_id) },
      }).then((tr) => {
        db.prepare('UPDATE order_items SET transfer_id=? WHERE order_id=? AND shop_id=?').run(tr.id, order.id, g.shop_id);
      }).catch((e) => console.error('Transfer failed for shop', g.shop_id, e.message));
    } else {
      console.warn(`Shop ${g.shop_id} is connect-tier but not payable (flag ${cfg.railBEnabled() ? 'on' : 'off'}, onboarded ${!!(g.stripe_account_id && g.charges_enabled)}) — funds held on platform.`);
    }
  }
}

module.exports = { perShopGroups, paidDbEffects, paidPostEffects, sendConfirmation };
