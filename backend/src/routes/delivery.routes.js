'use strict';
/**
 * Delivery-side endpoints:
 *   POST /api/delivery/webhook       courier callbacks. Quiqup posts
 *                                    { action, type:'order', payload:{ id, state, tracking_url … } }
 *                                    signed with X-Signature: sha1=HMAC(rawBody, QUIQUP_WEBHOOK_SECRET).
 *                                    The older flat shape { ref, event } with an
 *                                    x-webhook-secret header is still accepted
 *                                    (mock provider / manual tests).
 *   POST /api/delivery/oto-webhook   OTO callbacks (?t=status | ?t=error), registered by
 *                                    oto-live.ensureWebhooks at boot. Body carries
 *                                    { orderId, status, timestamp, signature … } where
 *                                    signature = base64 HMAC-SHA256("orderId:status:timestamp",
 *                                    OTO_WEBHOOK_SECRET); the same secret also rides as the
 *                                    authorization key.
 *   POST /api/delivery/mock/deliver  dev/admin hand-crank for the mock
 *                                    provider: confirms delivery of a shipment
 *                                    as if the courier had.
 */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const shipments = require('../shipments');

const router = express.Router();

/** Move a shipment forward from a courier event — never backwards out of delivered. */
function stepShipment(sh, status, note) {
  if (sh.status === status || sh.status === 'delivered') return;
  db.prepare("UPDATE shipments SET status=?, updated_at=datetime('now') WHERE id=?").run(status, sh.id);
  db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
    .run(sh.id, status, note || shipments.noteFor(status, sh.carrier, sh.tracking_number));
  shipments.deriveOrderStatus(sh.order_id);
  sh.status = status;
}
const timeline = (sh, note) => db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)').run(sh.id, sh.status, note);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* Quiqup order states → Trove shipment states (api-docs.quiqup.com, "Order
 * states"). Anything not listed only lands on the timeline. */
const IN_TRANSIT = new Set(['ready_for_collection', 'out_for_collection', 'collected', 'received_at_depot', 'at_depot', 'scheduled', 'transit']);
const NOTES = {
  collection_failed: 'Courier could not collect the parcel — Quiqup will retry',
  delivery_failed: 'Delivery attempt failed — Quiqup will reschedule with the buyer',
  on_hold: 'Delivery on hold with Quiqup',
  return_to_origin: 'Parcel is being returned to the shop',
  out_for_return: 'Parcel is on its way back to the shop',
  returned_to_origin: 'Parcel returned to the shop',
  cancelled: 'Delivery cancelled by the courier',
};

/* Quiqup signs deliveries with an HMAC over the raw body. The classic docs
 * describe `X-Signature: sha1=…`; Quiqdash V3 subscriptions (business-ae →
 * Integrations → Webhooks) send a bare hex HMAC-SHA256 in
 * `X-Quiqup-Signature` alongside `X-Quiqup-Timestamp`, so the timestamp is
 * tried as a prefix in the usual joins (ts.body, ts:body, ts+body,
 * ts
body) as well as body-only. hex or base64, with or without an
 * `algo=` prefix. */
const SIG_HEADERS = ['x-quiqup-signature', 'x-signature', 'x-webhook-signature', 'x-hub-signature-256', 'x-hub-signature'];
function verified(req) {
  const secret = process.env.QUIQUP_WEBHOOK_SECRET;
  if (!secret) return true; // unset = open (local / staging before the secret is configured)
  if (req.headers['x-webhook-secret'] === secret) return true; // shared-secret header (custom header on the subscription)
  const header = SIG_HEADERS.map((h) => req.headers[h]).find(Boolean);
  if (!header) return false;
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const ts = String(req.headers['x-quiqup-timestamp'] || req.headers['x-timestamp'] || '');
  const messages = [raw];
  if (ts) for (const join of ['.', ':', '', '\n']) messages.push(Buffer.concat([Buffer.from(ts + join), raw]));
  // "sha256=abc…", "sha1=abc…", "t=…,v1=abc…" or the bare digest.
  const given = String(header).split(',').map((part) => part.trim().replace(/^(sha256|sha1|v1|s)=/i, '')).filter(Boolean);
  const candidates = [];
  for (const msg of messages) for (const algo of ['sha256', 'sha1']) {
    const hex = crypto.createHmac(algo, secret).update(msg).digest('hex');
    candidates.push(hex, Buffer.from(hex, 'hex').toString('base64'));
  }
  return given.some((g) => candidates.some((c) => g.length === c.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(c))));
}

