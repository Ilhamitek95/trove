'use strict';
/**
 * Buyer return requests — item-level (down to the unit), photo-backed,
 * admin-decided, refunded when the courier has collected the piece.
 *
 * Policy (owner-confirmed 2026-07-21; item-level + emails 2026-07-30;
 * 15-day window, reasons and refund-on-collection 2026-09-30):
 *   - A buyer may request a return up to fees.RETURN_WINDOW_DAYS (15) after
 *     the order was delivered (orders placed before 2026-09-30 keep the 30
 *     days they were sold with — migration 016), picking exactly which items,
 *     and how many units of each, go back. An order can carry several
 *     requests; a unit only ever sits in one request that is not declined.
 *   - The buyer names a reason: changed my mind, faulty or damaged, wrong
 *     item, or not as described. A personalised piece can only go back for
 *     one of the last three.
 *   - Refund = the selected units' share of their line totals. The original
 *     delivery fee is kept (as is the legacy service fee on orders that
 *     predate its removal) — EXCEPT when the whole order comes back because
 *     of a fault (owner, 2026-09-30). Precisely, a request carries the
 *     delivery refund when, at the moment it is approved:
 *       1. its own reason is a fault reason (damaged, wrong item, not as
 *          described), and
 *       2. together with the order's other approved/collected/refunded
 *          requests it covers EVERY unit on the order (so this request
 *          completes the order), and
 *       3. every one of those requests is for a fault reason too, and
 *       4. the order paid a delivery fee and no other request on it has
 *          already carried the delivery refund.
 *     A partial return, or a whole order where any unit came back as a
 *     change of mind, keeps the delivery fee. The delivery fee is Trove's
 *     (never a maker credit), so it is refunded on top of the items at the
 *     card-refund step and its VAT reverses with the rest of the refund. The
 *     admin can override at approval (refundDelivery true/false); charging
 *     the collection fee on a fault claim (treating it as a change of mind)
 *     drops the delivery refund too unless the admin asks for it explicitly.
 *   - Collection fee: charged per return REQUEST (owner, 2026-09-30) — the
 *     buyer form says so, so several pieces sent back together pay it once.
 *   - The AED 30 collection fee applies ONLY to 'changed my mind' on an order
 *     whose items subtotal is at or below the free-delivery threshold; a
 *     fault, a wrong item or a misdescription is collected free. The admin
 *     can override the decision either way when approving.
 *   - Lifecycle: requested → approved (the admin's decision books the courier
 *     collection) → collected (courier webhook, or the mock hand-crank) →
 *     refunded (card refund, supplier credit reversal, VAT credit note). An
 *     admin 'refund now' override exists for exceptions. Declined is final.
 *   - The commission is never refunded: the supplier's credit for the
 *     returned units reverses in full. Credits wait for the buyer's window,
 *     so the credit is normally still unswept and simply shrinks in place; a
 *     credit already swept (old 30-day orders, late exceptions) nets back as
 *     a debit_refund on the next run.
 *   - Stock is NOT restocked (the piece is physically with the seller, who
 *     manages their own count) — the owner's decision, 2026-07-30.
 *   - VAT: once Trove is registered, the VAT inside the refunded amount is
 *     reversed on the order (orders.vat_reversed_cents) and the refund carries
 *     a credit-note reference.
 *
 * The order is stamped refunded_at only once EVERY unit is covered by a
 * refunded request — that's the point it equals a whole-order refund and the
 * usual "already refunded" gates take over.
 */
const db = require('./db');
const uploads = require('./uploads');
const fees = require('./fees');
const cfg = require('./config');
const { BUYER_RETURN_DAYS } = cfg;

// What a buyer can pick today. 'other' only survives as a label on requests
// made before 2026-09-30.
const REASONS = {
  'changed-mind': 'Changed my mind',
  damaged: 'Faulty or damaged',
  'wrong-item': 'Wrong item received',
  'not-as-described': 'Not as described',
};
const LEGACY_REASONS = { other: 'Something else' };
const reasonLabel = (r) => REASONS[r] || LEGACY_REASONS[r] || r;
/** Reasons where the fault is not the buyer's: free collection, and the only
 *  ones a personalised piece can come back for. */
const FAULT_REASONS = new Set(['damaged', 'wrong-item', 'not-as-described']);
// Statuses that hold units (and the supplier's credit). Declined frees them.
const LIVE_STATUSES = ['requested', 'approved', 'collected', 'refunded'];
const IN_FLIGHT = ['requested', 'approved', 'collected'];
const MAX_IMAGES = 3;
const MAX_DETAILS = 1000;

