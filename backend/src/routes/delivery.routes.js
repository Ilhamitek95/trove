'use strict';
/**
 * Delivery-side endpoints:
 *   POST /api/delivery/webhook       courier callbacks (live: shared-secret
 *                                    header) — 'delivered' stamps the shipment
 *                                    via the single markDelivered funnel.
 *   POST /api/delivery/mock/deliver  dev/admin hand-crank for the mock
 *                                    provider: confirms delivery of a shipment
 *                                    as if the courier had.
 */
const express = require('express');
const db = require('../db');
const shipments = require('../shipments');

const router = express.Router();

router.post('/webhook', (req, res) => {
  const secret = process.env.QUIQUP_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Bad webhook secret' });
  }
  const b = req.body || {};
  const ref = String(b.ref || b.reference || b.job_id || '');
  const event = String(b.event || b.state || b.status || '').toLowerCase();
  if (!ref) return res.status(400).json({ error: 'Missing job reference' });

  const sh = db.prepare('SELECT * FROM shipments WHERE delivery_ref=?').get(ref);
  if (!sh) return res.json({ received: true, matched: false });

  if (event === 'delivered' || event === 'complete' || event === 'completed') {
    shipments.markDelivered(sh.id, 'courier');
  } else if (event === 'in_transit' || event === 'picked_up' || event === 'started') {
    if (sh.status === 'processing') {
      db.prepare("UPDATE shipments SET status='shipped', updated_at=datetime('now') WHERE id=?").run(sh.id);
      db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'shipped', ?)")
        .run(sh.id, shipments.noteFor('shipped', sh.carrier, sh.tracking_number));
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

module.exports = router;
