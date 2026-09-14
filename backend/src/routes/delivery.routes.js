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

function verified(req) {
  const secret = process.env.QUIQUP_WEBHOOK_SECRET;
  if (!secret) return true; // unset = open (local / staging before Quiqup issues the token)
  if (req.headers['x-webhook-secret'] === secret) return true; // legacy shared-secret header
  const sig = String(req.headers['x-signature'] || '');
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const want = 'sha1=' + crypto.createHmac('sha1', secret).update(raw).digest('hex');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

router.post('/webhook', (req, res) => {
  if (!verified(req)) return res.status(401).json({ error: 'Bad webhook signature' });
  const b = req.body || {};
  const p = (b.type === 'order' && b.payload) ? b.payload : b;
  const ref = String(p.id || p.ref || p.reference || p.job_id || '');
  const event = String(p.state || p.event || p.status || '').toLowerCase();
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
