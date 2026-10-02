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
 *   POST /api/delivery/mock/collect-return  the same for a return collection
 *                                    { requestId } — collected → buyer refunded.
 */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const shipments = require('../shipments');

const router = express.Router();

const courier = require('../courier-ops');

/** Move a shipment forward from a courier event — never backwards out of
 *  delivered, and never out of 'cancelled': Trove cancelled (and refunded)
 *  that parcel, so a late courier event only lands on the timeline and a
 *  person is told. Any step past processing means the courier has it. */
function stepShipment(sh, status, note) {
  if (sh.status === 'cancelled') {
    timeline(sh, `Courier update on a cancelled parcel: ${note || shipments.noteFor(status)} — we are looking into it`);
    courier.raise(sh.id, 'delivered_after_cancel', [
      `The courier reports '${status.replace(/_/g, ' ')}' on a parcel Trove cancelled and refunded.`,
      'Ask the courier to stop it and bring it back to the maker.',
    ]);
    return;
  }
  if (['shipped', 'out_for_delivery'].includes(status) && !(status === 'shipped' && /^Ready for collection/.test(note || ''))) courier.collected(sh.id);
  if (sh.status === status || sh.status === 'delivered') return;
  db.prepare("UPDATE shipments SET status=?, updated_at=datetime('now') WHERE id=?").run(status, sh.id);
  db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
    .run(sh.id, status, note || shipments.noteFor(status, sh.carrier, sh.tracking_number));
  shipments.deriveOrderStatus(sh.order_id);
  sh.status = status;
}
const timeline = (sh, note) => db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)').run(sh.id, sh.status, note);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Webhooks fail CLOSED in production: an unset secret there means nobody can
// prove they are the courier, so every call is refused. Locally and in tests
// an unset secret stays open, for the mock courier and hand testing.
const isProd = () => process.env.NODE_ENV === 'production';
/** The shipment a courier reference names — only among that courier's own bookings. */
const { providerOf } = require('../delivery');
function shipmentFor(ref, providers) {
  const sh = db.prepare('SELECT * FROM shipments WHERE delivery_ref=?').get(ref);
  return sh && providers.includes(providerOf(sh)) ? sh : null;
}

/* A return job (buyer → maker) in these states means the courier has the
 * piece — the moment the buyer's refund goes out. */
