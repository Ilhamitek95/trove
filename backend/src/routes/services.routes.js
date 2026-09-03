'use strict';
/**
 * Public services marketplace.
 *
 *   GET  /api/services/taxonomy      the audiences + categories (with examples)
 *   GET  /api/services               live services of approved providers
 *   POST /api/services/apply         become a provider (new or existing account)
 *   POST /api/services/:id/book      request a booking on one service
 *   GET  /api/services/my-bookings   the signed-in customer's booking requests
 *   POST /api/services/bookings/:id/cancel
 *
 * Money model: no commission on the service price — providers pay the monthly
 * platform subscription (fees.PROVIDER_SUB_FEE_CENTS). A booking is settled
 * between customer and provider: cash when the service is done, or by card
 * through the site's payment rails once card payments launch.
 */
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, publicUser, requireAuth } = require('../middleware');
const { normalizeUAEMobile } = require('../phone');
const tax = require('../service-taxonomy');
const fees = require('../fees');

const router = express.Router();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch (_) { return fb; } };

// The provider as the public storefront sees them — no contact details.
function publicProvider(p) {
  return {
    id: p.id, name: p.name, slug: p.slug, bio: p.bio, location: p.location,
    color: p.color, categories: parseJson(p.categories, []),
  };
}

function shapeService(row) {
  const cat = tax.bySlug(row.category);
  return {
    id: row.id, title: row.title, category: row.category,
    audience: cat ? cat.audience : 'home',
    description: row.description, priceCents: row.price_cents,
    priceType: row.price_type, duration: row.duration, setting: row.setting,
    provider: {
      name: row.provider_name, slug: row.provider_slug,
      location: row.provider_location, color: row.provider_color, bio: row.provider_bio,
    },
  };
}

/* ---------------- Browse ---------------- */

router.get('/taxonomy', (_req, res) => {
  res.json({
    audiences: tax.AUDIENCES,
    categories: tax.SERVICE_CATEGORIES,
    providerSubFeeCents: fees.PROVIDER_SUB_FEE_CENTS,
  });
});

// GET /api/services?category=&audience=&q= → live listings, approved providers only.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT sv.*, p.name AS provider_name, p.slug AS provider_slug,
           p.location AS provider_location, p.color AS provider_color, p.bio AS provider_bio
    FROM services sv JOIN service_providers p ON p.id = sv.provider_id
    WHERE sv.status = 'live' AND p.status = 'approved'
    ORDER BY sv.created_at DESC`).all();
  let list = rows.map(shapeService);
  const { category, audience, q } = req.query;
  if (category) list = list.filter((s) => s.category === category);
  if (audience) list = list.filter((s) => s.audience === audience);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((s) =>
      `${s.title} ${s.description} ${s.provider.name}`.toLowerCase().includes(needle));
  }
  res.json({ services: list });
});

/* ---------------- Enrolment ---------------- */

// POST /api/services/apply — mirrors the shop application in auth.routes.js:
// an existing account (signed in, or proving the password) gains a provider
// profile; a new email creates the account and the profile together. The
// profile starts 'pending' and only appears publicly once an admin approves.
router.post('/apply', (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });

  // Everything is validated BEFORE any write, so a failed application never
  // leaves behind an account without a profile.
  if (b.agreeSub !== true) {
    return res.status(400).json({ error: `The AED ${Math.round(fees.PROVIDER_SUB_FEE_CENTS / 100)}/month platform subscription needs your agreement to apply` });
  }
  if (!String(b.instagram || '').trim() && !String(b.links || '').trim()) {
    return res.status(400).json({ error: 'Share your Instagram or a portfolio link so our curation team can see your work' });
  }
  if (!String(b.phone || '').trim()) return res.status(400).json({ error: 'A WhatsApp number is required to apply' });
  const { SERVICE_AREAS, isServiceable } = require('../service-area');
  if (!isServiceable(b.location)) {
    return res.status(400).json({ error: `The Services Marketplace is currently open to providers in ${SERVICE_AREAS.join(' and ')} only` });
  }
  const cats = Array.isArray(b.categories) ? b.categories.map((c) => String(c).trim()).filter(Boolean) : [];
  if (!cats.length || cats.length > 3) return res.status(400).json({ error: 'Choose one to three service categories' });
  for (const c of cats) {
    const err = tax.serviceCategoryError(c);
    if (err) return res.status(422).json({ error: err.message });
  }

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing && (!b.password || String(b.password).length < 8)) {
    return res.status(400).json({ error: 'A password of at least 8 characters is required' });
  }

  let userId;
  if (existing) {
    const ownsAccount = req.session.userId === existing.id
      || (b.password && verifyPassword(b.password, existing.password_hash));
    if (!ownsAccount) {
      return res.status(409).json({ code: 'exists_wrong_password', error: 'An account with this email already exists' });
    }
    if (db.prepare('SELECT 1 FROM service_providers WHERE user_id = ?').get(existing.id)) {
      return res.status(409).json({ code: 'already_provider', error: 'This account is already registered as a service provider' });
    }
    userId = existing.id;
  } else {
    const info = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)')
      .run(email, hashPassword(b.password), name, 'buyer');
    userId = info.lastInsertRowid;
  }

  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const providerName = clean(b.providerName, 80) || `${name}'s practice`;
  const base = slugify(providerName) || 'provider';
  let slug = base, n = 1;
  while (db.prepare('SELECT 1 FROM service_providers WHERE slug = ?').get(slug)) slug = `${base}-${++n}`;
  const ig = (() => {
    let v = clean(b.instagram, 120).replace(/^@/, '');
    if (!v) return '';
    return /instagram\.com/i.test(v) ? v.replace(/^https?:\/\//i, '') : `instagram.com/${v}`;
  })();

  db.prepare(`INSERT INTO service_providers
      (user_id, name, slug, status, bio, location, categories,
       pitch_services, pitch_experience, pitch_instagram, pitch_links, pitch_phone, sub_agreed_at)
    VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?, datetime('now'))`)
    .run(userId, providerName, slug,
      clean(b.about, 2000), clean(b.location, 120), JSON.stringify(cats.slice(0, 3)),
      clean(b.plannedServices, 2000), clean(b.experience, 60),
      ig, clean(b.links, 300), clean(b.phone, 40));

  req.session.userId = userId;
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
});

