'use strict';
/**
 * DeliveryProvider facade — the only module the rest of the app talks to.
 * Picks QuiqupLive when QUIQUP_API_KEY is set, the instant mock otherwise
 * (resolved at call time so tests can flip env). Booking writes the job
 * reference onto the shipment; delivery confirmation flows through
 * shipments.markDelivered (see routes/delivery.routes.js for the webhook).
 */
const db = require('../db');

const provider = () => (process.env.QUIQUP_API_KEY ? require('./quiqup-live') : require('./quiqup-mock'));

/** Book the buyer-bound pickup for a shipment. No-op if already booked. */
async function bookPickup(shipmentId) {
  const sh = db.prepare(`SELECT sh.*, o.shipping_json, o.public_id FROM shipments sh
    JOIN orders o ON o.id = sh.order_id WHERE sh.id=?`).get(shipmentId);
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
  const sh = db.prepare(`SELECT sh.*, o.shipping_json, o.public_id FROM shipments sh
    JOIN orders o ON o.id = sh.order_id WHERE sh.id=?`).get(shipmentId);
  if (!sh) return null;
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(sh.shop_id);
  return provider().bookReversePickup(sh, shop);
}

const getStatus = (ref) => provider().getStatus(ref);

module.exports = { bookPickup, bookReversePickup, getStatus, provider };