const RETURN_COLLECTED = new Set(['collected', 'picked_up', 'in_transit', 'transit', 'received_at_depot', 'at_depot',
  'out_for_delivery', 'delivered', 'delivery_complete', 'complete', 'completed']);

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
  if (!secret) return !isProd(); // unset = open locally / in tests, closed in production
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

  // Quiqup (and the mock courier, which speaks the same shape) only ever
  // moves shipments it booked — never an OTO parcel.
  const sh = shipmentFor(ref, ['quiqup', 'mock']);
  if (!sh) {
    // A return collection is its own courier job: once the courier has the
    // piece, the buyer's refund goes out (src/returns.js markCollected).
    const col = db.prepare("SELECT id, shipment_id FROM return_collections WHERE ref=?").get(ref);
    const shipOf = col && db.prepare('SELECT * FROM shipments WHERE id=?').get(col.shipment_id);
    // Never an OTO return (those arrive signed on /oto-webhook).
    if (!col || providerOf(shipOf) === 'oto' || /^TRV-/.test(ref)) return res.json({ received: true, matched: false });
    if (RETURN_COLLECTED.has(event)) {
      return require('../returns').markCollected({ ref })
        .then(() => res.json({ received: true, matched: true }))
        .catch((e) => { console.error('return collection webhook failed:', e.message); res.json({ received: true, matched: true }); });
    }
    return res.json({ received: true, matched: true });
  }

  if (p.tracking_url && !sh.tracking_url) db.prepare('UPDATE shipments SET tracking_url=? WHERE id=?').run(p.tracking_url, sh.id);

  const step = (status, note) => stepShipment(sh, status, note);

  if (['delivered', 'delivery_complete', 'complete', 'completed'].includes(event)) {
    shipments.markDelivered(sh.id, 'courier');
  } else if (event === 'out_for_delivery') {
    step('out_for_delivery', 'Out for delivery with Quiqup');
  } else if (IN_TRANSIT.has(event) || ['in_transit', 'picked_up', 'started'].includes(event)) {
    // ready_for_collection / out_for_collection / scheduled = still at the
    // maker's; anything else = the courier has the parcel.
    const pickedUp = !['ready_for_collection', 'out_for_collection', 'scheduled'].includes(event);
    if (sh.status === 'cancelled') step('shipped', pickedUp ? 'Collected by Quiqup' : 'Ready for collection · Quiqup');
    else if (pickedUp) {
      const first = !sh.collected_at;
      courier.collected(sh.id);
      if (sh.status === 'processing') step('shipped', 'Collected by Quiqup');
      else if (first) timeline(sh, 'Collected by Quiqup');
    } else if (sh.status === 'processing') step('shipped', 'Ready for collection · Quiqup');
  } else if (NOTES[event]) {
    db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)').run(sh.id, sh.status, NOTES[event]);
    if (['return_to_origin', 'out_for_return', 'returned_to_origin'].includes(event)) {
      courier.raise(sh.id, 'returning', ['Quiqup reports the parcel is going back to the maker — the buyer does not have it and has not been refunded.',
        'Decide whether to re-send it or cancel and refund it (Admin → Orders → Cancel items).']);
    }
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
  returnProcessing: 'Delivery did not go through — the parcel is on its way back to the shop. We are looking into this',
  returned: 'Parcel returned to the shop — we are looking into this',
  shipmentCanceled: 'Courier booking cancelled',
  lostOrDamaged: 'The courier reports a problem with the parcel — we are looking into this',
  destroyed: 'The courier reports a problem with the parcel — we are looking into this',
};
// OTO statuses that need a person (src/courier-ops.js emails the admin once per flag).
const OTO_ALERTS = {
  lostOrDamaged: ['lost', 'The courier reports this parcel lost or damaged. The buyer has been told we are looking into it.',
    'Check with OTO, then re-send the piece or cancel and refund it (Admin → Orders → Cancel items).'],
  destroyed: ['lost', 'The courier reports this parcel damaged beyond delivery. The buyer has been told we are looking into it.',
    'Check with OTO, then re-send the piece or cancel and refund it (Admin → Orders → Cancel items).'],
  returnProcessing: ['returning', 'Delivery failed and the courier is taking the parcel back to the maker. The buyer does not have it and has not been refunded.',
    'Contact the buyer, then re-send it or cancel and refund it (Admin → Orders → Cancel items).'],
  returned: ['returning', 'The parcel went back to the maker after a failed delivery. The buyer does not have it and has not been refunded.',
    'Contact the buyer, then re-send it or cancel and refund it (Admin → Orders → Cancel items).'],
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

// Return states that mean the courier has collected the piece from the buyer.
const OTO_RETURN_COLLECTED = new Set(['reversePickedUp', 'reverseOutForDelivery', 'reverseReturned', 'reverseConfirmReturn', 'confirmedReturn']);

function otoVerified(req) {
  const secret = process.env.OTO_WEBHOOK_SECRET;
  if (!secret) return !isProd(); // unset = open locally / in tests, closed in production
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
  const sh = shipmentFor(ref, ['oto']);
  if (!sh) return res.json({ received: true, matched: false });

  if (kind === 'error') {
    // The courier refused the booking after the fact: no driver is coming.
    // The parcel goes back to 'packed, collection not booked' (processing +
    // packed_at), the failure is recorded and the admin emailed, and the
    // hourly sweep books it again (src/courier-ops.js).
    db.prepare(`UPDATE shipments SET ready_at=NULL,
        status = CASE WHEN status='shipped' AND collected_at IS NULL THEN 'processing' ELSE status END,
        packed_at = COALESCE(packed_at, datetime('now'))
      WHERE id=?`).run(sh.id);
    sh.status = db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status;
    const why = [b.errorCode, b.errorMessage, b.deliveryCompany ? `(${b.deliveryCompany})` : ''].filter(Boolean).join(' ') || 'shipment error';
    courier.bookingFailed(sh.id, 'collection', Object.assign(new Error(`OTO: ${why}`), { otoCode: b.errorCode || '' }));
    timeline(sh, 'The courier booking did not go through — we are booking another collection');
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
    if (OTO_RETURN_COLLECTED.has(returnStatus)) {
      // The courier has the returned piece: the buyer's refund goes out now
      // (src/returns.js). Matched by the return orderId OTO gave us at
      // booking, else by the latest booked collection on this parcel.
      const returns = require('../returns');
      const ret = String(b.returnOrderId || '');
      const known = ret && db.prepare('SELECT 1 FROM return_collections WHERE ref=?').get(ret);
      return returns.markCollected(known ? { ref: ret, quiet: true } : { shipmentId: sh.id, quiet: true })
        .then(() => res.json({ received: true, matched: true }))
        .catch((e) => { console.error('OTO return collection failed:', e.message); res.json({ received: true, matched: true }); });
    }
    return res.json({ received: true, matched: true });
  }
  const by = sh.carrier && sh.carrier !== 'OTO' ? sh.carrier : 'the courier';
  if (status === 'delivered') {
    shipments.markDelivered(sh.id, 'courier');
  } else if (status === 'outForDelivery') {
    stepShipment(sh, 'out_for_delivery', `Out for delivery with ${by}`);
  } else if (OTO_COLLECTED.has(status)) {
    // The courier has it: stamp the collection once (the maker's Packed tap
    // already moved a booked parcel to 'shipped', so this is the first time
    // anything says the parcel actually left the maker).
    const note = `Collected by ${by}${sh.tracking_number && sh.tracking_number !== sh.delivery_ref ? ' · ' + sh.tracking_number : ''}`;
    if (sh.status === 'cancelled') stepShipment(sh, 'shipped', note);
    else if (sh.status === 'processing') stepShipment(sh, 'shipped', note);
    else if (!sh.collected_at && sh.status === 'shipped') { courier.collected(sh.id); timeline(sh, note); }
    else courier.collected(sh.id);
  } else if (OTO_NOTES[status]) {
    timeline(sh, OTO_NOTES[status] + (b.attemptFailureReason ? ` (${b.attemptFailureReason})` : ''));
    if (OTO_ALERTS[status]) courier.raise(sh.id, OTO_ALERTS[status][0], OTO_ALERTS[status].slice(1));
    if (status === 'undeliveredAttempt') {
      const tries = db.prepare("SELECT COUNT(*) AS n FROM shipment_events WHERE shipment_id=? AND note LIKE 'Delivery attempt failed%'").get(sh.id).n;
      if (tries >= 2) courier.raise(sh.id, 'delivery_attempts', [`The courier has now failed to deliver this parcel ${tries} times${b.attemptFailureReason ? ` (latest: ${b.attemptFailureReason})` : ''}.`,
        "Worth calling the buyer to check the address and when they're in. The buyer's phone is on the order in Admin → Orders."]);
    }
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

// Hand-crank for a return collection in mock mode (or when a courier never
// reports): marks every booked collection on the request collected, which
// sends the buyer's refund. Same access rule as /mock/deliver.
router.post('/mock/collect-return', async (req, res, next) => {
  try {
    const isAdmin = req.session?.userId
      && db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId)?.role === 'admin';
    if (process.env.NODE_ENV === 'production' && !isAdmin) return res.status(403).json({ error: 'Admin only' });
    const requestId = Number(req.body?.requestId);
    const cols = db.prepare("SELECT * FROM return_collections WHERE request_id=? AND status IN ('booking','booked')").all(requestId);
    if (!cols.length) return res.status(404).json({ error: 'No collection waiting on that return' });
    const returns = require('../returns');
    for (const c of cols) await returns.markCollected(c.ref ? { ref: c.ref } : { shipmentId: c.shipment_id });
    res.json({ ok: true, request: returns.shape(db.prepare('SELECT * FROM return_requests WHERE id=?').get(requestId)) });
  } catch (e) { next(e); }
});

module.exports = router;
