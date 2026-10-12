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

/** Per-shop item totals for an order (units still on it — a cancelled unit
 *  is out), with each shop's payout wiring. */
function perShopGroups(orderId) {
  return db.prepare(`
    SELECT oi.shop_id, s.stripe_account_id, s.charges_enabled, s.tier, s.is_house, SUM(oi.price_cents * (oi.qty - oi.cancelled_qty)) AS cents
    FROM order_items oi JOIN shops s ON s.id = oi.shop_id
    WHERE oi.order_id = ? GROUP BY oi.shop_id`).all(orderId);
}

/**
 * Take the paid order's pieces out of stock, line by line. Every decrement
 * is conditional (plain pieces: UPDATE … WHERE stock >= qty; pieces with
 * variations: the combination's own stock, read and written inside the same
 * write transaction — SQLite runs one writer at a time, so nothing can slip
 * in between). A line that can't be covered is NOT taken and comes back in
 * the shortfall:
 *   - two buyers paid for the last one (stock),
 *   - the piece was unlisted, or its shop paused or suspended, while the
 *     buyer was paying (F216),
 *   - the maker added variations since checkout, so a plain line no longer
 *     matches any combination (F442 — taking it from the total alone would
 *     be undone by the maker's next save and oversell the piece).
 * The other lines keep their stock taken (F212: one sold-out piece no
 * longer sinks a whole basket). Returns the short order_items rows.
 */
function takeStock(order) {
  const options = require('./options');
  return db.transaction(() => {
    const short = [];
    for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(order.id)) {
      const p = db.prepare('SELECT p.options, p.variants, p.status, s.status AS shop_status FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id=?').get(it.product_id);
      if (!p || p.status !== 'live' || p.shop_status !== 'approved') { short.push(it); continue; }
      const chosen = options.parse(it.options);
      const grid = options.parse(p.options).length > 0;
      // A piece with variations keeps its stock per combination; products.stock
      // stays the sum so every sold-out check in the app still reads one number.
      if (chosen.length && grid) {
        const variants = options.parse(p.variants);
        const v = variants.find((x) => x.key === options.variantKey(chosen));
        if (!v || (parseInt(v.stock, 10) || 0) < it.qty) { short.push(it); continue; }
        v.stock = (parseInt(v.stock, 10) || 0) - it.qty;
        db.prepare('UPDATE products SET variants=?, stock=? WHERE id=?')
          .run(JSON.stringify(variants), options.totalStock(variants), it.product_id);
      } else if (!chosen.length && grid) {
        short.push(it);
      } else {
        const r = db.prepare('UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ?').run(it.qty, it.product_id, it.qty);
        if (!r.changes) short.push(it);
      }
    }
    return short;
  })();
}

/** Something the courier needs is missing (F213): a delivery name + line, or the buyer's mobile. */
function deliveryDetailsMissing(order) {
  let ship = null;
  try { ship = order.shipping_json ? JSON.parse(order.shipping_json) : null; } catch (_) { ship = null; }
  return !ship || !String(ship.name || '').trim() || !String(ship.line || '').trim() || !String(order.phone || '').trim();
}

/**
 * Mark paid + VAT, decrement stock, open shipments, credit the ledger.
 * Returns { ok: true, shortfall } — `shortfall` lists the lines that could
 * not be sold (sold out, unlisted, shop paused — see takeStock); the caller
 * cancels and refunds just those through src/cancellations.js (afterPaid).
 * When NOTHING on the order can be sold it is { ok: false, shortfall }: the
 * order is cancelled and flagged (attention='oversold'), nothing is shipped
 * or credited, and the caller refunds the whole payment via
 * unavailablePostEffects.
 */
