'use strict';
/**
 * Delivery-side endpoints:
 *   POST /api/delivery/webhook       courier callbacks. Quiqup posts
 *                                    { action, type:'order', payload:{ id, state, tracking_url … } }
 *                                    signed with X-Signature: sha1=HMAC(rawBody, QUIQUP_WEBHOOK_SECRET).
 *                                    The older flat shape { ref, event } with an
 *                                    x-webhook-secret header is still accepted
 *                                    (mock provider / manual tests).
 *   POST /api/delivery/mock/deliver  dev/admin hand-crank for the mock
 *                                    provider: confirms delivery of a shipment
 *                                    as if the courier had.
 */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const shipments = require('../shipments');

const router = express.Router();

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

  const step = (status, note) => {
    if (sh.status === status || sh.status === 'delivered') return;
    db.prepare("UPDATE shipments SET status=?, updated_at=datetime('now') WHERE id=?").run(status, sh.id);
    db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
      .run(sh.id, status, note || shipments.noteFor(status, sh.carrier, sh.tracking_number));
    shipments.deriveOrderStatus(sh.order_id);
  };

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
