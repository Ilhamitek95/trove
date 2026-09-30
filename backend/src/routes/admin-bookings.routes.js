'use strict';
/**
 * Admin — Services Marketplace bookings paid through Trove.
 *
 *   GET  /api/admin/service-bookings               bookings, newest first (paid / attention first)
 *   POST /api/admin/service-bookings/:id/refund    refund a paid booking in full
 *   GET  /api/admin/service-credits                what providers are owed now (settlement view)
 *   POST /api/admin/service-credits/:providerId/paid  { reference } close what was just paid by bank transfer
 *
 * Kept in its own file (mounted beside admin.routes.js) so the booking money
 * flow reads in one place: src/service-bookings.js + src/service-credits.js.
 */
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware');
const svc = require('../service-bookings');
const credits = require('../service-credits');

const router = express.Router();

router.get('/service-bookings', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT bk.*, p.name AS provider_name FROM service_bookings bk
    JOIN service_providers p ON p.id = bk.provider_id
    ORDER BY CASE WHEN bk.attention <> '' THEN 0 WHEN bk.paid_at IS NOT NULL AND bk.refunded_at IS NULL THEN 1 ELSE 2 END,
             bk.created_at DESC, bk.id DESC
    LIMIT 300`).all();
  res.json({ bookings: rows.map((bk) => ({
    id: bk.id, code: bk.code, status: bk.status, title: bk.title, providerName: bk.provider_name,
    // Trove is the contracting party on a trove booking: admin sees the customer.
    customer: { name: bk.name, email: bk.email, phone: bk.phone },
    area: bk.area, serviceDate: bk.service_date || null, preferredDate: bk.preferred_date,
    paymentMethod: bk.payment_method, priceCents: bk.price_cents, priceType: bk.price_type,
    amountCents: bk.amount_cents || 0, commissionCents: bk.commission_cents || 0, providerNetCents: bk.provider_net_cents || 0,
    paidAt: bk.paid_at || null, refundedAt: bk.refunded_at || null, refundCents: bk.refund_cents || 0,
    attention: bk.attention || '', cancelledBy: bk.cancelled_by || '',
    paymentIntent: bk.stripe_payment_intent_id || null,
    createdAt: bk.created_at, completedAt: bk.completed_at,
  })) });
});

// A full refund. A booking that hasn't happened yet is cancelled with it; a
// completed one stays completed (a dispute refund) — the provider's credit is
// voided, or debited from their next payment if it was already paid out.
router.post('/service-bookings/:id/refund', requireAdmin, async (req, res, next) => {
  try {
    const bk = db.prepare('SELECT * FROM service_bookings WHERE id=?').get(req.params.id);
    if (!bk) return res.status(404).json({ error: 'Booking not found' });
    if (!bk.paid_at) return res.status(409).json({ error: 'This booking has no card payment to refund' });
    if (bk.refunded_at) return res.status(409).json({ error: 'Already refunded' });
    if (['requested', 'awaiting_payment', 'confirmed'].includes(bk.status)) {
      const r = await svc.cancel(bk, { by: 'admin', reason: String((req.body || {}).reason || '') });
      if (r.error) return res.status(r.status).json({ error: r.error });
      if (!r.refunded) return res.status(502).json({ error: 'The booking is cancelled but the card refund failed — refund it by hand in Stripe' });
    } else {
      const ok = await svc.refund(bk, { reason: 'admin', notify: 'refunded' });
      if (!ok) return res.status(502).json({ error: 'The card refund failed — nothing changed; try again or refund by hand in Stripe' });
    }
    const fresh = db.prepare('SELECT * FROM service_bookings WHERE id=?').get(bk.id);
    res.json({ ok: true, booking: { id: fresh.id, status: fresh.status, refundedAt: fresh.refunded_at, refundCents: fresh.refund_cents } });
  } catch (e) { next(e); }
});

router.get('/service-credits', requireAdmin, (_req, res) => {
  res.json(credits.preview());
});

router.post('/service-credits/:providerId/paid', requireAdmin, (req, res) => {
  const r = credits.markPaid(Number(req.params.providerId), (req.body || {}).reference);
  if (!r) return res.status(404).json({ error: 'Nothing is payable to this provider right now' });
  res.json({ ok: true, ...r });
});

module.exports = router;