router.post('/webhook', (req, res) => {
  if (!verified(req)) return res.status(401).json({ error: 'Bad webhook signature' });
  // Quiqup retries on non-2xx and stamps every delivery with an idempotency
  // key — a repeat is acknowledged without being applied twice.
  const idem = String(req.headers['x-quiqup-idempotency-key'] || '');
  if (idem) {
    const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?,?)').run('quiqup:' + idem, 'quiqup.order');
    if (!seen.changes) return res.json({ received: true, duplicate: true });
  }
  const b = req.body || {};
  // Classic shape: { type:'order', payload:{ id, state } }. Quiqdash V3 names
  // events "order.collected" and may nest the order under data/order/payload.
  const p = (b.payload && typeof b.payload === 'object') ? b.payload
    : (b.data && typeof b.data === 'object') ? (b.data.order || b.data)
    : (b.order && typeof b.order === 'object') ? b.order : b;
  const ref = String(p.id || p.order_id || b.order_id || p.ref || p.reference || p.job_id || '');
  const named = String(b.event || b.event_type || b.type || '').toLowerCase().replace(/^order[._]/, '');
  const event = String(p.state || p.status || (named !== 'order' ? named : '') || p.event || '').toLowerCase().replace(/^order[._]/, '');
  if (!ref) return res.status(400).json({ error: 'Missing job reference' });

  const sh = db.prepare('SELECT * FROM shipments WHERE delivery_ref=?').get(ref);
  if (!sh) return res.json({ received: true, matched: false });

  if (p.tracking_url && !sh.tracking_url) db.prepare('UPDATE shipments SET tracking_url=? WHERE id=?').run(p.tracking_url, sh.id);

  const step = (status, note) => stepShipment(sh, status, note);

  if (['delivered', 'delivery_complete', 'complete', 'completed'].includes(event)) {
    shipments.markDelivered(sh.id, 'courier');
  } else if (event === 'out_for_delivery') {
    step('out_for_delivery', 'Out for delivery with Quiqup');
  } else if (IN_TRANSIT.has(event) || ['in_transit', 'picked_up', 'started'].includes(event)) {
    if (sh.status === 'processing') step('shipped', event === 'ready_for_collection' ? 'Ready for collection · Quiqup' : 'Collected by Quiqup');
  } else if (NOTES[event]) {
    db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)').run(sh.id, sh.status, NOTES[event]);
  }
  res.json({ received: true, matched: true });
});

/* ---------------- OTO (tryoto.com) ---------------- */
// OTO status names (docs "List Of Statuses") → Trove shipment steps.
const OTO_COLLECTED = new Set(['pickedUp', 'inTransit', 'arrivedOriginTerminal', 'arrivedTerminal', 'departedTerminal',
  'arrivedDestinationTerminal', 'arrivedDestination', 'shipmentInProgress', 'heldForPickup']);
const OTO_NOTES = {
  searchingDriver: 'Courier booked — waiting for a driver to be assigned',
  shipmentCreated: 'Courier assigned for the collection',
  goingToPickup: 'Driver on the way to collect the parcel',
  arrivedPickup: 'Driver has arrived to collect the parcel',
  pickupAttemted: 'Courier could not collect the parcel — they will try again',
  undeliveredAttempt: 'Delivery attempt failed — the courier will try again',
  shipmentOnHold: 'Delivery on hold with the courier',
  returnProcessing: 'Delivery failed — the parcel is on its way back to the shop',
  returned: 'Parcel returned to the shop',
  shipmentCanceled: 'Courier booking cancelled',
  lostOrDamaged: 'The courier reports the parcel lost or damaged — Trove will follow up',
  destroyed: 'The courier reports the parcel damaged beyond delivery — Trove will follow up',
};
const OTO_RETURN_NOTES = {
  newReturn: 'Return collection booked', returnShipmentProcessing: 'Return collection booked',
  reverseShipmentCreated: 'Return courier assigned', reverseGoingToPickup: 'Return courier on the way to the buyer',
  reversePickupAttempted: 'Return collection attempt failed — the courier will try again',
  reversePickedUp: 'Return collected from the buyer', reverseOutForDelivery: 'Return on its way to the shop',
  reverseUndeliveredAttempt: 'Return delivery to the shop failed — the courier will try again',
  reverseReturned: 'Return delivered back to the shop', reverseConfirmReturn: 'Return received by the shop',
  confirmedReturn: 'Return received by the shop', reverseShipmentCanceled: 'Return collection cancelled',
};

function otoVerified(req) {
  const secret = process.env.OTO_WEBHOOK_SECRET;
  if (!secret) return true; // unset = open (local / before the webhook is registered)
  const auth = String(req.headers.authorization || req.headers['x-authorization'] || '').replace(/^Bearer\s+/i, '');
  if (auth && safeEq(auth, secret)) return true;
  const b = req.body || {};
  const sig = String(b.signature || '');
  if (!sig) return false;
  const ts = String(b.timestamp ?? '');
  const statuses = [b.status, b.errorCode, b.transactionStatus, ''].filter((v) => v !== undefined && v !== null);
  return statuses.some((st) => safeEq(sig, crypto.createHmac('sha256', secret).update(`${b.orderId}:${st}:${ts}`).digest('base64')));
}

