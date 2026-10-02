'use strict';
/**
 * Shipment helpers — tracking lives at the shipment level (one shop's items
 * within an order), because a Trove order can span several shops that each
 * fulfil and track separately. Shared by the seller and buyer routes so both
 * sides see the same shape and the same status labels.
 */
const db = require('./db');

// The forward lifecycle a seller advances a shipment through.
const FLOW = ['processing', 'shipped', 'out_for_delivery', 'delivered'];
const LABELS = {
  processing: 'Processing',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const itemsStmt = db.prepare('SELECT oi.name_snapshot, oi.qty, oi.cancelled_qty, oi.price_cents, oi.personalization, oi.options, oi.extras, p.image_seed, p.images FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND oi.shop_id=?');
const firstImage = (text) => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) && v[0] ? v[0] : null; } catch (_) { return null; } };
const eventsStmt = db.prepare('SELECT status, note, created_at FROM shipment_events WHERE shipment_id=? ORDER BY id ASC');

/** Not packed and its pack-by day has gone. */
function packOverdue(s) {
  if (!s.pack_by_at || s.status !== 'processing' || s.ready_at || s.packed_at) return false;
  return require('./lead-times').fromSql(s.pack_by_at).getTime() < Date.now();
}
/** { from, to } ISO instants for the buyer: pack-by day + the courier window. */
function arrivalWindow(packBySql) {
  const fees = require('./fees');
  const t = require('./lead-times').fromSql(packBySql).getTime();
  const day = 86400000;
  return { from: new Date(t + fees.COURIER_TRANSIT_MIN_DAYS * day).toISOString(), to: new Date(t + fees.COURIER_TRANSIT_MAX_DAYS * day).toISOString() };
}

/** The label both sides see. A courier-booked parcel the courier has not
 *  collected yet is 'Packed', never 'Shipped' (it is still at the maker's). */
function statusLabel(s) {
  if (s.status === 'shipped' && s.delivery_ref && !s.collected_at) return 'Packed';
  if (s.status === 'processing' && s.packed_at) return 'Packed';
  return LABELS[s.status] || s.status;
}

// Shape a shipment row (optionally joined with shop name/color/is_house) for the API.
function shape(s) {
  const items = itemsStmt.all(s.order_id, s.shop_id);
  return {
    id: s.id,
    status: s.status,
    statusLabel: statusLabel(s),
    carrier: s.carrier || '',
    trackingNumber: s.tracking_number || '',
    trackingUrl: s.tracking_url || '',
    // Courier booking: the reference the maker sees on the label + whether the
    // parcel has been handed over (ready_at) — drives the dashboard's
    // "Ready for collection" step and the label button.
    deliveryRef: s.delivery_ref || '',
    readyAt: s.ready_at || null,
    // Packed (the maker tapped it) vs collected (the courier reported having
    // it) — 'shipped' on a courier-booked parcel means packed and waiting for
    // the driver until collectedAt is set. courierPending = the maker packed
    // but the collection booking has not gone through yet (Trove retries).
    packedAt: s.packed_at || null,
    collectedAt: s.collected_at || null,
    cancelledAt: s.cancelled_at || null,
    courierPending: !!(s.packed_at && s.status === 'processing' && !s.ready_at),
    // Trove books the courier for this parcel (booked already, or a live
    // courier is connected): the maker only marks it packed.
    courierManaged: !!s.delivery_ref || require('./delivery').isLive(),
    deliveredAt: s.delivered_at || null,
    returnWindowEndsAt: s.return_window_ends_at || null,
    // Make/pack time: the day this shop should have the parcel packed by
    // (end of that Dubai day), whether that day has gone without it being
    // packed, and the buyer's arrival window (pack-by + the courier's 1–4
    // days). See src/lead-times.js.
    packBy: s.pack_by_at || null,
    packOverdue: packOverdue(s),
    expected: s.pack_by_at ? arrivalWindow(s.pack_by_at) : null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    shop: { id: s.shop_id, name: s.shop_name, color: s.color, isHouse: !!s.is_house },
    // What is in the parcel: units Trove cancelled before dispatch are out
    // (qty is what travels, cancelledQty what was taken off the order).
    itemTotal: items.reduce((t, i) => t + i.price_cents * (i.qty - (i.cancelled_qty || 0)), 0) / 100,
    // `options` is what the buyer chose (Colour: Clay) — the maker needs it to
    // pack the right piece, so it travels with the shipment on both sides.
    items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty - (i.cancelled_qty || 0), cancelledQty: i.cancelled_qty || 0, price: i.price_cents / 100, seed: i.image_seed || '', image: firstImage(i.images), personalization: i.personalization || '', options: require('./options').parse(i.options), extras: require('./extras').parse(i.extras).map((e) => ({ name: e.name, price: (e.priceCents || 0) / 100 })) })),
    timeline: eventsStmt.all(s.id).map((e) => ({ status: e.status, label: LABELS[e.status] || e.status, note: e.note, at: e.created_at })),
  };
}

