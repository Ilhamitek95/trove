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

const itemsStmt = db.prepare('SELECT oi.name_snapshot, oi.qty, oi.price_cents, p.image_seed FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND oi.shop_id=?');
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
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    shop: { id: s.shop_id, name: s.shop_name, color: s.color, isHouse: !!s.is_house },
    itemTotal: items.reduce((t, i) => t + i.price_cents * i.qty, 0) / 100,
    items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty, price: i.price_cents / 100, seed: i.image_seed || '' })),
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

module.exports = { FLOW, LABELS, shape, noteFor };
