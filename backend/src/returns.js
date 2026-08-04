'use strict';
/**
 * Buyer return requests — item-level, photo-backed, admin-decided.
 *
 * Policy (owner-confirmed 2026-07-21; item-level + emails 2026-07-30):
 *   - A buyer may request a return up to BUYER_RETURN_DAYS (30) after the
 *     order was delivered, picking exactly which items go back. An order can
 *     carry several requests, but an item only ever sits in one open or
 *     approved request.
 *   - Refund on approval = the selected items' line totals, in full. The
 *     original delivery fee is not refunded (nor the legacy service fee on
 *     orders that predate its removal).
 *   - Return collection is free when the ORDER's items subtotal exceeds the
 *     free-delivery threshold (AED 200); at or below it the courier fee
 *     (AED 30) is deducted from each request's refund (one request = one
 *     pickup).
 *   - The commission is never refunded: the supplier's credit for the
 *     returned items reverses in full. A credit already swept into a
 *     settlement nets back as a debit_refund on the next run; an unswept
 *     credit simply shrinks in place.
 *   - Stock is NOT restocked (the piece is physically with the seller, who
 *     manages their own count) and captured VAT is NOT adjusted (the sale
 *     stands) — both the owner's explicit decisions, 2026-07-30.
 *
 * The order is stamped refunded_at only once EVERY item is covered by an
 * approved request — that's the point it equals a whole-order refund and the
 * usual "already refunded" gates take over.
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
  return order.subtotal_cents > fees.FREE_DELIVERY_THRESHOLD_CENTS ? 0 : fees.DELIVERY_FEE_CENTS;
}
// The items going back with a request, with their shop for the seller views.
const reqItemsStmt = db.prepare(`
  SELECT ri.order_item_id, ri.qty, oi.name_snapshot, oi.price_cents, oi.shop_id, oi.transfer_id, oi.options, oi.extras,
         s.name AS shop_name
  FROM return_request_items ri
  JOIN order_items oi ON oi.id = ri.order_item_id
  JOIN shops s ON s.id = oi.shop_id
  WHERE ri.request_id = ?`);
function requestItems(requestId) { return reqItemsStmt.all(requestId); }
function grossCents(items) { return items.reduce((t, i) => t + i.price_cents * i.qty, 0); }
/** { gross, fee, refund } for one request, in fils. */
function money(order, requestId) {
  const gross = grossCents(requestItems(requestId));
  const fee = feeCents(order);
  return { gross, fee, refund: Math.max(0, gross - fee) };
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

/** order_item_id → 'requested' | 'approved' for items already spoken for. */
function lockedItems(orderId) {
  const rows = db.prepare(`
    SELECT ri.order_item_id AS id, rr.status
    FROM return_request_items ri JOIN return_requests rr ON rr.id = ri.request_id
    WHERE rr.order_id = ? AND rr.status IN ('requested','approved')`).all(orderId);
  const map = new Map();
  for (const r of rows) map.set(r.id, r.status);
  return map;
}

/** The order's items with their return state — feeds the buyer's picker. */
function returnableItems(order) {
  const locked = lockedItems(order.id);
  // The chosen variation rides along so two lines of the same piece (the mug
  // in Sand and the mug in Clay) are told apart in the return picker.
  return db.prepare('SELECT id, name_snapshot, qty, price_cents, options, extras FROM order_items WHERE order_id=?').all(order.id)
    .map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, price: i.price_cents / 100, options: require('./options').parse(i.options), extras: require('./extras').parse(i.extras).map((e) => ({ name: e.name, price: (e.priceCents || 0) / 100 })), locked: locked.get(i.id) || null }));
}

