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

const itemsStmt = db.prepare('SELECT oi.name_snapshot, oi.qty, oi.price_cents, oi.personalization, p.image_seed FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND oi.shop_id=?');
const eventsStmt = db.prepare('SELECT status, note, created_at FROM shipment_events WHERE shipment_id=? ORDER BY id ASC');

// Shape a shipment row (optionally joined with shop name/color/is_house) for the API.
function shape(s) {
  const items = itemsStmt.all(s.order_id, s.shop_id);
  return {
    id: s.id,
    status: s.status,
    statusLabel: LABELS[s.status] || s.status,
    carrier: s.carrier || '',
    trackingNumber: s.tracking_number || '',
    trackingUrl: s.tracking_url || '',
    deliveredAt: s.delivered_at || null,
    returnWindowEndsAt: s.return_window_ends_at || null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    shop: { id: s.shop_id, name: s.shop_name, color: s.color, isHouse: !!s.is_house },
    itemTotal: items.reduce((t, i) => t + i.price_cents * i.qty, 0) / 100,
    items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty, price: i.price_cents / 100, seed: i.image_seed || '', personalization: i.personalization || '' })),
    timeline: eventsStmt.all(s.id).map((e) => ({ status: e.status, label: LABELS[e.status] || e.status, note: e.note, at: e.created_at })),
  };
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
 * delivered → fulfilled (plus order-level delivery + return-window stamps for
 * the buyer view); any un-delivered → back to paid, stamps cleared.
 */
function deriveOrderStatus(orderId) {
  const notDelivered = db.prepare("SELECT COUNT(*) AS c FROM shipments WHERE order_id=? AND status!='delivered'").get(orderId).c;
  if (!notDelivered) {
    db.prepare(`UPDATE orders SET
        status = CASE WHEN status='paid' THEN 'fulfilled' ELSE status END,
        delivered_at = COALESCE(delivered_at, (SELECT MAX(delivered_at) FROM shipments WHERE order_id=orders.id)),
        return_window_ends_at = COALESCE(return_window_ends_at, (SELECT MAX(return_window_ends_at) FROM shipments WHERE order_id=orders.id))
      WHERE id=?`).run(orderId);
  } else {
    db.prepare("UPDATE orders SET status='paid' WHERE id=? AND status='fulfilled'").run(orderId);
    db.prepare('UPDATE orders SET delivered_at=NULL, return_window_ends_at=NULL WHERE id=?').run(orderId);
  }
}

/**
 * The single funnel for delivery confirmation — the seller's "Mark delivered"
 * button and the courier webhook both land here. Idempotent: a shipment
 * already delivered is returned untouched (the 7-day return window is never
 * re-stamped or extended by a duplicate confirmation).
 */
function markDelivered(shipmentId, source = 'seller') {
  const sh = db.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
  if (!sh) return null;
  if (sh.status === 'delivered') return sh;
  db.transaction(() => {
    db.prepare(`UPDATE shipments SET status='delivered', delivered_at=datetime('now'),
        return_window_ends_at=datetime('now', '+' || ? || ' days'), updated_at=datetime('now') WHERE id=?`)
      .run(require('./config').RETURN_WINDOW_DAYS, shipmentId);
    db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
      .run(shipmentId, 'delivered', source === 'courier' ? 'Delivered (confirmed by courier)' : 'Delivered');
    deriveOrderStatus(sh.order_id);
  })();
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

module.exports = { FLOW, LABELS, shape, noteFor, deriveOrderStatus, markDelivered, assertUndoable };