function paidDbEffects(order, groups) {
  const lineCount = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id=?').get(order.id).n;
  const shortfall = takeStock(order);
  if (shortfall.length && shortfall.length >= lineCount) {
    db.prepare("UPDATE orders SET status='cancelled', attention='oversold' WHERE id=?").run(order.id);
    return { ok: false, shortfall };
  }

  const cfg = require('./config');
  // VAT is captured per order once Trove is registered. Prices are
  // VAT-inclusive: consignment rail owes 5/105 of the full amount charged
  // (Trove is the seller); connect rail of what Trove keeps — the margin on
  // the goods plus the buyer fees (service + delivery), exactly the
  // application fee the connect PaymentIntent carries (F443).
  const vat = !cfg.vatRegistered() ? 0
    : order.rail === 'connect' ? cfg.vatFromGross(fees.split(order.subtotal_cents).fee + (order.service_fee_cents || 0) + (order.shipping_cents || 0))
    : cfg.vatFromGross(order.total_cents);

  // Payment success is the moment Trove purchases the goods from its
  // suppliers: title transfers now, and the buyer-facing order is paid.
  db.prepare("UPDATE orders SET status='paid', title_transferred_at=datetime('now'), vat_amount_cents=? WHERE id=?").run(vat, order.id);
  // A VAT-registered sale gets the next sequential tax invoice number
  // (src/tax-docs.js) — inside this transaction, so numbers never skip or repeat.
  if (vat > 0) require('./tax-docs').assignInvoiceNo(order.id);
  // One shipment per shop, so each supplier fulfils and tracks their own items.
  // Its pack-by date = today (the day the order is paid) + the slowest of
  // THAT shop's pieces in the order (make/pack time snapshotted at checkout).
  const { packByAt } = require('./lead-times');
  const paidAt = db.prepare("SELECT datetime('now') AS t").get().t;
  for (const { shop_id, lead } of db.prepare(`SELECT oi.shop_id, MAX(COALESCE(oi.lead_days, p.lead_days, ?)) AS lead
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id=? GROUP BY oi.shop_id`).all(fees.LEAD_DAYS_DEFAULT, order.id)) {
    const exists = db.prepare('SELECT id FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shop_id);
    if (!exists) {
      const r = db.prepare("INSERT INTO shipments (order_id, shop_id, status, pack_by_at) VALUES (?,?, 'processing', ?)").run(order.id, shop_id, packByAt(paidAt, lead));
      db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'processing', 'Order received — preparing your items')").run(r.lastInsertRowid);
    }
  }
  // Consignment ledger: record what Trove now owes each supplier — their
  // list price minus the purchase margin. Connect-rail orders (destination
  // charges) bypass the ledger entirely; the unique index on (order, shop)
  // is a second line of defence against double credits. The Trove Collection
  // (is_house) is Trove's own stock: Trove keeps the whole sale, so there is
  // no maker to owe: no credit, nothing to settle, and nothing to reverse on
  // a return (returns.js skips a shop without a credit).
  if (order.rail !== 'connect') {
    const credit = db.prepare("INSERT OR IGNORE INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?, 'credit_sale', ?)");
    for (const g of groups) {
      if (g.tier === 'consignment' && !g.is_house) credit.run(g.shop_id, order.id, fees.split(g.cents).net);
    }
  }
  // Paid without the delivery details the courier needs (a client that
  // skipped /checkout/update): the order stands, but no courier is booked
  // until the owner adds them — courier-ops refuses the booking and flags
  // each parcel 'missing_address' (F213).
  if (deliveryDetailsMissing(order)) console.warn(`order ${order.public_id}: paid without a delivery address or mobile — courier held until they are added`);
  return { ok: true, shortfall };
}

/**
 * The lines that could not be sold at payment (paidDbEffects' shortfall):
 * cancelled and refunded through the same code as an admin's 'Cancel items'
 * (src/cancellations.js — partial card refund, maker credit + VAT reversed,
 * an emptied parcel cancelled), so the rest of the basket goes ahead (F212).
 * The buyer gets the 'part of your order is cancelled' email naming what sold
 * out; makers whose piece sold out were never told to pack it, so they are
 * not emailed. A failed card refund leaves the line on the order, flagged
 * 'oversold_refund_failed', and the owner is asked to cancel it by hand.
 * Resolves true when the lines were cancelled.
 */
