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
// What actually travels: units Trove cancelled before dispatch are left out
// (src/cancellations.js), and a line with nothing left goes altogether.
const loadItems = (sh) => db.prepare('SELECT * FROM order_items WHERE order_id=? AND shop_id=? ORDER BY id').all(sh.order_id, sh.shop_id)
  .map((i) => ({ ...i, qty: i.qty - (i.cancelled_qty || 0) }))
  .filter((i) => i.qty > 0);

/** Book the buyer-bound pickup for a shipment. No-op if already booked.
 *  Refused (code 'missing_address') while the order has no delivery name +
 *  line or no buyer mobile — a courier order nobody can deliver (F213);
 *  courier-ops flags the parcel and books it once the details are added. */
async function bookPickup(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || sh.delivery_ref) return null;
  if (require('../paid-effects').deliveryDetailsMissing({ shipping_json: sh.shipping_json, phone: sh.buyer_phone })) {
    throw Object.assign(new Error('The order has no delivery address or mobile number yet'), { code: 'missing_address' });
  }
  const shop = loadShop(sh.shop_id);
  const p = provider();
  const res = await p.bookPickup(sh, shop, loadItems(sh));
  db.prepare(`UPDATE shipments SET delivery_ref=?, carrier=?, delivery_provider=?,
      tracking_number = COALESCE(NULLIF(tracking_number,''), ?),
      tracking_url    = COALESCE(NULLIF(tracking_url,''), ?)
    WHERE id=?`).run(res.ref, p.name, mode(), res.ref, res.trackingUrl || '', sh.id);
  return res;
}

/** Book the return leg (buyer → supplier) after a refund. `returnItems`
 *  ([{ order_item_id, qty }]) narrows it to the pieces coming back; omitted =
 *  the whole parcel. */
async function bookReversePickup(shipmentId, returnItems) {
  const sh = loadShipment(shipmentId);
  if (!sh) return null;
  const shop = loadShop(sh.shop_id);
  return adapterFor(sh).bookReversePickup(sh, shop, loadItems(sh), returnItems);
}

/* A parcel's later calls go to the courier that BOOKED it (F239), never
 * just the one configured now: an OTO order id means nothing to Quiqup or
 * the mock. When that courier is no longer connected the call fails loudly
 * (the caller records it and the admin is told) instead of, say, the mock
 * answering 'ready' for a real OTO parcel. */
const ADAPTERS = { oto: './oto-live', quiqup: './quiqup-live', mock: './quiqup-mock' };
const CONNECTED = { oto: isOto, quiqup: isQuiqup, mock: () => !isLive() };
const LABEL = { oto: 'OTO', quiqup: 'Quiqup', mock: 'the test courier' };
function adapterFor(sh) {
  const which = providerOf(sh);
  if (!which || !ADAPTERS[which]) return provider();
  if (!CONNECTED[which]()) throw new Error(`This parcel was booked with ${LABEL[which]}, which is not connected on the server right now — reconnect it, or cancel this courier order and book again`);
  return require(ADAPTERS[which]);
}

/**
 * The maker has packed the parcel: tell the courier it can be collected.
 * Idempotent — a shipment already handed over is left alone. Returns null
 * when there is nothing booked to hand over.
 */
async function markReady(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || !sh.delivery_ref || sh.ready_at) return null;
  const p = adapterFor(sh);
  const res = await p.markReady(sh.delivery_ref, sh, loadShop(sh.shop_id));
  // OTO picks the actual courier here (Aramex, iMile…) — show its name from now on.
  db.prepare("UPDATE shipments SET ready_at=datetime('now'), tracking_url=COALESCE(NULLIF(?,''), tracking_url), carrier=COALESCE(NULLIF(?,''), carrier) WHERE id=?")
    .run((res && res.trackingUrl) || '', (res && res.carrier) || '', sh.id);
  db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
    .run(sh.id, sh.status, `Ready for collection · ${(res && res.carrier) || p.name} ${sh.delivery_ref}`);
  return res;
}

/**
 * Cancel the courier booking of a parcel Trove refunded or cancelled before
 * the courier collected it. Resolves { cancelled: false } when nothing was
 * booked; throws when the courier refuses (or the integration cannot cancel)
 * — the caller flags the parcel for a person.
 */
async function cancelPickup(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || !sh.delivery_ref) return { cancelled: false };
  const p = adapterFor(sh);
  if (typeof p.cancelPickup !== 'function') throw new Error(`${p.name} bookings can't be cancelled automatically`);
  return p.cancelPickup(sh.delivery_ref, sh);
}

/**
 * Which integration booked a shipment: the stored column, or — for rows
 * booked before it existed — read from the reference itself (OTO orderIds
 * are '<public id>-<shipment id>', the mock's start QMOCK-, anything else is
 * a Quiqup order id).
 */
function providerOf(sh) {
  if (!sh || !sh.delivery_ref) return '';
  if (sh.delivery_provider) return sh.delivery_provider;
  if (/^QMOCK-/.test(sh.delivery_ref)) return 'mock';
  if (/^TRV-/.test(sh.delivery_ref)) return 'oto';
  return 'quiqup';
}

/** Courier label for a booked shipment: a PDF buffer, { url } of a hosted label, or null. */
async function getLabel(shipmentId) {
  const sh = loadShipment(shipmentId);
  if (!sh || !sh.delivery_ref) return null;
  let p;
  try { p = adapterFor(sh); } catch (e) { console.error(`label for shipment ${sh.id}:`, e.message); return null; }
  return p.getLabel(sh.delivery_ref);
}

const getStatus = (ref) => provider().getStatus(ref);

module.exports = { bookPickup, bookReversePickup, markReady, cancelPickup, getLabel, getStatus, provider, providerOf, adapterFor, isLive, isOto, mode };
