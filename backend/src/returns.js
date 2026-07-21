'use strict';
/**
 * Buyer return requests — whole-order, photo-backed, admin-decided.
 *
 * Policy (owner-confirmed 2026-07-21):
 *   - A buyer may request a return up to BUYER_RETURN_DAYS (30) after the
 *     order was delivered. The request needs a reason and at least one photo.
 *   - Refund on approval = the items subtotal, in full. The service fee and
 *     the original delivery fee are not refunded.
 *   - Return collection is free when the items subtotal reached the free-
 *     delivery threshold (AED 500); below it the courier fee (AED 25) is
 *     deducted from the refund.
 *   - The commission is never refunded to anyone: the supplier's full sale
 *     credit is reversed and Trove's margin simply unwinds with the sale.
 *
 * The settlement hold (RETURN_WINDOW_DAYS = 7) is unchanged: a return after
 * a supplier was paid nets against their next weekly run via debit_refund.
 */
const db = require('./db');
const uploads = require('./uploads');
const fees = require('./fees');
const { BUYER_RETURN_DAYS } = require('./config');

const REASONS = {
  damaged: 'Arrived damaged',
  'not-as-described': 'Not as described',
  'wrong-item': 'Wrong item received',
  'changed-mind': 'Changed my mind',
  other: 'Something else',
};
const MAX_IMAGES = 3;
const MAX_DETAILS = 1000;

/* ---- money ---- */
function feeCents(order) {
  return order.subtotal_cents >= fees.FREE_DELIVERY_THRESHOLD_CENTS ? 0 : fees.DELIVERY_FEE_CENTS;
}
function refundCents(order) {
  return Math.max(0, order.subtotal_cents - feeCents(order));
}

/* ---- eligibility: why this order can't be returned, or null if it can ---- */
function ineligibleReason(order) {
  if (!order) return 'Order not found';
  if (order.refunded_at) return 'This order was already refunded';
  if (!['paid', 'fulfilled'].includes(order.status)) return 'Only paid orders can be returned';
  if (!order.delivered_at) return 'Returns open once the order has been delivered';
  const open = db.prepare("SELECT datetime(?, '+' || ? || ' days') > datetime('now') AS ok")
    .get(order.delivered_at, BUYER_RETURN_DAYS).ok;
  if (!open) return `The ${BUYER_RETURN_DAYS}-day return window for this order has closed`;
  return null;
}
function deadline(order) {
  if (!order.delivered_at) return null;
  return db.prepare("SELECT datetime(?, '+' || ? || ' days') AS d").get(order.delivered_at, BUYER_RETURN_DAYS).d;
}

/* ---- shapes ---- */
function parseImages(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
function shape(r) {
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    reasonLabel: REASONS[r.reason] || r.reason,
    details: r.details,
    images: parseImages(r.images),
    refund: r.refund_cents != null ? r.refund_cents / 100 : null,
    fee: r.fee_cents != null ? r.fee_cents / 100 : null,
    declineReason: r.decline_reason || null,
    createdAt: r.created_at,
    decidedAt: r.decided_at || null,
  };
}

/* ---- create (buyer) ---- */
function create(user, order, body) {
  const blocked = ineligibleReason(order);
  if (blocked) return { error: blocked, status: 409 };
  if (db.prepare('SELECT id FROM return_requests WHERE order_id=?').get(order.id)) {
    return { error: 'A return was already requested for this order', status: 409 };
  }
  const reason = String(body.reason || '');
  if (!REASONS[reason]) return { error: 'Pick a reason for the return', status: 400 };
  const details = String(body.details || '').trim();
  if (details.length < 5) return { error: 'Tell us a little about what went wrong (a sentence is plenty)', status: 400 };
  if (details.length > MAX_DETAILS) return { error: `Keep the details under ${MAX_DETAILS} characters`, status: 400 };
  const imgs = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!imgs.length) return { error: 'Add at least one photo of the item', status: 400 };
  const urls = imgs.map((im, i) => uploads.saveDataUrl(im, 'returns', `ret-${order.id}-${i}`));
  const info = db.prepare(`INSERT INTO return_requests (order_id, buyer_id, reason, details, images)
    VALUES (?,?,?,?,?)`).run(order.id, user.id, reason, details, JSON.stringify(urls));
  return { id: info.lastInsertRowid };
}

/* ---- cancel (buyer, while still undecided) ---- */
function cancelOwn(userId, orderId) {
  const r = db.prepare("SELECT * FROM return_requests WHERE order_id=? AND buyer_id=? AND status='requested'").get(orderId, userId);
  if (!r) return false;
  parseImages(r.images).forEach((u) => uploads.removeByUrl(u));
  db.prepare('DELETE FROM return_requests WHERE id=?').run(r.id);
  return true;
}

/**
 * Everything a refund changes AFTER the card has been (partially) refunded:
 * stamp the order, reverse already-settled supplier credits, cancel unshipped
 * parcels, book reverse pickups for parcels that went out. Shared by the
 * manual whole-order refund and return-request approval so the two paths can
 * never drift. Call inside no transaction — it manages its own.
 */
function applyRefundEffects(order) {
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
  const delivery = require('./delivery');
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
}

module.exports = {
  REASONS, MAX_IMAGES, BUYER_RETURN_DAYS,
  feeCents, refundCents, ineligibleReason, deadline,
  shape, create, cancelOwn, applyRefundEffects,
};