async function cancelShortLines(orderIn, lines) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderIn.id) || orderIn;
  const picks = lines.map((l) => ({ id: l.id, qty: l.qty - (l.cancelled_qty || 0) })).filter((p) => p.qty > 0);
  if (!picks.length) return true;
  const names = [...new Set(lines.map((l) => l.name_snapshot))];
  try {
    const r = await require('./cancellations').cancel(order, picks, { reason: 'sold_out', soldOut: true, notifyMakers: false });
    console.warn(`order ${order.public_id}: ${names.join(', ')} could not be sold at payment — cancelled and refunded, the rest goes ahead`);
    require('./notify').ownerSoldOut(order.id, { refunded: true, soldOut: true, partial: { names, refundCents: r.cancellation ? Math.round(r.cancellation.refund * 100) : 0 } });
    return true;
  } catch (e) {
    db.prepare("UPDATE orders SET attention='oversold_refund_failed' WHERE id=?").run(order.id);
    console.error(`order ${order.public_id}: AUTOMATIC CANCELLATION OF ${names.join(', ')} FAILED — cancel by hand:`, e.message);
    require('./notify').ownerSoldOut(order.id, { refunded: false, soldOut: true, partial: { names, refundCents: 0 } });
    return false;
  }
}

/** Everything after a payment's database effects committed: cancel the
 *  lines that could not be sold (if any), then the courier, receipt and
 *  maker emails. Returns a promise (callers fire and forget; tests await). */
async function afterPaid(order, groups, result, stripe) {
  if (result && result.shortfall && result.shortfall.length) {
    await cancelShortLines(order, result.shortfall);
    groups = perShopGroups(order.id); // what is left to pay out per shop (Rail B leftovers)
  }
  paidPostEffects(order, groups, stripe);
}

/**
 * The order was paid but can't go ahead (a piece sold out first, or the
 * unpaid-checkout sweep had already cancelled it): refund the whole payment
 * automatically and tell the buyer. The order stays flagged for admin; if the
 * refund itself fails the flag says so, and Trove refunds by hand. Returns a
 * promise (callers fire and forget; tests await it).
 */
function unavailablePostEffects(order, lines, stripe, { soldOut = true } = {}) {
  const flagFailed = soldOut ? 'oversold_refund_failed' : 'refund_failed';
  const refund = (stripe && order.stripe_payment_intent_id)
    ? stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      ...(order.rail === 'connect' ? { reverse_transfer: true, refund_application_fee: true } : {}),
      metadata: { order_id: String(order.id), reason: soldOut ? 'sold_out' : 'expired', trove_kind: 'unavailable' },
    }, { idempotencyKey: `trove-unavailable-${order.id}` }).then(() => {
      db.prepare("UPDATE orders SET refunded_at=COALESCE(refunded_at, datetime('now')) WHERE id=?").run(order.id);
      console.warn(`order ${order.public_id}: ${soldOut ? 'sold out before payment' : 'paid after it was cancelled'} — refunded in full automatically`);
      return true;
    }).catch((e) => {
      db.prepare('UPDATE orders SET attention=? WHERE id=?').run(flagFailed, order.id);
      console.error(`order ${order.public_id}: AUTOMATIC REFUND FAILED — refund by hand in Stripe:`, e.message);
      return false;
    })
    : Promise.resolve(false); // demo mode: no money was taken

  return refund.then((refunded) => {
    // The owner hears about every order that could not go ahead — and must
    // act by hand when the automatic refund failed (demo mode: no money moved).
    if (refunded || (stripe && order.stripe_payment_intent_id)) require('./notify').ownerSoldOut(order.id, { refunded, soldOut });
    if (!refunded) return refunded;
    try {
      const email = require('./email');
      const msg = email.orderUnavailable({
        order,
        soldOut,
        items: (lines || []).map((i) => ({ name: i.name_snapshot, qty: i.qty, price_cents: i.price_cents,
          meta: require('./options').label(i.options) })),
      });
      email.send({ to: order.email, ...msg }).catch((e) => console.error('order-unavailable email failed:', e.message));
    } catch (e) { console.error('order-unavailable email failed:', e.message); }
    return refunded;
  });
}

