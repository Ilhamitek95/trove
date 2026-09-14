'use strict';
/**
 * DeliveryProvider facade — the only module the rest of the app talks to.
 * Picks QuiqupLive when QUIQUP_CLIENT_ID + QUIQUP_CLIENT_SECRET are set, the
 * instant mock otherwise (resolved at call time so tests can flip env).
 * Booking writes the courier reference onto the shipment; delivery
 * confirmation flows through shipments.markDelivered (see
 * routes/delivery.routes.js for the webhook).
 */
const db = require('../db');

const isLive = () => !!(process.env.QUIQUP_CLIENT_ID && process.env.QUIQUP_CLIENT_SECRET);
const provider = () => (isLive() ? require('./quiqup-live') : require('./quiqup-mock'));

const loadShipment = (id) => db.prepare(`SELECT sh.*, o.shipping_json, o.phone AS buyer_phone, o.public_id FROM shipments sh
    JOIN orders o ON o.id = sh.order_id WHERE sh.id=?`).get(id);

/** Book the buyer-bound pickup for a shipment. No-op if already booked. */
async function bookPickup(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || sh.delivery_ref) return null;
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(sh.shop_id);
  const p = provider();
  const res = await p.bookPickup(sh, shop);
  db.prepare(`UPDATE shipments SET delivery_ref=?, carrier=?,
      tracking_number = COALESCE(NULLIF(tracking_number,''), ?),
      tracking_url    = COALESCE(NULLIF(tracking_url,''), ?)
    WHERE id=?`).run(res.ref, p.name, res.ref, res.trackingUrl || '', sh.id);
  return res;
}

/** Book the return leg (buyer → supplier) after a refund. */
async function bookReversePickup(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh) return null;
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(sh.shop_id);
  return provider().bookReversePickup(sh, shop);
}

/**
 * The maker has packed the parcel: tell the courier it can be collected.
 * Idempotent — a shipment already handed over is left alone. Returns null
 * when there is nothing booked to hand over.
 */
async function markReady(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || !sh.delivery_ref || sh.ready_at) return null;
  const p = provider();
  const res = await p.markReady(sh.delivery_ref);
  db.prepare("UPDATE shipments SET ready_at=datetime('now'), tracking_url=COALESCE(NULLIF(?,''), tracking_url) WHERE id=?")
    .run((res && res.trackingUrl) || '', sh.id);
  db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
    .run(sh.id, sh.status, `Ready for collection · ${p.name} ${sh.delivery_ref}`);
  return res;
}

/** Courier label (PDF buffer) for a booked shipment, or null. */
async function getLabel(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || !sh.delivery_ref) return null;
  return provider().getLabel(sh.delivery_ref);
}

const getStatus = (ref) => provider().getStatus(ref);

module.exports = { bookPickup, bookReversePickup, markReady, getLabel, getStatus, provider, isLive };
