'use strict';
/**
 * Service-provider dashboard. Everything needs a provider profile on the
 * account (any status — a pending provider can prepare their listings; they
 * only appear publicly once the profile is approved).
 *
 * Contact privacy mirrors the product marketplace: the provider never sees
 * the customer's email, and the phone number is handed over only once the
 * provider confirms the booking — before that the request is name + area +
 * brief only.
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
    subscription: {
      feeCents: fees.PROVIDER_SUB_FEE_CENTS,
      agreedAt: p.sub_agreed_at || null,
      startedAt: p.sub_started_at || null,
    },
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
  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const updates = {};
  if (b.bio !== undefined) updates.bio = clean(b.bio, 2000);
  if (b.name !== undefined) {
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: 'Your practice needs a name' });
    updates.name = name;
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
    const title = String(b.title || '').trim().slice(0, 90);
    if (!title) return { error: 'Give the service a name' };
    out.title = title;
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
  if (has('duration')) out.duration = String(b.duration || '').trim().slice(0, 60);
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
  const r = db.prepare('DELETE FROM services WHERE id=? AND provider_id=?').run(req.params.id, req.provider.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/* ---------------- Bookings ---------------- */

// The provider's view of a booking. Email is never included; the phone
// number appears once the provider has confirmed.
function shapeBookingForProvider(bk) {
  const confirmed = ['confirmed', 'completed'].includes(bk.status);
  return {
    id: bk.id, code: bk.code, status: bk.status, title: bk.title,
    priceCents: bk.price_cents, priceType: bk.price_type,
    customerName: bk.name, area: bk.area,
    preferredDate: bk.preferred_date, notes: bk.notes,
    paymentMethod: bk.payment_method,
    phone: confirmed ? bk.phone : null,
    createdAt: bk.created_at, confirmedAt: bk.confirmed_at, completedAt: bk.completed_at,
  };
}

router.get('/bookings', (req, res) => {
  const rows = db.prepare('SELECT * FROM service_bookings WHERE provider_id=? ORDER BY created_at DESC').all(req.provider.id);
  res.json({ bookings: rows.map(shapeBookingForProvider) });
});

// PATCH /api/provider/bookings/:id { action: confirm | decline | complete, reason? }
router.patch('/bookings/:id', (req, res) => {
  const bk = db.prepare('SELECT * FROM service_bookings WHERE id=? AND provider_id=?').get(req.params.id, req.provider.id);
  if (!bk) return res.status(404).json({ error: 'Not found' });
  const { action } = req.body || {};
  if (action === 'confirm') {
    if (bk.status !== 'requested') return res.status(409).json({ error: 'Only a new request can be confirmed' });
    db.prepare("UPDATE service_bookings SET status='confirmed', confirmed_at=datetime('now') WHERE id=?").run(bk.id);
  } else if (action === 'decline') {
    if (bk.status !== 'requested') return res.status(409).json({ error: 'Only a new request can be declined' });
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
    db.prepare("UPDATE service_bookings SET status='declined', decline_reason=? WHERE id=?").run(reason, bk.id);
  } else if (action === 'complete') {
    if (bk.status !== 'confirmed') return res.status(409).json({ error: 'Only a confirmed booking can be marked done' });
    db.prepare("UPDATE service_bookings SET status='completed', completed_at=datetime('now') WHERE id=?").run(bk.id);
  } else {
    return res.status(400).json({ error: 'action must be confirm, decline or complete' });
  }
  res.json({ booking: shapeBookingForProvider(db.prepare('SELECT * FROM service_bookings WHERE id=?').get(bk.id)) });
});

module.exports = router;