/* ---- money ---- */
/** The changed-my-mind collection fee this order would carry (0 over the threshold). */
function changeOfMindFee(order) {
  return order.subtotal_cents > fees.FREE_DELIVERY_THRESHOLD_CENTS ? 0 : fees.DELIVERY_FEE_CENTS;
}
/**
 * The collection fee for one request: the fee rule applies to 'changed my
 * mind' only; `override` (true = charge, false = waive) is the admin's call.
 */
function feeCents(order, reason = 'changed-mind', override = null) {
  if (override === true) return fees.DELIVERY_FEE_CENTS;
  if (override === false) return 0;
  return reason === 'changed-mind' ? changeOfMindFee(order) : 0;
}
// The units going back with a request, with their shop for the seller views.
const reqItemsStmt = db.prepare(`
  SELECT ri.order_item_id, ri.qty, oi.qty AS line_qty, oi.name_snapshot, oi.price_cents, oi.shop_id, oi.transfer_id,
         oi.options, oi.extras, oi.personalization, s.name AS shop_name, p.images AS product_images
  FROM return_request_items ri
  JOIN order_items oi ON oi.id = ri.order_item_id
  JOIN shops s ON s.id = oi.shop_id
  LEFT JOIN products p ON p.id = oi.product_id
  WHERE ri.request_id = ?`);
function requestItems(requestId) { return reqItemsStmt.all(requestId); }
// price_cents is the UNIT price (extras folded in), so a unit-level return is
// proportional by construction: 1 of 2 identical mugs = one unit's price.
function grossCents(items) { return items.reduce((t, i) => t + i.price_cents * i.qty, 0); }
const feeOverrideOf = (rr) => (rr.fee_override === 1 ? true : rr.fee_override === 0 ? false : null);
const deliveryOverrideOf = (rr) => (rr.delivery_override === 1 ? true : rr.delivery_override === 0 ? false : null);

/**
 * Does this request, by the rule, refund the order's original delivery fee?
 * See the policy note at the top: fault reason, completes the order with
 * decided (approved/collected/refunded) requests, every one of them a fault.
 * `row` is the request row (its order is looked up by row.order_id).
 */
function deliveryRefundRule(row) {
  if (!FAULT_REASONS.has(row.reason)) return false;
  const others = db.prepare(`SELECT id, reason FROM return_requests
    WHERE order_id=? AND id != ? AND status IN ('approved','collected','refunded')`).all(row.order_id, row.id);
  if (others.some((o) => !FAULT_REASONS.has(o.reason))) return false;
  const ids = [row.id, ...others.map((o) => o.id)];
  const covered = db.prepare(`SELECT COALESCE(SUM(qty),0) AS q FROM return_request_items
    WHERE request_id IN (${ids.map(() => '?').join(',')})`).get(...ids).q;
  // Units Trove cancelled before dispatch were never delivered, so the
  // order that came back is what was actually sent.
  const total = db.prepare('SELECT COALESCE(SUM(qty - cancelled_qty),0) AS q FROM order_items WHERE order_id=?').get(row.order_id).q;
  return total > 0 && covered >= total;
}
/** The delivery fee still refundable on the order (0 once another request,
 *  or a cancellation of the whole order, carried it). */
function deliveryLeftCents(row) {
  const o = db.prepare('SELECT shipping_cents FROM orders WHERE id=?').get(row.order_id);
  const paid = (o && o.shipping_cents) || 0;
  const already = db.prepare(`SELECT COALESCE(SUM(delivery_refund_cents),0) AS s FROM return_requests
    WHERE order_id=? AND id != ? AND status IN ('approved','collected','refunded')`).get(row.order_id, row.id).s
    + db.prepare("SELECT COALESCE(SUM(delivery_refund_cents),0) AS s FROM order_cancellations WHERE order_id=? AND status='refunded'").get(row.order_id).s;
  return Math.max(0, paid - already);
}
/** The delivery refund for one request: the rule, or the admin's override
 *  (true = refund it, false = keep it). Charging the collection fee on a
 *  fault claim drops it by default. */
function deliveryRefundCents(row, { deliveryOverride = null, feeOverride = null } = {}) {
  let refund;
  if (deliveryOverride === true) refund = true;
  else if (deliveryOverride === false) refund = false;
  else refund = deliveryRefundRule(row) && feeOverride !== true;
  return refund ? deliveryLeftCents(row) : 0;
}

/** { gross, fee, delivery, refund } for one request, in fils. `rr` is the
 *  request row (or its id); `opts.feeOverride` / `opts.deliveryOverride`
 *  preview the admin's overrides. Once approved the stamped figures win. */