/** The receipt the confirmation page promises. Fire-and-forget: a mail
 *  failure must never unwind a paid order. Without RESEND_API_KEY it logs
 *  "email skipped" and resolves, so local dev and tests need no setup. */
function sendConfirmation(orderIn) {
  // Re-read: the caller's row predates the payment (VAT + invoice number are stamped then).
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderIn.id) || orderIn;
  const email = require('./email');
  const options = require('./options');
  // Only what is coming: a line that sold out at payment was cancelled and
  // refunded just before (its own email says so), and the totals show it.
  const items = db.prepare(`SELECT oi.name_snapshot, oi.qty - oi.cancelled_qty AS qty, oi.price_cents, oi.personalization, oi.options, oi.extras, s.name AS shop_name, p.images,
      oi.shop_id, COALESCE(oi.lead_days, p.lead_days) AS lead_days
    FROM order_items oi JOIN shops s ON s.id = oi.shop_id LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id=? AND oi.qty > oi.cancelled_qty ORDER BY s.name, oi.id`).all(order.id);
  const refundedCents = db.prepare("SELECT COALESCE(SUM(refund_cents),0) AS s FROM order_cancellations WHERE order_id=? AND status='refunded'").get(order.id).s;
  const extras = require('./extras');
  // Extras are named WITH their prices — the line price already includes them,
  // and the receipt should say why it is more than the listing price.
  const meta = (i) => [options.label(i.options), extras.label(i.extras), i.personalization ? `“${i.personalization}”` : ''].filter(Boolean).join(' · ');
  let ship = null;
  try { ship = order.shipping_json ? JSON.parse(order.shipping_json) : null; } catch (_) { /* keep the receipt, drop the block */ }
  const msg = email.orderConfirmation({
    order,
    items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty, price_cents: i.price_cents, meta: meta(i), shop: i.shop_name,
      image: email.productImage({ images: i.images, name: i.name_snapshot }) })),
    shops: [...new Set(items.map((i) => i.shop_name))],
    ship,
    estimate: require('./lead-times').orderEstimate(items),
    refundedCents,
  });
  email.send({ to: order.email, ...msg }).catch((e) => console.error('order-confirmation email failed:', e.message));
}

/** Courier pickups, the buyer's receipt + Rail B leftover transfers. Failure
 *  never blocks the payment — the seller stepper still works by hand. */
