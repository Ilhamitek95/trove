'use strict';
/**
 * DeliveryProvider facade — the only module the rest of the app talks to.
 * Picks, at call time (so tests can flip env):
 *   OTO     when OTO_REFRESH_TOKEN is set — many couriers, a pickup from every
 *           maker's own address (oto-live.js)
 *   Quiqup  when QUIQUP_CLIENT_ID + QUIQUP_CLIENT_SECRET are set (quiqup-live.js)
 *   mock    otherwise — books instantly, delivery confirmed by hand
 * Booking writes the courier reference onto the shipment; delivery
 * confirmation flows through shipments.markDelivered (see
 * routes/delivery.routes.js for the webhooks).
 */
const db = require('../db');

const isOto = () => !!process.env.OTO_REFRESH_TOKEN;
const isQuiqup = () => !!(process.env.QUIQUP_CLIENT_ID && process.env.QUIQUP_CLIENT_SECRET);
const isLive = () => isOto() || isQuiqup();
const provider = () => (isOto() ? require('./oto-live') : isQuiqup() ? require('./quiqup-live') : require('./quiqup-mock'));
/** 'oto' | 'quiqup' | 'mock' — surfaced on /api/health, never a secret. */
const mode = () => (isOto() ? 'oto' : isQuiqup() ? 'quiqup' : 'mock');

const loadShipment = (id) => db.prepare(`SELECT sh.*, o.shipping_json, o.phone AS buyer_phone, o.public_id FROM shipments sh
    JOIN orders o ON o.id = sh.order_id WHERE sh.id=?`).get(id);
// The owner's name + email go to the courier as the pickup contact (courier-only, like pickup_phone).
const loadShop = (id) => db.prepare(`SELECT s.*, u.name AS owner_name, u.email AS owner_email FROM shops s
    LEFT JOIN users u ON u.id = s.user_id WHERE s.id=?`).get(id);
const loadItems = (sh) => db.prepare('SELECT * FROM order_items WHERE order_id=? AND shop_id=? ORDER BY id').all(sh.order_id, sh.shop_id);

/** Book the buyer-bound pickup for a shipment. No-op if already booked. */
async function bookPickup(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || sh.delivery_ref) return null;
  const shop = loadShop(sh.shop_id);
  const p = provider();
  const res = await p.bookPickup(sh, shop, loadItems(sh));
  db.prepare(`UPDATE shipments SET delivery_ref=?, carrier=?,
      tracking_number = COALESCE(NULLIF(tracking_number,''), ?),
      tracking_url    = COALESCE(NULLIF(tracking_url,''), ?)
    WHERE id=?`).run(res.ref, p.name, res.ref, res.trackingUrl || '', sh.id);
  return res;
}

/** Book the return leg (buyer → supplier) after a refund. `returnItems`
 *  ([{ order_item_id, qty }]) narrows it to the pieces coming back; omitted =
 *  the whole parcel. */
async function bookReversePickup(shipmentId, returnItems) {
  const sh = loadShipment(shipmentId);
  if (!sh) return null;
  const shop = loadShop(sh.shop_id);
  return provider().bookReversePickup(sh, shop, loadItems(sh), returnItems);
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
  const res = await p.markReady(sh.delivery_ref, sh, loadShop(sh.shop_id));
  // OTO picks the actual courier here (Aramex, iMile…) — show its name from now on.
  db.prepare("UPDATE shipments SET ready_at=datetime('now'), tracking_url=COALESCE(NULLIF(?,''), tracking_url), carrier=COALESCE(NULLIF(?,''), carrier) WHERE id=?")
    .run((res && res.trackingUrl) || '', (res && res.carrier) || '', sh.id);
  db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
    .run(sh.id, sh.status, `Ready for collection · ${(res && res.carrier) || p.name} ${sh.delivery_ref}`);
  return res;
}

/** Courier label for a booked shipment: a PDF buffer, { url } of a hosted label, or null. */
async function getLabel(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || !sh.delivery_ref) return null;
  return provider().getLabel(sh.delivery_ref);
}

const getStatus = (ref) => provider().getStatus(ref);

module.exports = { bookPickup, bookReversePickup, markReady, getLabel, getStatus, provider, isLive, isOto, mode };