function money(order, rr, opts = {}) {
  const row = typeof rr === 'object' ? rr : db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr);
  const gross = grossCents(requestItems(row.id));
  const feeOverride = opts.feeOverride !== undefined ? opts.feeOverride : feeOverrideOf(row);
  const fee = feeCents(order, row.reason, feeOverride);
  const deliveryOverride = opts.deliveryOverride !== undefined ? opts.deliveryOverride : deliveryOverrideOf(row);
  const previewing = opts.deliveryOverride !== undefined || opts.feeOverride !== undefined;
  const decided = row.status && row.status !== 'requested';
  const delivery = decided && !previewing
    ? (row.delivery_refund_cents || 0) // stamped at approval (NULL on requests approved before the rule)
    : deliveryRefundCents(row, { deliveryOverride, feeOverride });
  return { gross, fee, delivery, refund: Math.max(0, gross - fee) + delivery };
}

/* ---- eligibility: why this order can't be returned, or null if it can ----
 * The buyer's deadline is the order's return_window_ends_at, stamped at the
 * last delivery as delivered + the order's return days (15, or 30 on orders
 * placed before the 2026-09-30 change — migration 016). Rows without the
 * stamp fall back to delivered_at + the same number of days. */
const daysFor = (order) => order.return_days || BUYER_RETURN_DAYS;
function deadline(order) {
  if (!order.delivered_at) return null;
  return order.return_window_ends_at
    || db.prepare("SELECT datetime(?, '+' || ? || ' days') AS d").get(order.delivered_at, daysFor(order)).d;
}
function ineligibleReason(order) {
  if (!order) return 'Order not found';
  if (order.refunded_at) return 'This order was already refunded';
  if (!['paid', 'fulfilled'].includes(order.status)) return 'Only paid orders can be returned';
  if (!order.delivered_at) return 'Returns open once the order has been delivered';
  const open = db.prepare("SELECT datetime(?) > datetime('now') AS ok").get(deadline(order)).ok;
  if (!open) return `The ${daysFor(order)}-day return window for this order has closed`;
  return null;
}

/** order_item_id → { qty, statuses[] } for units already spoken for. */
function heldUnits(orderId) {
  const rows = db.prepare(`
    SELECT ri.order_item_id AS id, ri.qty, rr.status
    FROM return_request_items ri JOIN return_requests rr ON rr.id = ri.request_id
    WHERE rr.order_id = ? AND rr.status IN (${LIVE_STATUSES.map(() => '?').join(',')})`).all(orderId, ...LIVE_STATUSES);
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.id) || { qty: 0, statuses: [] };
    cur.qty += r.qty;
    cur.statuses.push(r.status);
    map.set(r.id, cur);
  }
  return map;
}
/** order_item_id → 'requested' | 'approved' for items with NO unit left to send back. */
function lockedItems(orderId) {
  const held = heldUnits(orderId);
  const lines = db.prepare('SELECT id, qty - cancelled_qty AS qty FROM order_items WHERE order_id=?').all(orderId);
  const map = new Map();
  for (const l of lines) {
    const h = held.get(l.id);
    if (h && h.qty >= l.qty) map.set(l.id, h.statuses.includes('requested') ? 'requested' : 'approved');
  }
  return map;
}

/** The order's items with their return state — feeds the buyer's picker. */
function returnableItems(order) {
  const held = heldUnits(order.id);
  // The chosen variation rides along so two lines of the same piece (the mug
  // in Sand and the mug in Clay) are told apart in the return picker.
  // A unit Trove cancelled before dispatch never arrived, so it can't go back.
  return db.prepare('SELECT id, name_snapshot, qty - cancelled_qty AS qty, price_cents, options, extras, personalization FROM order_items WHERE order_id=? AND qty > cancelled_qty').all(order.id)
    .map((i) => {
      const h = held.get(i.id);
      const available = Math.max(0, i.qty - (h ? h.qty : 0));
      return {
        id: i.id, name: i.name_snapshot, qty: i.qty, available, price: i.price_cents / 100,
        personalised: !!String(i.personalization || '').trim(),
        options: require('./options').parse(i.options),
        extras: require('./extras').parse(i.extras).map((e) => ({ name: e.name, price: (e.priceCents || 0) / 100 })),
        locked: available > 0 ? null : (h.statuses.includes('requested') ? 'requested' : 'approved'),
      };
    });
}