/* ---- shapes ---- */
function parseImages(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
function shape(r) {
  if (!r) return null;
  const items = requestItems(r.id);
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    reasonLabel: REASONS[r.reason] || r.reason,
    details: r.details,
    images: parseImages(r.images),
    items: items.map((i) => ({ orderItemId: i.order_item_id, name: i.name_snapshot, qty: i.qty, price: i.price_cents / 100, shop: i.shop_name, options: require('./options').parse(i.options), extras: require('./extras').parse(i.extras).map((e) => ({ name: e.name, price: (e.priceCents || 0) / 100 })) })),
    itemsTotal: grossCents(items) / 100,
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

  const ids = [...new Set((Array.isArray(body.itemIds) ? body.itemIds : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return { error: 'Pick at least one item to send back', status: 400 };
  const own = db.prepare(`SELECT id FROM order_items WHERE order_id=? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(order.id, ...ids);
  if (own.length !== ids.length) return { error: 'Those items are not on this order', status: 400 };
  const locked = lockedItems(order.id);
  if (ids.some((id) => locked.has(id))) {
    return { error: 'One of those items is already part of another return request', status: 409 };
  }

  const reason = String(body.reason || '');
  if (!REASONS[reason]) return { error: 'Pick a reason for the return', status: 400 };
  const details = String(body.details || '').trim();
  if (details.length < 5) return { error: 'Tell us a little about what went wrong (a sentence is plenty)', status: 400 };
  if (details.length > MAX_DETAILS) return { error: `Keep the details under ${MAX_DETAILS} characters`, status: 400 };
  const imgs = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!imgs.length) return { error: 'Add at least one photo of the item', status: 400 };
  const urls = imgs.map((im, i) => uploads.saveDataUrl(im, 'returns', `ret-${order.id}-${i}`));

  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO return_requests (order_id, buyer_id, reason, details, images)
      VALUES (?,?,?,?,?)`).run(order.id, user.id, reason, details, JSON.stringify(urls));
    const ins = db.prepare('INSERT INTO return_request_items (request_id, order_item_id, qty) VALUES (?,?,?)');
    const qtyOf = db.prepare('SELECT qty FROM order_items WHERE id=?');
    for (const oid of ids) ins.run(info.lastInsertRowid, oid, qtyOf.get(oid).qty);
    return info.lastInsertRowid;
  })();
  return { id };
}

/* ---- cancel (buyer, while still undecided) ---- */
function cancelOwn(userId, orderId, requestId) {
  const r = db.prepare(`SELECT * FROM return_requests
    WHERE id=? AND order_id=? AND buyer_id=? AND status='requested'`).get(requestId, orderId, userId);
  if (!r) return false;
  parseImages(r.images).forEach((u) => uploads.removeByUrl(u));
  db.prepare('DELETE FROM return_requests WHERE id=?').run(r.id); // items cascade
  return true;
}

/** True once every item on the order sits in an approved request. */
function fullyReturned(orderId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM order_items oi
    WHERE oi.order_id=? AND NOT EXISTS (
      SELECT 1 FROM return_request_items ri JOIN return_requests rr ON rr.id=ri.request_id
      WHERE ri.order_item_id=oi.id AND rr.status='approved')`).get(orderId).c === 0;
}

/**
 * Approve one request: stamp it, reverse the suppliers' credit for exactly
 * the returned items, and stamp the order refunded once everything is back.
 * Call AFTER the card refund succeeded (nothing local changes if Stripe
 * fails). All database effects in one transaction; returns the fresh row.
 */
function approve(rr, order, m) {
  db.transaction(() => {
    db.prepare(`UPDATE return_requests SET status='approved', refund_cents=?, fee_cents=?, decided_at=datetime('now') WHERE id=?`)
      .run(m.refund, m.fee, rr.id);

    if (order.rail !== 'connect') {
      // Per shop: reverse split(returned gross).net of the sale credit. The
      // credit itself was split(shop total).net, so per-item rounding can
      // drift by a fil — when a shop's LAST item comes back we reverse
      // whatever remains instead, and the books close exactly.
      const perShop = new Map();
      for (const it of requestItems(rr.id)) {
        perShop.set(it.shop_id, (perShop.get(it.shop_id) || 0) + it.price_cents * it.qty);
      }
      for (const [shopId, gross] of perShop) {
        const credit = db.prepare(`SELECT * FROM seller_balances
          WHERE order_id=? AND shop_id=? AND type='credit_sale'`).get(order.id, shopId);
        if (!credit) continue; // connect-tier leftovers in a mixed cart have no ledger credit
        const shopDone = db.prepare(`SELECT COUNT(*) AS c FROM order_items oi
          WHERE oi.order_id=? AND oi.shop_id=? AND NOT EXISTS (
            SELECT 1 FROM return_request_items ri JOIN return_requests r2 ON r2.id=ri.request_id
            WHERE ri.order_item_id=oi.id AND r2.status='approved')`).get(order.id, shopId).c === 0;
        if (credit.settlement_id != null) {
          const already = -db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM seller_balances
            WHERE order_id=? AND shop_id=? AND type='debit_refund'`).get(order.id, shopId).s;
          const amt = shopDone ? credit.amount_cents - already
            : Math.min(fees.split(gross).net, credit.amount_cents - already);
          if (amt > 0) {
            db.prepare(`INSERT INTO seller_balances (shop_id, order_id, type, amount_cents)
              VALUES (?,?, 'debit_refund', ?)`).run(shopId, order.id, -amt);
          }
        } else {
          const amt = shopDone ? credit.amount_cents : Math.min(fees.split(gross).net, credit.amount_cents);
          if (amt > 0) db.prepare('UPDATE seller_balances SET amount_cents = amount_cents - ? WHERE id=?').run(amt, credit.id);
        }
      }
    }

    if (fullyReturned(order.id)) {
      db.prepare("UPDATE orders SET refunded_at=datetime('now') WHERE id=? AND refunded_at IS NULL").run(order.id);
    }
  })();

  returnLogistics(order, rr.id);
  return db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr.id);
}

/** Reverse pickups for the shops whose items are coming back. Best-effort
 *  network IO — never blocks the approval. */
function returnLogistics(order, requestId) {
  const items = requestItems(requestId);
  const delivery = require('./delivery');
  const shopIds = [...new Set(items.map((i) => i.shop_id))];
  for (const shopId of shopIds) {
    const sh = db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shopId);
    if (sh && ['shipped', 'out_for_delivery', 'delivered'].includes(sh.status)) {
      delivery.bookReversePickup(sh.id).then((r) => {
        db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
          .run(sh.id, sh.status, `Return pickup booked${r && r.ref ? ' · ' + r.ref : ''}`);
      }).catch((e) => console.error('Reverse pickup failed for shipment', sh.id, e.message));
    }
  }
  const transferred = [...new Set(items.map((i) => i.transfer_id).filter(Boolean))];
  if (transferred.length) {
    console.warn(`return ${requestId} (${order.public_id}): reverse these Stripe Transfers by hand:`, transferred.join(', '));
  }
}

/**
 * Everything a WHOLE-ORDER refund changes after the card was refunded: stamp
 * the order, reverse already-settled supplier credits, cancel unshipped
 * parcels, book reverse pickups for parcels that went out. Used by the
 * admin's manual refund button (returns approval uses approve() above).
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
  feeCents, money, grossCents, requestItems, returnableItems, lockedItems,
  ineligibleReason, deadline, fullyReturned,
  shape, create, cancelOwn, approve, applyRefundEffects,
};