function paidPostEffects(order, groups, stripe) {
  // A failed booking is recorded on the shipment, the admin is emailed and
  // the hourly sweep retries it (src/courier-ops.js) — never just a log line.
  const courier = require('./courier-ops');
  // (a parcel emptied by a sold-out line was cancelled — nothing to book)
  for (const sh of db.prepare("SELECT id FROM shipments WHERE order_id=? AND status <> 'cancelled'").all(order.id)) courier.book(sh.id);
  try { sendConfirmation(order); } catch (e) { console.error('order-confirmation email failed:', e.message); }
  // Each maker hears about their own pieces only (no buyer contact details).
  require('./notify').ordersToPack(order);
  // …and the owner hears a new order is in (first name + order number only).
  require('./notify').ownerNewOrder(order.id);

  if (order.rail === 'connect') return;
  // Rail B leftover: a mixed cart can contain a connect-tier shop's items;
  // those are paid per sale via a Transfer (never from the consignment
  // ledger). Only when the flag is on, the shop is fully onboarded, and a
  // Stripe client exists (demo mode has none — funds stay on platform).
  const cfg = require('./config');
  for (const g of groups) {
    if (g.tier !== 'connect' || g.is_house) continue;
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

/**
 * Does the PaymentIntent carry exactly what the order charges (F440)? A
 * mismatch — an intent edited in the Stripe dashboard, metadata reused on
 * another payment — must never fulfil the order. Returns null when it
 * matches (or the event carries no amount to compare), else a description.
 */
function amountMismatch(order, pi) {
  if (!pi || typeof pi !== 'object') return null;
  const paid = pi.amount_received != null ? pi.amount_received : pi.amount;
  const bad = [];
  if (paid != null && Number(paid) !== Number(order.total_cents)) bad.push(`amount ${paid} ≠ ${order.total_cents}`);
  if (pi.currency && String(pi.currency).toLowerCase() !== String(order.currency || 'aed').toLowerCase()) bad.push(`currency ${pi.currency} ≠ ${order.currency}`);
  return bad.length ? bad.join(', ') : null;
}

/** A payment that does not match its order: cancel + flag it (never
 *  fulfilled, never auto-refunded — a person decides) and tell the owner once. */
function holdMismatch(order, why, pi) {
  const flagged = db.prepare("UPDATE orders SET status='cancelled', attention='amount_mismatch' WHERE id=? AND status='pending'").run(order.id).changes;
  if (!flagged) return;
  console.error(`order ${order.public_id}: PAYMENT DOES NOT MATCH THE ORDER (${why}) — not fulfilled`);
  require('./notify').adminAlert({
    subject: `ACTION: payment for order ${order.public_id} does not match the order`,
    title: 'A payment did not match its order',
    kicker: `Order ${order.public_id}`,
    lines: [
      `Stripe reports a payment for ${order.public_id} that is not what the order charges (${why}), so nothing was sent and no maker was credited.`,
      `Check the payment in the Stripe dashboard${pi && pi.id ? ` (${pi.id})` : ''}, then refund it or contact the buyer.`,
    ],
  });
}

/**
 * Complete a pending order whose payment succeeded — exactly once, whoever
 * gets there first: the Stripe webhook (eventId = the Stripe event id) or
 * the hourly sweep that finds a succeeded PaymentIntent the webhook never
 * delivered (eventId = 'sweep-<pi id>'). ONE transaction holds the
 * idempotency row, a fresh status check and every database effect; the
 * network effects run after it. `pi` (the PaymentIntent, when the caller has
 * it) is checked against the order first. Returns null when there was
 * nothing to do, { ok: false, mismatch } for a payment that does not match,
 * else { ok, shortfall } like paidDbEffects.
 */
function completePaid(orderId, eventId, eventType, stripe, pi = null) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order || order.status !== 'pending') return null;
  const mismatch = amountMismatch(order, pi);
  if (mismatch) { holdMismatch(order, mismatch, pi); return { ok: false, mismatch, shortfall: [] }; }
  const groups = perShopGroups(orderId);
  const result = db.transaction(() => {
    const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?,?)').run(eventId, eventType);
    if (!seen.changes) return null;
    if (db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status !== 'pending') return null;
    return paidDbEffects(order, groups);
  })();
  // Courier pickups + Rail B leftover transfers — outside the transaction
  // (network IO), failure never blocks the payment. Lines that could not be
  // sold are cancelled and refunded first; when nothing could be sold, the
  // whole order is refunded instead.
  if (result && result.ok) {
    afterPaid(order, groups, result, stripe).catch((e) => console.error(`order ${order.public_id}: after-payment effects failed:`, e.message));
  } else if (result) unavailablePostEffects(order, result.shortfall, stripe);
  return result;
}

module.exports = { perShopGroups, takeStock, paidDbEffects, paidPostEffects, unavailablePostEffects, sendConfirmation, completePaid, afterPaid, cancelShortLines, amountMismatch, deliveryDetailsMissing };
