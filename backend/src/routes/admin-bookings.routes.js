'use strict';
/**
 * Admin — Services Marketplace bookings paid through Trove.
 *
 *   GET  /api/admin/service-bookings               bookings, newest first (paid / attention first)
 *   POST /api/admin/service-bookings/:id/refund    refund a paid booking in full
 *   GET  /api/admin/service-credits                what providers are owed at this fortnight's run, per provider
 *   GET  /api/admin/provider-payouts/export.csv    bank transfer file (the ONLY place a provider IBAN decrypts)
 *   POST /api/admin/service-credits/:providerId/paid  { reference?, amountCents? } close what was just paid by
 *                                                  bank transfer + email the provider a payment note
 *   POST /api/admin/service-credits/:providerId/release-hold  the owner checked a bank-details change
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
  const pv = credits.preview();
  // The transfer file each provider was last given and not yet marked paid:
  // 'Mark paid' closes exactly that (provider-payouts.closeBatch).
  const pp = require('../provider-payouts');
  const withBatch = (r) => {
    const b = pp.openBatch(r.providerId);
    return { ...r, batch: b ? { reference: b.reference, amountCents: b.amountCents, createdAt: b.createdAt, bookings: b.creditIds.length } : null };
  };
  const open = db.prepare(`SELECT DISTINCT b.provider_id AS id, p.name FROM provider_payout_batches b JOIN service_providers p ON p.id=b.provider_id
    WHERE b.paid_at IS NULL AND b.superseded_at IS NULL`).all();
  const shown = new Set([...pv.eligible, ...pv.excluded].map((r) => r.providerId));
  // A downloaded batch whose provider is no longer payable now (e.g. a hold
  // after the download) still needs closing once the transfer went out.
  const extra = open.filter((o) => !shown.has(o.id)).map((o) => withBatch({ providerId: o.id, name: o.name, netCents: 0, bookings: [], creditIds: [], debitIds: [], reason: 'file_only' }));
  res.json({ ...pv, eligible: pv.eligible.map(withBatch), excluded: [...pv.excluded.map(withBatch), ...extra], payerName: credits.payerName() });
});

// The provider bank transfer file: one line per provider payable now WITH
// bank details (the rest wait for them). IBANs decrypt straight into the
// response, like the shop settlement CSV — never logged, never stored.
router.get('/provider-payouts/export.csv', requireAdmin, (_req, res, next) => {
  try {
    const { csv } = require('../provider-payouts').exportCsv();
    res.set('Cache-Control', 'no-store');
    res.type('text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="trove-provider-transfers-${credits.dubaiToday()}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

// Mark a provider's batch paid once the transfer went out. It closes exactly
// the batch frozen when the transfer file was downloaded (its rows, amount
// and reference — provider-payouts.closeBatch), so a booking that became
// payable after the download is never stamped paid. `amountCents` (what the
// admin saw) must match that file.
router.post('/service-credits/:providerId/paid', requireAdmin, (req, res) => {
  const providerId = Number(req.params.providerId);
  const b = req.body || {};
  const pp = require('../provider-payouts');
  if (!pp.openBatch(providerId)) {
    const pv = credits.preview();
    const row = pv.eligible.concat(pv.excluded).find((r) => r.providerId === providerId && r.netCents > 0);
    if (!row) return res.status(404).json({ error: 'Nothing is payable to this provider right now' });
    if (!row.payTo) return res.status(409).json({ error: 'Waiting for bank details — this provider has not added them yet' });
    if (row.reason === 'bank_details_changed') return res.status(409).json({ error: 'This provider changed their bank details — check the change with them, then release the hold first' });
    if (row.reason === 'on_hold') return res.status(409).json({ error: 'This provider is suspended — their payouts are on hold' });
    return res.status(409).json({ code: 'no_file', error: 'Download the bank transfer file first — Mark paid closes exactly what is in that file' });
  }
  const r = pp.closeBatch(providerId, { reference: b.reference, expectCents: b.amountCents });
  if (!r) return res.status(404).json({ error: 'Nothing is payable to this provider right now' });
  if (r.error) return res.status(r.status).json({ error: r.error });
  if (r.owner && r.owner.email) {
    const email = require('../email');
    const msg = email.providerFeesSent({
      providerName: r.name, ownerName: r.owner.name, amountCents: r.amountCents, reference: r.reference,
      payer: r.payer, bookings: r.bookings, debitCents: r.debitCents, lang: email.langFor({ email: r.owner.email }),
    });
    email.send({ to: r.owner.email, ...msg }).catch((e) => console.error('provider fees-sent email failed:', e.message));
  }
  res.json({ ok: true, providerId: r.providerId, amountCents: r.amountCents, reference: r.reference, payer: r.payer, rows: r.rows });
});

// POST /api/admin/service-credits/:providerId/release-hold → the owner has
// checked a provider's bank change with them (by phone, not by replying to
// the account): the next transfer may go to the new account.
router.post('/service-credits/:providerId/release-hold', requireAdmin, (req, res) => {
  const ok = require('../provider-payouts').releaseHold(Number(req.params.providerId));
  if (!ok) return res.status(404).json({ error: 'No bank-change hold on this provider' });
  res.json({ ok: true });
});

module.exports = router;