/* ---- shapes ---- */
function parseImages(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
const collectionsOf = (requestId) => db.prepare('SELECT * FROM return_collections WHERE request_id=? ORDER BY id').all(requestId);
function shape(r) {
  if (!r) return null;
  const items = requestItems(r.id);
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    reasonLabel: reasonLabel(r.reason),
    details: r.details,
    images: parseImages(r.images),
    items: items.map((i) => ({ orderItemId: i.order_item_id, name: i.name_snapshot, qty: i.qty, lineQty: i.line_qty, price: i.price_cents / 100, shop: i.shop_name, options: require('./options').parse(i.options), extras: require('./extras').parse(i.extras).map((e) => ({ name: e.name, price: (e.priceCents || 0) / 100 })) })),
    itemsTotal: grossCents(items) / 100,
    refund: r.refund_cents != null ? r.refund_cents / 100 : null,
    fee: r.fee_cents != null ? r.fee_cents / 100 : null,
    feeOverride: feeOverrideOf(r),
    // The original delivery fee refunded on top of the items (whole order
    // back for a fault) — null until approval stamps it.
    deliveryRefund: r.delivery_refund_cents != null ? r.delivery_refund_cents / 100 : null,
    deliveryOverride: deliveryOverrideOf(r),
    declineReason: r.decline_reason || null,
    createdAt: r.created_at,
    decidedAt: r.decided_at || null,
    collectionBookedAt: r.collection_booked_at || null,
    collectedAt: r.collected_at || null,
    refundedAt: r.refunded_at || null,
    refundNote: r.refund_note || null,
    creditNoteRef: r.credit_note_ref || null,
    vatReversed: (r.vat_reversed_cents || 0) / 100,
    collections: collectionsOf(r.id).map((c) => ({ status: c.status, ref: c.ref || null, note: c.note || null, bookedAt: c.booked_at || null, collectedAt: c.collected_at || null })),
  };
}

/* ---- create (buyer) ---- */
/** Normalise the picked units: body.items [{ id, qty }] (unit-level) or the
 *  older body.itemIds [id] (every unit still available on those lines). */
function pickedUnits(order, body) {
  const lines = new Map(returnableItems(order).map((i) => [i.id, i]));
  const picks = new Map();
  if (Array.isArray(body.items) && body.items.length) {
    for (const it of body.items) {
      const id = Number(it && it.id);
      const qty = it && it.qty !== undefined ? Number(it.qty) : null;
      if (!Number.isInteger(id)) continue;
      picks.set(id, (picks.get(id) || 0) + (qty === null ? NaN : qty));
    }
  } else {
    for (const id of (Array.isArray(body.itemIds) ? body.itemIds : []).map(Number).filter(Number.isInteger)) picks.set(id, null);
  }
  if (!picks.size) return { error: 'Pick at least one item to send back', status: 400 };
  const out = [];
  for (const [id, want] of picks) {
    const line = lines.get(id);
    if (!line) return { error: 'Those items are not on this order', status: 400 };
    if (line.available <= 0) return { error: 'One of those items is already part of another return request', status: 409 };
    const qty = want === null ? line.available : want;
    if (!Number.isInteger(qty) || qty < 1) return { error: 'Choose how many of each item go back', status: 400 };
    if (qty > line.available) return { error: `Only ${line.available} of ${line.name} can still be returned`, status: 409 };
    out.push({ id, qty, personalised: line.personalised });
  }
  return { units: out };
}

