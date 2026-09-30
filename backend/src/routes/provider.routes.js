'use strict';
/**
 * Service-provider dashboard. Everything needs a provider profile on the
 * account (any status — a pending provider can prepare their listings; they
 * only appear publicly once the profile is approved).
 *
 * Contact privacy mirrors the product marketplace: the provider never sees
 * the customer's email, and the phone number is handed over only once the
 * booking is secured — confirmed for a direct booking, paid for a booking paid
 * through Trove. Before that the request is name + area + brief only.
 * The booking lifecycle itself lives in src/service-bookings.js.
 */
const express = require('express');
const db = require('../db');
const { requireProvider } = require('../middleware');
const tax = require('../service-taxonomy');
const fees = require('../fees');

const router = express.Router();
router.use(requireProvider);

const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch (_) { return fb; } };

function providerMe(p) {
  return {
    id: p.id, name: p.name, slug: p.slug, status: p.status,
    bio: p.bio, location: p.location, color: p.color,
    categories: parseJson(p.categories, []),
    // Owner, 2026-09-30: listing is free during launch — the monthly fee
    // starts later, with 30 days' notice. sub_started_at is kept as data (the
    // approval date) but no longer presented as a running subscription.
    subscription: {
      feeCents: fees.PROVIDER_SUB_FEE_CENTS,
      freeDuringLaunch: true,
      noticeDays: 30,
      agreedAt: p.sub_agreed_at || null,
    },
    commissionPercent: fees.SERVICE_COMMISSION_PERCENT,
    earnings: require('../service-credits').providerBalances(p.id),
    agreement: { version: p.agreement_version || '', acceptedAt: p.agreement_accepted_at || null },
    createdAt: p.created_at,
  };
}

const shapeService = (s) => ({
  id: s.id, title: s.title, category: s.category, description: s.description,
  priceCents: s.price_cents, priceType: s.price_type, duration: s.duration,
  setting: s.setting, status: s.status, createdAt: s.created_at,
});

/* ---------------- Profile ---------------- */

router.get('/me', (req, res) => res.json({ provider: providerMe(req.provider) }));