/* ---- the buyer's view of a parcel (2026-10-02) ----
 * The timeline is one log shared by Trove, makers and buyers: courier errors,
 * booking references and staff notes are written there for the people who act
 * on them. The buyer sees a fixed, friendly line per step instead, never the
 * raw note; the courier gateway (OTO) and its internal booking reference are
 * not a carrier or a tracking number the buyer can use. */
const BUYER_NOTES = {
  processing: 'Order received — preparing your items',
  packed: 'Packed — waiting for the courier to collect it',
  shipped: 'Handed to the courier',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'This parcel was cancelled',
  return: 'Return collection booked',
  refunded: 'Order refunded',
};
// Notes that are already written for the buyer and say more than the step.
const BUYER_SAFE = new Set([
  'Delivery attempt failed — the courier will try again',
  'Delivery on hold with the courier',
]);
const GATEWAYS = /^(oto|mock)$/i;
const buyerCarrier = (s) => (s.carrier && !GATEWAYS.test(String(s.carrier).trim()) ? String(s.carrier).trim() : '');
function buyerNote(e, s) {
  const n = String(e.note || '');
  if (/^Return (collection|pickup) booked/i.test(n)) return BUYER_NOTES.return;
  if (/^Order refunded/i.test(n)) return BUYER_NOTES.refunded;
  if (BUYER_SAFE.has(n)) return n;
  if (e.status === 'shipped') {
    if (/^(Ready for collection|Packed|Courier booked|Courier assigned|Driver|Courier could not collect)/i.test(n)) return BUYER_NOTES.packed;
    const c = buyerCarrier(s);
    return BUYER_NOTES.shipped + (c ? ` (${c})` : '');
  }
  return BUYER_NOTES[e.status] || '';
}
function shapeForBuyer(s) {
  const x = shape(s);
  const internalRef = !!s.delivery_ref && String(s.tracking_number || '') === String(s.delivery_ref);
  x.carrier = buyerCarrier(s);
  x.trackingNumber = internalRef ? '' : x.trackingNumber;
  delete x.deliveryRef;
  const out = [];
  for (const e of x.timeline) {
    const note = buyerNote({ status: e.status, note: e.note }, s);
    if (!note || (out.length && out[out.length - 1].note === note)) continue;
    out.push({ ...e, note });
  }
  x.timeline = out;
  return x;
}

// The default human note attached to a status change.
function noteFor(status, carrier, tracking) {
  switch (status) {
    case 'processing': return 'Order received — preparing your items';
    case 'shipped': return 'Handed to the courier' + (carrier ? ' (' + carrier + ')' : '') + (tracking ? ' · ' + tracking : '');
    case 'out_for_delivery': return 'Out for delivery';
    case 'delivered': return 'Delivered';
    case 'cancelled': return 'Shipment cancelled';
    default: return '';
  }
}

/**
 * Re-derive the parent order's state from its shipments, both ways: all
 * delivered → fulfilled (plus order-level delivery + the buyer's return
 * deadline: last delivery + the order's return days); any un-delivered →
 * back to paid, stamps cleared.
 */