router.post('/oto-webhook', (req, res) => {
  if (!otoVerified(req)) return res.status(401).json({ error: 'Bad webhook signature' });
  const b = req.body || {};
  const kind = req.query.t === 'error' ? 'error' : 'status';
  const ref = String(b.orderId || '');
  if (!ref) return res.status(400).json({ error: 'Missing orderId' });
  // OTO may redeliver: the same event is acknowledged every time, applied once.
  const key = ['oto', kind, ref, b.returnOrderId || '', b.status || b.errorCode || '', b.returnStatus || '', b.timestamp || ''].join(':');
  if (!db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?,?)').run(key, 'oto.' + kind).changes) {
    return res.json({ received: true, duplicate: true });
  }
  const sh = db.prepare('SELECT * FROM shipments WHERE delivery_ref=?').get(ref);
  if (!sh) return res.json({ received: true, matched: false });

  if (kind === 'error') {
    // The courier refused the booking: log it, and clear the hand-over so
    // marking the parcel packed again retries the booking.
    console.error(`OTO shipment error for ${ref}:`, b.errorMessage || '', b.deliveryCompanyResponse || '');
    db.prepare('UPDATE shipments SET ready_at=NULL WHERE id=?').run(sh.id);
    timeline(sh, `Courier booking failed${b.deliveryCompany ? ' (' + b.deliveryCompany + ')' : ''} — Trove has been alerted`);
    return res.json({ received: true, matched: true });
  }

  // Courier details as they become known: its name, its tracking number, OTO's branded tracking page.
  const carrier = require('../delivery/oto-live').carrierName(b.deliveryCompany);
  const trackNo = String(b.dcTrackingNumber || b.trackingNumber || '');
  const trackUrl = String(b.brandedTrackingURL || b.trackingUrl || '');
  db.prepare(`UPDATE shipments SET
      carrier = CASE WHEN ? <> '' AND (carrier = 'OTO' OR carrier = '') THEN ? ELSE carrier END,
      tracking_number = CASE WHEN ? <> '' AND (tracking_number = '' OR tracking_number = delivery_ref) THEN ? ELSE tracking_number END,
      tracking_url = CASE WHEN ? <> '' AND tracking_url = '' THEN ? ELSE tracking_url END
    WHERE id=?`).run(carrier, carrier, trackNo, trackNo, trackUrl, trackUrl, sh.id);
  Object.assign(sh, db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id));

  const status = String(b.status || '');
  const returnStatus = String(b.returnStatus || (/^(reverse|newReturn|returnShipment|confirmedReturn)/.test(status) ? status : ''));
  if (returnStatus) {
    if (OTO_RETURN_NOTES[returnStatus]) timeline(sh, OTO_RETURN_NOTES[returnStatus] + (b.returnOrderId ? ' · ' + b.returnOrderId : ''));
    return res.json({ received: true, matched: true });
  }
  const by = sh.carrier && sh.carrier !== 'OTO' ? sh.carrier : 'the courier';
  if (status === 'delivered') {
    shipments.markDelivered(sh.id, 'courier');
  } else if (status === 'outForDelivery') {
    stepShipment(sh, 'out_for_delivery', `Out for delivery with ${by}`);
  } else if (OTO_COLLECTED.has(status)) {
    if (sh.status === 'processing') stepShipment(sh, 'shipped', `Collected by ${by}${sh.tracking_number && sh.tracking_number !== sh.delivery_ref ? ' · ' + sh.tracking_number : ''}`);
  } else if (OTO_NOTES[status]) {
    timeline(sh, OTO_NOTES[status] + (b.attemptFailureReason ? ` (${b.attemptFailureReason})` : ''));
  }
  res.json({ received: true, matched: true });
});

router.post('/mock/deliver', (req, res) => {
  // Hand-crank for the mock provider: allowed for admins anywhere, and for
  // anyone outside production (local QA).
  const isAdmin = req.session?.userId
    && db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId)?.role === 'admin';
  if (process.env.NODE_ENV === 'production' && !isAdmin) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const sh = shipments.markDelivered(Number(req.body?.shipmentId), 'courier');
  if (!sh) return res.status(404).json({ error: 'Shipment not found' });
  res.json({ ok: true, shipment: { id: sh.id, status: sh.status, deliveredAt: sh.delivered_at, returnWindowEndsAt: sh.return_window_ends_at } });
});

module.exports = router;