/* ---------------- Bookings ---------------- */

function shapeBookingForBuyer(bk) {
  return {
    id: bk.id, code: bk.code, status: bk.status, title: bk.title,
    priceCents: bk.price_cents, priceType: bk.price_type,
    area: bk.area, preferredDate: bk.preferred_date, notes: bk.notes,
    paymentMethod: bk.payment_method, declineReason: bk.decline_reason,
    providerName: bk.provider_name, createdAt: bk.created_at,
  };
}

// POST /api/services/:id/book — a booking request. Open to guests (name,
// email and phone are required); a signed-in customer's request is linked to
// their account so it shows under "Your bookings".
router.post('/:id(\\d+)/book', (req, res) => {
  const row = db.prepare(`
    SELECT sv.*, p.status AS provider_status FROM services sv
    JOIN service_providers p ON p.id = sv.provider_id WHERE sv.id = ?`).get(req.params.id);
  if (!row || row.status !== 'live' || row.provider_status !== 'approved') {
    return res.status(404).json({ error: 'This service is no longer available' });
  }
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Please tell us your name' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email doesn’t look right — mind checking it?' });
  const phone = normalizeUAEMobile(b.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a UAE mobile number, like 05x xxx xxxx' });
  const { SERVICE_AREAS, isServiceable } = require('../service-area');
  if (!isServiceable(b.area)) {
    return res.status(400).json({ error: `The Services Marketplace is available in ${SERVICE_AREAS.join(' and ')} only` });
  }
  const paymentMethod = b.paymentMethod === 'online' ? 'online' : 'cash';

  let code;
  do { code = 'SRV-' + require('crypto').randomBytes(3).toString('hex').toUpperCase(); }
  while (db.prepare('SELECT 1 FROM service_bookings WHERE code = ?').get(code));

  const info = db.prepare(`INSERT INTO service_bookings
      (code, service_id, provider_id, buyer_id, name, email, phone, area,
       preferred_date, notes, payment_method, title, price_cents, price_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, row.id, row.provider_id, req.session.userId || null,
      name, email, phone, String(b.area).trim().slice(0, 60),
      String(b.preferredDate || '').trim().slice(0, 60),
      String(b.notes || '').trim().slice(0, 1000),
      paymentMethod, row.title, row.price_cents, row.price_type);

  res.status(201).json({ booking: { id: info.lastInsertRowid, code, status: 'requested' } });
});

// GET /api/services/my-bookings — the signed-in customer's requests.
router.get('/my-bookings', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT bk.*, p.name AS provider_name FROM service_bookings bk
    JOIN service_providers p ON p.id = bk.provider_id
    WHERE bk.buyer_id = ? ORDER BY bk.created_at DESC`).all(req.user.id);
  res.json({ bookings: rows.map(shapeBookingForBuyer) });
});

// POST /api/services/bookings/:id/cancel — a customer can withdraw a request
// that hasn't happened yet.
router.post('/bookings/:id/cancel', requireAuth, (req, res) => {
  const bk = db.prepare('SELECT * FROM service_bookings WHERE id = ? AND buyer_id = ?').get(req.params.id, req.user.id);
  if (!bk) return res.status(404).json({ error: 'Booking not found' });
  if (!['requested', 'confirmed'].includes(bk.status)) {
    return res.status(409).json({ error: 'This booking can no longer be cancelled' });
  }
  db.prepare("UPDATE service_bookings SET status='cancelled' WHERE id=?").run(bk.id);
  res.json({ ok: true });
});

module.exports = router;