function deriveOrderStatus(orderId) {
  // A parcel Trove cancelled (every piece in it cancelled before dispatch)
  // will never arrive, so it doesn't hold the order — the other makers'
  // parcels complete it. An order whose parcels are ALL cancelled is never
  // 'fulfilled' (nothing was delivered).
  const c = db.prepare(`SELECT SUM(status NOT IN ('delivered','cancelled')) AS open, SUM(status='delivered') AS done
    FROM shipments WHERE order_id=?`).get(orderId);
  if (!c.open && c.done) {
    db.prepare(`UPDATE orders SET
        status = CASE WHEN status='paid' THEN 'fulfilled' ELSE status END,
        delivered_at = COALESCE(delivered_at, (SELECT MAX(delivered_at) FROM shipments WHERE order_id=orders.id)),
        return_window_ends_at = COALESCE(return_window_ends_at, datetime((SELECT MAX(delivered_at) FROM shipments WHERE order_id=orders.id),
          '+' || COALESCE(return_days, ?) || ' days'))
      WHERE id=?`).run(require('./fees').RETURN_WINDOW_DAYS, orderId);
  } else {
    db.prepare("UPDATE orders SET status='paid' WHERE id=? AND status='fulfilled'").run(orderId);
    db.prepare('UPDATE orders SET delivered_at=NULL, return_window_ends_at=NULL WHERE id=?').run(orderId);
  }
}

/**
 * The single funnel for delivery confirmation — the seller's "Mark delivered"
 * button and the courier webhook both land here. Idempotent: a shipment
 * already delivered is returned untouched (the 15-day return window is never
 * re-stamped or extended by a duplicate confirmation).
 */
function markDelivered(shipmentId, source = 'seller') {
  const sh = db.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
  if (!sh) return null;
  if (sh.status === 'delivered') return sh;
  // Trove cancelled this parcel (refund / cancellation before dispatch): a
  // late courier 'delivered' must not revive it — no return window, no
  // 'fulfilled' order. The timeline records it and a person is told.
  if (sh.status === 'cancelled') {
    db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'cancelled', ?)")
      .run(shipmentId, source === 'courier' ? 'The courier reports delivering this cancelled parcel — we are looking into it' : 'Delivery reported on a cancelled parcel — ignored');
    require('./courier-ops').raise(shipmentId, 'delivered_after_cancel', [
      'This parcel was cancelled and refunded, but a delivery was reported on it.',
      'The buyer may have the piece without paying for it: arrange a return collection or contact the buyer.',
    ]);
    return sh;
  }
  db.transaction(() => {
    db.prepare(`UPDATE shipments SET status='delivered', delivered_at=datetime('now'), collected_at=COALESCE(collected_at, datetime('now')),
        return_window_ends_at=datetime('now', '+' || ? || ' days'), updated_at=datetime('now') WHERE id=?`)
      .run(require('./config').RETURN_WINDOW_DAYS, shipmentId);
    db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
      .run(shipmentId, 'delivered', source === 'courier' ? 'Delivered (confirmed by courier)' : 'Delivered');
    deriveOrderStatus(sh.order_id);
  })();
  // The buyer hears it arrived and until when it can go back (best-effort).
  require('./notify').parcelDelivered(shipmentId);
  return db.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
}

/**
 * Guard for stepping a shipment back from 'delivered': once its supplier
 * credit has been swept into a settlement run the clock cannot be rewound.
 * Throws 409; callers that pass the guard must also clear the delivery stamps.
 */
function assertUndoable(sh) {
  const swept = db.prepare(`SELECT 1 FROM seller_balances
    WHERE order_id=? AND shop_id=? AND type='credit_sale' AND settlement_id IS NOT NULL`).get(sh.order_id, sh.shop_id);
  if (swept) {
    const e = new Error('This parcel is already part of a settlement run — its delivery can no longer be undone.');
    e.status = 409;
    throw e;
  }
}

module.exports = { FLOW, LABELS, shape, shapeForBuyer, BUYER_NOTES, statusLabel, packOverdue, arrivalWindow, noteFor, deriveOrderStatus, markDelivered, assertUndoable };