router.patch('/me', (req, res) => {
  const b = req.body || {};
  const updates = {};
  const v = require('../validate');
  if (b.bio !== undefined) {
    const r = v.longText(b.bio, { label: 'Your story', max: v.LIMITS.bio });
    if (r.error) return res.status(400).json({ error: r.error });
    updates.bio = r.value;
  }
  if (b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Your practice needs a name' });
    const r = v.shortText(name, { label: 'Practice name', max: v.LIMITS.shopName });
    if (r.error) return res.status(400).json({ error: r.error });
    updates.name = r.value;
  }
  if (b.categories !== undefined) {
    const cats = Array.isArray(b.categories) ? b.categories.map((c) => String(c).trim()).filter(Boolean) : [];
    if (!cats.length || cats.length > 3) return res.status(400).json({ error: 'Choose one to three service categories' });
    for (const c of cats) {
      const err = tax.serviceCategoryError(c);
      if (err) return res.status(422).json({ error: err.message });
    }
    updates.categories = JSON.stringify(cats.slice(0, 3));
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    db.prepare(`UPDATE service_providers SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
      .run(...keys.map((k) => updates[k]), req.provider.id);
  }
  res.json({ provider: providerMe(db.prepare('SELECT * FROM service_providers WHERE id=?').get(req.provider.id)) });
});

/* ---------------- Services CRUD ---------------- */

// Validates a create/update payload; returns { error } or clean fields.
function serviceFields(b, partial) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('title')) {
    const title = String(b.title || '').trim();
    if (!title) return { error: 'Give the service a name' };
    const r = require('../validate').shortText(title, { label: 'Service name', max: 90 });
    if (r.error) return { error: r.error };
    out.title = r.value;
  }
  if (!partial || has('category')) {
    const err = tax.serviceCategoryError(b.category);
    if (err) return { error: err.message, status: 422 };
    out.category = String(b.category).trim();
  }
  if (!partial || has('priceCents')) {
    const price = Math.round(Number(b.priceCents));
    if (!Number.isFinite(price) || price < 100 || price > 10000000) {
      return { error: 'Set a price between AED 1 and AED 100,000' };
    }
    out.price_cents = price;
  }
  if (!partial || has('priceType')) {
    const pt = String(b.priceType || 'fixed');
    if (!tax.PRICE_TYPES.includes(pt)) return { error: `priceType must be one of ${tax.PRICE_TYPES.join(', ')}` };
    out.price_type = pt;
  }
  if (!partial || has('setting')) {
    const st = String(b.setting || 'home');
    if (!tax.SETTINGS.includes(st)) return { error: `setting must be one of ${tax.SETTINGS.join(', ')}` };
    out.setting = st;
  }
  if (has('description')) out.description = String(b.description || '').trim().slice(0, 2000);
  if (has('duration')) {
    const r = require('../validate').shortText(b.duration, { label: 'Duration', max: 60, optional: true });
    if (r.error) return { error: r.error };
    out.duration = r.value;
  }
  if (has('status')) {
    if (!['live', 'hidden'].includes(b.status)) return { error: 'status must be live or hidden' };
    out.status = b.status;
  }
  return { fields: out };
}

router.get('/services', (req, res) => {
  const rows = db.prepare('SELECT * FROM services WHERE provider_id=? ORDER BY created_at DESC').all(req.provider.id);
  res.json({ services: rows.map(shapeService) });
});

router.post('/services', (req, res) => {
  const v = serviceFields(req.body || {}, false);
  if (v.error) return res.status(v.status || 400).json({ error: v.error });
  const f = { description: '', duration: '', status: 'live', ...v.fields };
  const info = db.prepare(`INSERT INTO services
      (provider_id, title, category, description, price_cents, price_type, duration, setting, status)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.provider.id, f.title, f.category, f.description, f.price_cents, f.price_type, f.duration, f.setting, f.status);
  res.status(201).json({ service: shapeService(db.prepare('SELECT * FROM services WHERE id=?').get(info.lastInsertRowid)) });
});

router.patch('/services/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM services WHERE id=? AND provider_id=?').get(req.params.id, req.provider.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const v = serviceFields(req.body || {}, true);
  if (v.error) return res.status(v.status || 400).json({ error: v.error });
  const keys = Object.keys(v.fields);
  if (keys.length) {
    db.prepare(`UPDATE services SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
      .run(...keys.map((k) => v.fields[k]), s.id);
  }
  res.json({ service: shapeService(db.prepare('SELECT * FROM services WHERE id=?').get(s.id)) });
});

router.delete('/services/:id', (req, res) => {
  // A listing with a booking paid through Trove carries a money record —
  // deleting it would take the booking with it (ON DELETE CASCADE). Hide it.
  const paid = db.prepare('SELECT 1 FROM service_bookings WHERE service_id=? AND paid_at IS NOT NULL').get(req.params.id);
  if (paid) return res.status(409).json({ error: 'This service has bookings paid through Trove, so it can’t be deleted — hide it instead' });
  const r = db.prepare('DELETE FROM services WHERE id=? AND provider_id=?').run(req.params.id, req.provider.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/* ---------------- Payouts ---------------- */
// Fees for bookings paid through Trove are paid by bank transfer from the
// payer named here (Serein Consultancy) on Trove's behalf. Only ever the
// masked IBAN leaves the server — see src/provider-payouts.js.
function payoutView(p) {
  const pay = require('../provider-payouts');
  const credits = require('../service-credits');
  const shop = pay.shopWithBank(p.user_id);
  return {
    details: pay.getDetails(p.id),
    shopDetails: shop ? { name: shop.name, accountName: shop.payout_account_name, bankName: shop.payout_bank_name, iban: shop.iban_masked } : null,
    payerName: credits.payerName(),
    graceDays: credits.GRACE_DAYS,
    needsDetails: pay.hasPaidBooking(p.id) && !pay.getDetails(p.id),
    earnings: credits.providerBalances(p.id),
    credits: pay.statement(p.id),
  };
}

router.get('/payout', (req, res) => res.json(payoutView(req.provider)));

// PUT /api/provider/payout { accountName, bankName, iban } | { useShop: true }
router.put('/payout', (req, res) => {
  const r = require('../provider-payouts').saveDetails(req.provider, req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(payoutView(req.provider));
});

/* ---------------- Bookings ---------------- */

// The provider's view of a booking. Email is never included; the phone
// number appears once the provider has confirmed.
function shapeBookingForProvider(bk) {
  // 'confirmed' is only ever reached by a trove booking once it is paid, so
  // this one rule covers both ways of paying.
  const secured = ['confirmed', 'completed'].includes(bk.status);
  return {
    id: bk.id, code: bk.code, status: bk.status, title: bk.title,
    priceCents: bk.price_cents, priceType: bk.price_type,
    amountCents: bk.amount_cents || 0,
    customerName: bk.name, area: bk.area,
    preferredDate: bk.preferred_date, serviceDate: bk.service_date || null, notes: bk.notes,
    paymentMethod: bk.payment_method,
    paid: !!bk.paid_at, paidAt: bk.paid_at || null,
    refunded: !!bk.refunded_at,
    commissionCents: bk.commission_cents || 0,
    providerNetCents: bk.provider_net_cents || 0,
    declineReason: bk.decline_reason || '', cancelledBy: bk.cancelled_by || '',
    phone: secured ? bk.phone : null,
    createdAt: bk.created_at, confirmedAt: bk.confirmed_at, completedAt: bk.completed_at,
  };
}

router.get('/bookings', (req, res) => {
  const rows = db.prepare('SELECT * FROM service_bookings WHERE provider_id=? ORDER BY created_at DESC').all(req.provider.id);
  res.json({ bookings: rows.map(shapeBookingForProvider) });
});

// PATCH /api/provider/bookings/:id
//   { action: 'confirm', serviceDate?: 'YYYY-MM-DD', priceCents? }
//       direct: confirmed (date optional). trove: the service date is required,
//       and so is the final price for a 'from' / 'hourly' listing — a
//       PaymentIntent opens and the booking waits for the customer's card.
//   { action: 'decline', reason? }   a new or unpaid request
//   { action: 'cancel', reason? }    a confirmed booking — refunded in full if paid
//   { action: 'complete' }           done: a paid booking's fee becomes payable
router.patch('/bookings/:id', async (req, res, next) => {
  try {
    const svc = require('../service-bookings');
    const bk = db.prepare('SELECT * FROM service_bookings WHERE id=? AND provider_id=?').get(req.params.id, req.provider.id);
    if (!bk) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    let r;
    if (b.action === 'confirm') r = await svc.confirm(bk, { priceCents: b.priceCents, serviceDate: b.serviceDate });
    else if (b.action === 'decline') r = svc.decline(bk, b.reason);
    else if (b.action === 'cancel') r = await svc.cancel(bk, { by: 'provider', reason: String(b.reason || '') });
    else if (b.action === 'complete') r = svc.complete(bk);
    else return res.status(400).json({ error: 'action must be confirm, decline, cancel or complete' });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ booking: shapeBookingForProvider(r.booking) });
  } catch (e) { next(e); }
});

module.exports = router;