function create(user, order, body) {
  const blocked = ineligibleReason(order);
  if (blocked) return { error: blocked, status: 409 };

  const picked = pickedUnits(order, body);
  if (picked.error) return picked;

  const reason = String(body.reason || '');
  if (!REASONS[reason]) return { error: 'Pick a reason for the return', status: 400 };
  if (!FAULT_REASONS.has(reason) && picked.units.some((u) => u.personalised)) {
    return { error: 'Personalised pieces can only be returned if they arrive faulty or damaged, are the wrong item, or are not as described', status: 400 };
  }
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
    for (const u of picked.units) ins.run(info.lastInsertRowid, u.id, u.qty);
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

/** Units of each order item already refunded through returns. */
const refundedUnitsSql = `COALESCE((SELECT SUM(ri.qty) FROM return_request_items ri
    JOIN return_requests r2 ON r2.id = ri.request_id
    WHERE ri.order_item_id = oi.id AND r2.status = 'refunded'), 0)`;
/** Units of each order item no longer the buyer's: refunded through a
 *  return, or cancelled by Trove before dispatch (src/cancellations.js). */
const goneUnitsSql = `(${refundedUnitsSql} + oi.cancelled_qty)`;
/** True once every unit on the order is refunded (returned or cancelled). */
function fullyReturned(orderId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM order_items oi
    WHERE oi.order_id=? AND ${goneUnitsSql} < oi.qty`).get(orderId).c === 0;
}

/* ---- approve (admin): decide the fee, book the collection ---- */
/**
 * Approve one request: stamp the money it WILL refund (fee decided now, the
 * admin's override recorded) and book the courier collection. No money moves
 * here — the card refund goes out once the courier has collected the piece
 * (markCollected → refund), or when an admin uses 'refund now'. Returns the
 * fresh row after the collection bookings settle (a failed booking never
 * fails the approval; it is shown on the request and can be retried).
 */
async function approve(rr, order, { feeOverride = null, deliveryOverride = null } = {}) {
  const m = money(order, rr, { feeOverride, deliveryOverride });
  const flag = (v) => (v === true ? 1 : v === false ? 0 : null);
  db.prepare(`UPDATE return_requests SET status='approved', refund_cents=?, fee_cents=?, fee_override=?,
      delivery_refund_cents=?, delivery_override=?, decided_at=datetime('now') WHERE id=? AND status='requested'`)
    .run(m.refund, m.fee, flag(feeOverride), m.delivery, flag(deliveryOverride), rr.id);
  await bookCollections(order, rr.id);
  return db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr.id);
}

/** Book (or re-book) the reverse pickups for the shops whose units are
 *  coming back — one collection per shop parcel. Best-effort network IO. */
async function bookCollections(order, requestId) {
  const items = requestItems(requestId);
  const delivery = require('./delivery');
  const jobs = [];
  for (const shopId of [...new Set(items.map((i) => i.shop_id))]) {
    const sh = db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shopId);
    if (!sh) continue;
    // One row per (request, parcel). A booking that FAILED is re-tried on the
    // same row — a failed collection keeps the request waiting (see
    // markCollected), so a stale failed row must never linger beside a new one.
    const existing = db.prepare('SELECT * FROM return_collections WHERE request_id=? AND shipment_id=? ORDER BY id DESC LIMIT 1').get(requestId, sh.id);
    if (existing && existing.status !== 'failed') continue;
    let colId;
    if (existing) {
      colId = existing.id;
      db.prepare("UPDATE return_collections SET status='booking', note=NULL WHERE id=?").run(colId);
    } else {
      colId = db.prepare('INSERT INTO return_collections (request_id, shipment_id, shop_id) VALUES (?,?,?)').run(requestId, sh.id, shopId).lastInsertRowid;
    }
    if (!['shipped', 'out_for_delivery', 'delivered'].includes(sh.status)) {
      // Nothing to collect — not a failure, and it never holds the refund.
      db.prepare("UPDATE return_collections SET status='not_needed', note=? WHERE id=?").run('The parcel never reached the buyer — nothing to collect', colId);
      continue;
    }
    const units = items.filter((i) => i.shop_id === shopId);
    jobs.push(delivery.bookReversePickup(sh.id, units).then((r) => {
      db.prepare("UPDATE return_collections SET status='booked', ref=?, booked_at=datetime('now') WHERE id=?").run((r && r.ref) || null, colId);
      db.prepare("UPDATE return_requests SET collection_booked_at=COALESCE(collection_booked_at, datetime('now')) WHERE id=?").run(requestId);
      db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
        .run(sh.id, sh.status, `Return collection booked${r && r.ref ? ' · ' + r.ref : ''}`);
    }).catch((e) => {
      console.error('Return collection booking failed for shipment', sh.id, e.message);
      db.prepare("UPDATE return_collections SET status='failed', note=? WHERE id=?").run(String(e.message || 'Booking failed').slice(0, 300), colId);
      const wallet = /OTO1006/.test(`${e.otoCode || ''} ${e.message || ''}`);
      if (wallet) require('./courier-ops').walletEmpty();
      require('./notify').adminAlert({
        subject: `Return collection not booked: order ${order.public_id}`,
        title: 'A return collection did not book',
        kicker: `Order ${order.public_id} · return request ${requestId}`,
        lines: [
          `The courier collection for the ${units.map((u) => u.name_snapshot).join(', ')} coming back could not be booked.`,
          wallet ? 'Reason: the OTO wallet is out of credit (OTO1006) — top it up first.' : `Reason: ${String(e.message || '').slice(0, 200)}`,
          'The buyer is not refunded until it is collected. Press Book the collection again on the return in Admin → Returns.',
        ],
      });
    }));
  }
  await Promise.all(jobs);
  const transferred = [...new Set(items.map((i) => i.transfer_id).filter(Boolean))];
  if (transferred.length) {
    console.warn(`return ${requestId} (${order.public_id}): reverse these Stripe Transfers by hand:`, transferred.join(', '));
  }
}

/* ---- collected (courier) ---- */
/**
 * A courier reports a return collected. `where` names the collection by its
 * courier reference (`ref`), or by `shipmentId` (the latest booked one on
 * that parcel; `quiet` skips the timeline note when the caller wrote its
 * own). Once every collection on the request is in, the request is
 * 'collected' and the refund goes out. Resolves to the request id (or null
 * when nothing matched); refund failures are logged, never thrown — the
 * request then waits at 'collected' for an admin's 'refund now'.
 */
async function markCollected(where) {
  const col = where.ref
    ? db.prepare("SELECT * FROM return_collections WHERE ref=? ORDER BY id DESC LIMIT 1").get(String(where.ref))
    : db.prepare("SELECT * FROM return_collections WHERE shipment_id=? AND status IN ('booked','booking','collected') ORDER BY id DESC LIMIT 1").get(where.shipmentId);
  if (!col) return null;
  if (col.status !== 'collected') {
    db.prepare("UPDATE return_collections SET status='collected', collected_at=datetime('now') WHERE id=?").run(col.id);
    if (!where.quiet) db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, (SELECT status FROM shipments WHERE id=?), ?)')
      .run(col.shipment_id, col.shipment_id, 'Return collected from the buyer');
  }
  // Every OTHER parcel on the request must be collected too. A collection
  // whose booking FAILED still owes a pickup (an empty courier wallet, a
  // refusal): it holds the refund, so the request stays 'approved' and the
  // admin's 'Book the collection again' stays available. Only 'not_needed'
  // (the parcel never reached the buyer) and 'collected' let it through.
  const pending = db.prepare("SELECT COUNT(*) AS c FROM return_collections WHERE request_id=? AND status IN ('booking','booked','failed')").get(col.request_id).c;
  if (pending) return col.request_id;
  db.prepare("UPDATE return_requests SET status='collected', collected_at=COALESCE(collected_at, datetime('now')) WHERE id=? AND status='approved'")
    .run(col.request_id);
  try { await refund(col.request_id, { by: 'courier' }); }
  catch (e) { console.error(`return ${col.request_id}: refund after collection failed —`, e.message); }
  return col.request_id;
}

/* ---- refund ---- */
const refunding = new Set(); // single process — guards a double webhook + a click
/**
 * Refund one approved/collected request: card refund first (if Stripe fails,
 * nothing local changes), then in one transaction the supplier credit
 * reversal for exactly these units, the VAT reversal + credit note, and the
 * order's refunded_at once every unit is back. `by` = 'courier' | 'admin'.
 */
async function refund(requestId, { by = 'courier', note = '' } = {}) {
  const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(requestId);
  if (!rr) { const e = new Error('Return request not found'); e.status = 404; throw e; }
  if (rr.status === 'refunded') return rr;
  if (!['approved', 'collected'].includes(rr.status)) { const e = new Error('Only an approved return can be refunded'); e.status = 409; throw e; }
  if (refunding.has(rr.id)) { const e = new Error('This refund is already on its way'); e.status = 409; throw e; }
  refunding.add(rr.id);
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(rr.order_id);
    const amount = rr.refund_cents != null ? rr.refund_cents : money(order, rr).refund;

    let refundRef = null;
    const stripe = require('./stripe').getStripe();
    if (stripe && order.stripe_payment_intent_id && amount > 0) {
      const r = await stripe.refunds.create({ payment_intent: order.stripe_payment_intent_id, amount,
        metadata: { trove_kind: 'return', order_id: String(order.id), return_request_id: String(rr.id) } }, { idempotencyKey: `trove-return-${rr.id}` });
      refundRef = (r && r.id) || null;
    } else if (!stripe || !order.stripe_payment_intent_id) {
      console.warn(`return ${rr.id} (${order.public_id}): refunded without a card refund (demo mode / no PaymentIntent)`);
    }

    db.transaction(() => {
      db.prepare(`UPDATE return_requests SET status='refunded', refunded_at=datetime('now'), refund_ref=?, refund_note=?,
          collected_at=CASE WHEN ?='courier' THEN COALESCE(collected_at, datetime('now')) ELSE collected_at END
        WHERE id=?`).run(refundRef, note ? String(note).slice(0, 300) : (by === 'admin' ? 'Refunded by Trove before the courier confirmed collection' : null), by, rr.id);
      reverseCredits(order, rr.id);
      reverseVat(order, rr.id, amount);
      if (fullyReturned(order.id)) {
        db.prepare("UPDATE orders SET refunded_at=datetime('now') WHERE id=? AND refunded_at IS NULL").run(order.id);
      }
    })();

    const fresh = db.prepare('SELECT * FROM return_requests WHERE id=?').get(rr.id);
    const email = require('./email');
    if (typeof email.returnRefunded === 'function') {
      const msg = email.returnRefunded({ order, items: emailItems(rr.id), money: { gross: grossCents(requestItems(rr.id)), fee: fresh.fee_cents || 0, delivery: fresh.delivery_refund_cents || 0, refund: amount } });
      email.send({ to: order.email, ...msg }).catch((e) => console.error('return-refunded email failed:', e.message));
    }
    return fresh;
  } finally {
    refunding.delete(rr.id);
  }
}

/** Per shop: reverse split(returned gross).net of the sale credit. The credit
 *  itself was split(shop total).net, so per-unit rounding can drift by a fil —
 *  when a shop's LAST unit comes back we reverse whatever remains instead,
 *  and the books close exactly. Call inside the refund transaction, after
 *  the request is stamped refunded. */
function reverseCredits(order, requestId) {
  return reverseCreditsFor(order, requestItems(requestId));
}
/** The same for any set of units going back ([{ shop_id, price_cents, qty }])
 *  — a return request, or a cancellation before dispatch. The units must
 *  already be counted as gone (request stamped refunded / cancelled_qty
 *  bumped) so a shop's LAST unit closes its credit exactly. */
function reverseCreditsFor(order, units) {
  if (order.rail === 'connect') return;
  const perShop = new Map();
  for (const it of units) {
    perShop.set(it.shop_id, (perShop.get(it.shop_id) || 0) + it.price_cents * it.qty);
  }
  for (const [shopId, gross] of perShop) {
    const credit = db.prepare(`SELECT * FROM seller_balances
      WHERE order_id=? AND shop_id=? AND type='credit_sale'`).get(order.id, shopId);
    if (!credit) continue; // connect-tier leftovers in a mixed cart have no ledger credit
    const shopDone = db.prepare(`SELECT COUNT(*) AS c FROM order_items oi
      WHERE oi.order_id=? AND oi.shop_id=? AND ${goneUnitsSql} < oi.qty`).get(order.id, shopId).c === 0;
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

/** VAT captured on the order (5/105 of the amount charged, consignment rail)
 *  is reversed for the amount refunded, capped at what is left, and the
 *  refund gets a credit-note reference. Nothing happens when no VAT was
 *  captured (not registered yet). */
function reverseVat(order, requestId, refundCents) {
  const o = db.prepare('SELECT vat_amount_cents, vat_reversed_cents, public_id FROM orders WHERE id=?').get(order.id);
  if (!o || !(o.vat_amount_cents > 0)) return 0;
  const left = o.vat_amount_cents - (o.vat_reversed_cents || 0);
  const vat = Math.max(0, Math.min(cfg.vatFromGross(refundCents), left));
  db.prepare('UPDATE orders SET vat_reversed_cents = vat_reversed_cents + ? WHERE id=?').run(vat, order.id);
  db.prepare('UPDATE return_requests SET vat_reversed_cents=?, credit_note_ref=? WHERE id=?')
    .run(vat, `CN-${o.public_id}-R${requestId}`, requestId);
  return vat;
}

const emailItems = (requestId) => {
  const email = require('./email');
  return requestItems(requestId)
    .map((i) => ({ name: i.name_snapshot, qty: i.qty, price_cents: i.price_cents, image: email.productImage({ images: i.product_images, name: i.name_snapshot }) }));
};

/**
 * Everything a WHOLE-ORDER refund changes after the card was refunded: stamp
 * the order, reverse already-settled supplier credits, reverse whatever VAT is
 * left (credit note CN-<order>), cancel unshipped parcels, book reverse
 * pickups for parcels that went out. Used by the admin's manual refund button
 * (returns use approve() → refund() above).
 */
function applyRefundEffects(order, { refundRef = null, bookReturns = true } = {}) {
  db.transaction(() => {
    db.prepare("UPDATE orders SET refunded_at=datetime('now'), refund_ref=COALESCE(?, refund_ref) WHERE id=?").run(refundRef, order.id);
    if (order.rail !== 'connect') {
      const swept = db.prepare(`SELECT * FROM seller_balances
        WHERE order_id=? AND type='credit_sale' AND settlement_id IS NOT NULL`).all(order.id);
      for (const c of swept) {
        db.prepare(`INSERT INTO seller_balances (shop_id, order_id, type, amount_cents)
          VALUES (?,?, 'debit_refund', ?)`).run(c.shop_id, order.id, -c.amount_cents);
      }
    }
    // This refund gives back what is still paid — the total less earlier
    // item returns, cancellations and refunds made in the Stripe dashboard —
    // and its credit note carries only the VAT those earlier credit notes
    // did NOT already reverse. Crediting the order's full VAT here would
    // credit the returned pieces' VAT twice.
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    const earlier = db.prepare("SELECT COALESCE(SUM(refund_cents),0) AS s FROM return_requests WHERE order_id=? AND status='refunded'").get(order.id).s
      + db.prepare("SELECT COALESCE(SUM(refund_cents),0) AS s FROM order_cancellations WHERE order_id=? AND status='refunded'").get(order.id).s
      + (o.external_refund_cents || 0);
    const vatLeft = Math.max(0, (o.vat_amount_cents || 0) - (o.vat_reversed_cents || 0));
    db.prepare(`UPDATE orders SET whole_refund_cents=?, whole_refund_vat_cents=?, vat_reversed_cents=vat_reversed_cents + ?,
        credit_note_ref=CASE WHEN ? > 0 THEN ? ELSE credit_note_ref END WHERE id=?`)
      .run(Math.max(0, o.total_cents - earlier), vatLeft, vatLeft, vatLeft, `CN-${o.public_id}`, order.id);
  })();

  const transferred = db.prepare('SELECT DISTINCT transfer_id FROM order_items WHERE order_id=? AND transfer_id IS NOT NULL').all(order.id);
  if (transferred.length) {
    console.warn(`refund ${order.public_id}: reverse these Stripe Transfers by hand:`, transferred.map((t) => t.transfer_id).join(', '));
  }

  // Logistics, after the money is sorted. 'shipped' on a courier-booked
  // parcel only means PACKED (collection booked, driver not there yet), so:
  //   - not collected yet (processing, or shipped with no collected_at):
  //     cancelled in Trove now, the courier booking cancelled, the maker
  //     emailed not to hand it over. A courier refusal flags the parcel.
  //   - collected but not delivered (in transit): it can't be stopped from
  //     here — flagged for a person (the courier must bring it back).
  //   - delivered: a return collection is booked, as before.
  const courier = require('./courier-ops');
  const delivery = require('./delivery');
  const jobs = [];
  for (const sh of db.prepare('SELECT * FROM shipments WHERE order_id=?').all(order.id)) {
    if (sh.status === 'cancelled') continue;
    // A chargeback or a refund made in the Stripe dashboard: the books
    // follow, but nobody asked for the piece back — no collection.
    if (sh.status === 'delivered' && !bookReturns) continue;
    if (sh.status === 'delivered') {
      jobs.push(delivery.bookReversePickup(sh.id).then((r) => {
        db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
          .run(sh.id, sh.status, `Return pickup booked${r && r.ref ? ' · ' + r.ref : ''}`);
        return { shipmentId: sh.id, action: 'return_booked' };
      }).catch((e) => {
        console.error('Reverse pickup failed for shipment', sh.id, e.message);
        return { shipmentId: sh.id, action: 'return_failed', error: e.message };
      }));
    } else if (sh.status === 'out_for_delivery' || sh.collected_at) {
      db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)').run(sh.id, sh.status, 'Order refunded — the parcel is already with the courier');
      courier.raise(sh.id, 'refunded_in_transit', [
        'This order was refunded, but the courier already has this parcel, so it could not be stopped from Trove.',
        'Ask the courier (OTO dashboard) to return it to the maker, or book a return collection once it is delivered.',
      ]);
      jobs.push(Promise.resolve({ shipmentId: sh.id, action: 'in_transit' }));
    } else {
      db.prepare("UPDATE shipments SET status='cancelled', cancelled_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(sh.id);
      db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'cancelled', 'Order refunded — do not ship')").run(sh.id);
      require('./notify').parcelCancelled({ shopId: sh.shop_id, publicId: order.public_id, whole: true,
        items: db.prepare('SELECT name_snapshot AS name, qty - cancelled_qty AS qty FROM order_items WHERE order_id=? AND shop_id=? AND qty > cancelled_qty').all(order.id, sh.shop_id) });
      jobs.push(courier.stopParcel(sh.id, 'Order refunded').then((r) => ({ shipmentId: sh.id, action: r.stopped ? 'cancelled' : 'cancel_failed', error: r.error })));
    }
  }
  return Promise.all(jobs);
}

module.exports = {
  REASONS, LEGACY_REASONS, FAULT_REASONS, IN_FLIGHT, MAX_IMAGES, BUYER_RETURN_DAYS,
  reasonLabel, changeOfMindFee, feeCents, money, deliveryRefundRule, deliveryRefundCents, deliveryLeftCents, grossCents, requestItems, returnableItems, lockedItems, heldUnits,
  ineligibleReason, deadline, fullyReturned, reverseCreditsFor,
  shape, create, cancelOwn, approve, bookCollections, markCollected, refund, applyRefundEffects, emailItems,
};
