'use strict';
/**
 * Public services marketplace.
 *
 *   GET  /api/services/taxonomy      the audiences + categories (with examples)
 *   GET  /api/services               live services of approved providers
 *   GET  /api/services/providers     the approved providers (the makers carousel's counterpart)
 *   GET  /api/services/providers/:slug  one provider + their live services
 *   POST /api/services/apply         become a provider (new or existing account)
 *   POST /api/services/:id/book      request a booking on one service
 *   GET  /api/services/my-bookings   the signed-in customer's booking requests
 *   POST /api/services/bookings/:id/cancel
 *   GET  /api/services/booking/:code?t=      a booking through its private link (guests)
 *   POST /api/services/booking/:code/cancel  { t } cancel through the link
 *   POST /api/services/booking/:code/pay     { t } the card form's client secret
 *
 * Money model: listing is free during launch (owner, 2026-09-30) — the
 * monthly listing fee (fees.PROVIDER_SUB_FEE_CENTS) starts later, with 30
 * days' notice. A booking is paid one of two ways, chosen
 * by the customer at request time and snapshotted on the booking:
 *   direct — settled between customer and provider (bank transfer, cash…);
 *            Trove is not part of that payment and takes nothing from it
 *   trove  — paid to Trove by card once the provider confirms (offered only
 *            while the server has card payments switched on); Trove keeps
 *            fees.SERVICE_COMMISSION_PERCENT and the provider's fee is the
 *            remainder (commission_cents / provider_net_cents are snapshotted
 *            from the listed price, then from the amount actually paid) — the
 *            whole lifecycle lives in src/service-bookings.js
 * Every booking records the Services Terms version the customer accepted;
 * every provider records the Provider Agreement version they accepted.
 */
const express = require('express');
const db = require('../db');
const { hashPassword, publicUser, requireAuth, startSession } = require('../middleware');
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

router.get('/taxonomy', (req, res) => {
  // Arabic pages ask with ?lang=ar: the same shapes, Arabic text (service-taxonomy.js).
  const t = tax.localized(req.lang);
  res.json({
    audiences: t.audiences,
    categories: t.categories,
    providerSubFeeCents: fees.PROVIDER_SUB_FEE_CENTS,
  });
});

// GET /api/services?category=&audience=&q= → live listings, approved providers only.
const liveServices = () => db.prepare(`
    SELECT sv.*, p.name AS provider_name, p.slug AS provider_slug,
           p.location AS provider_location, p.color AS provider_color, p.bio AS provider_bio
    FROM services sv JOIN service_providers p ON p.id = sv.provider_id
    WHERE sv.status = 'live' AND p.status = 'approved'
    ORDER BY sv.created_at DESC`).all().map(shapeService);
router.get('/', (req, res) => {
  let list = liveServices();
  const { category, audience, q } = req.query;
  if (category) list = list.filter((s) => s.category === category);
  if (audience) list = list.filter((s) => s.audience === audience);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((s) =>
      `${s.title} ${s.description} ${s.provider.name}`.toLowerCase().includes(needle));
  }
  res.json({ services: require('../translate').services(list, req.lang) });
});

/* ---------------- Providers ---------------- */

// The same account can run a shop too: the approved shop (with live pieces)
// rides along so the provider page can cross-link to it.
function shopFor(userId) {
  const s = db.prepare(`SELECT s.slug, s.name,
      (SELECT COUNT(*) FROM products pr WHERE pr.shop_id = s.id AND pr.status = 'live') AS n
    FROM shops s WHERE s.user_id = ? AND s.status = 'approved'`).get(userId);
  return s ? { slug: s.slug, name: s.name, productCount: s.n } : null;
}
const providerCard = (p) => ({
  ...publicProvider(p),
  shop: shopFor(p.user_id),
  serviceCount: p.service_count || 0,
  fromCents: p.from_cents || null,
  since: p.created_at ? String(p.created_at).slice(0, 4) : null,
});
const PROVIDER_STATS = `
  LEFT JOIN (SELECT provider_id, COUNT(*) AS service_count, MIN(price_cents) AS from_cents
             FROM services WHERE status = 'live' GROUP BY provider_id) st ON st.provider_id = p.id`;

// GET /api/services/providers → approved providers, oldest first, with their
// live-service count and lowest price. Never any contact details.
const approvedProviders = () => db.prepare(`SELECT p.*, st.service_count, st.from_cents FROM service_providers p ${PROVIDER_STATS}
    WHERE p.status = 'approved' ORDER BY p.created_at ASC, p.id ASC`).all().map(providerCard);
router.get('/providers', (req, res) => {
  res.json({ providers: require('../translate').providers(approvedProviders(), req.lang) });
});

// GET /api/services/providers/:slug → one approved provider and their live services.
function providerPage(slug) {
  const p = db.prepare(`SELECT p.*, st.service_count, st.from_cents FROM service_providers p ${PROVIDER_STATS}
    WHERE p.slug = ? AND p.status = 'approved'`).get(slug);
  if (!p) return null;
  const services = db.prepare(`
    SELECT sv.*, p.name AS provider_name, p.slug AS provider_slug,
           p.location AS provider_location, p.color AS provider_color, p.bio AS provider_bio
    FROM services sv JOIN service_providers p ON p.id = sv.provider_id
    WHERE sv.provider_id = ? AND sv.status = 'live' ORDER BY sv.created_at ASC, sv.id ASC`).all(p.id).map(shapeService);
  return { provider: providerCard(p), services };
}
router.get('/providers/:slug', (req, res) => {
  const page = providerPage(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Provider not found' });
  const tr = require('../translate');
  res.json({ ...page, provider: tr.provider(page.provider, req.lang), services: tr.services(page.services, req.lang) });
});

/* ---------------- Enrolment ---------------- */

// POST /api/services/apply — an existing account gains a provider profile
// only when it is the one signed in; a new email creates the account and the
// profile together. No password is ever checked here: this route sits outside
// the sign-in flow, so an existing email that isn't the signed-in account is
// told to sign in first (409 sign_in_required) — it must not become a second,
// quieter place to guess passwords. The profile starts 'pending' and only
// appears publicly once an admin approves. Rate-limited with /api/auth.
router.post('/apply', (req, res, next) => {
  const v = require('../validate');
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
  const nameCheck = v.shortText(name, { label: 'Your name', max: v.LIMITS.personName });
  if (nameCheck.error) return res.status(400).json({ error: nameCheck.error });
  const pnCheck = v.shortText(b.providerName, { label: 'Practice name', max: v.LIMITS.shopName, optional: true });
  if (pnCheck.error) return res.status(400).json({ error: pnCheck.error });

  // Everything is validated BEFORE any write, so a failed application never
  // leaves behind an account without a profile. Short answers are shown in
  // the admin review queue, so they carry no markup.
  if (v.markupField(b, ['experience', 'instagram', 'links', 'phone', 'location'])) {
    return res.status(400).json({ error: "Application answers can't contain < or >" });
  }
  if (b.agreeSub !== true) {
    return res.status(400).json({ error: `Please confirm you understand the listing fee (free during launch; AED ${Math.round(fees.PROVIDER_SUB_FEE_CENTS / 100)}/month later, with 30 days' notice) to apply` });
  }
  if (b.agreeTerms !== true) {
    return res.status(400).json({ error: 'The Provider Agreement needs your acceptance to apply' });
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
  if (!existing) {
    const pwErr = v.passwordError(b.password);
    if (pwErr) return res.status(400).json({ error: pwErr });
  }

  let userId;
  if (existing) {
    if (req.session.userId !== existing.id) {
      return res.status(409).json({ code: 'sign_in_required', error: 'An account with this email already exists — sign in first, then add your services' });
    }
    if (db.prepare('SELECT 1 FROM service_providers WHERE user_id = ?').get(existing.id)) {
      return res.status(409).json({ code: 'already_provider', error: 'This account is already registered as a service provider' });
    }
    userId = existing.id;
  } else {
    const info = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)')
      .run(email, hashPassword(b.password), nameCheck.value, 'buyer');
    userId = info.lastInsertRowid;
  }

  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const providerName = pnCheck.value || `${nameCheck.value}'s practice`.slice(0, 80);
  const base = slugify(providerName) || 'provider';
  let slug = base, n = 1;
  while (db.prepare('SELECT 1 FROM service_providers WHERE slug = ?').get(slug)) slug = `${base}-${++n}`;
  const ig = (() => {
    let v = clean(b.instagram, 120).replace(/^@/, '');
    if (!v) return '';
    return /instagram\.com/i.test(v) ? v.replace(/^https?:\/\//i, '') : `instagram.com/${v}`;
  })();

  const provInfo = db.prepare(`INSERT INTO service_providers
      (user_id, name, slug, status, bio, location, categories,
       pitch_services, pitch_experience, pitch_instagram, pitch_links, pitch_phone, sub_agreed_at,
       agreement_version, agreement_accepted_at)
    VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?, datetime('now'), ?, datetime('now'))`)
    .run(userId, providerName, slug,
      clean(b.about, 2000), clean(b.location, 120), JSON.stringify(cats.slice(0, 3)),
      clean(b.plannedServices, 2000), clean(b.experience, 60),
      ig, clean(b.links, 300), clean(b.phone, 40),
      require('../config').PROVIDER_AGREEMENT_VERSION);

  // Best-effort emails: application received + admin alert, and the welcome
  // (confirm your email) when this application created the account.
  const notify = require('../notify');
  notify.providerApplied(provInfo.lastInsertRowid);
  if (!existing) notify.welcomeVerify(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  // `created` lets the page report a sign-up to analytics only when this opened the account.
  const done = () => res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)), created: !existing });
  // A new account signs in on a fresh session; an applicant already signed
  // in keeps the session they have (nothing about their privileges changed).
  if (existing) return done();
  startSession(req, { userId }).then(done).catch(next);
});

/* ---------------- Bookings ---------------- */

const svc = require('../service-bookings');

function shapeBookingForBuyer(bk) {
  const view = svc.forCustomer(bk);
  return {
    ...view,
    notes: bk.notes,
    commissionCents: bk.commission_cents || 0,
    providerNetCents: bk.provider_net_cents || 0,
    // Their own booking: the private link works for them too (same page).
    viewPath: `/services/booking/${bk.code}?t=${svc.linkToken(bk)}`,
    payPath: view.canPay ? `/services/pay/${bk.code}-${svc.linkToken(bk)}` : null,
  };
}

// The two ways a booking is paid. Old spellings from the first release map
// onto the new ones so nothing stored breaks.
const PAYMENT_METHODS = { direct: 'direct', cash: 'direct', trove: 'trove', online: 'trove' };

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
  // The request lands in the provider's inbox: short fields carry no markup.
  if (require('../validate').markupField(b, ['name', 'area', 'preferredDate'])) {
    return res.status(400).json({ error: "Your request can't contain < or >" });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email doesn’t look right — mind checking it?' });
  const phone = normalizeUAEMobile(b.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a UAE mobile number, like 05x xxx xxxx' });
  const { SERVICE_AREAS, isServiceable } = require('../service-area');
  if (!isServiceable(b.area)) {
    return res.status(400).json({ error: `The Services Marketplace is available in ${SERVICE_AREAS.join(' and ')} only` });
  }
  const paymentMethod = PAYMENT_METHODS[String(b.paymentMethod || 'direct')] || 'direct';
  // Card payment is the SERVER's call: only while a Stripe client is
  // configured here, whatever the page was told.
  if (paymentMethod === 'trove' && !svc.paymentsEnabled()) {
    return res.status(400).json({ code: 'payments_off', error: 'Paying through Trove by card isn’t available right now — please choose to settle directly with the provider' });
  }
  if (b.agreeTerms !== true) {
    return res.status(400).json({ error: 'Please accept the Services Terms to send a request' });
  }
  const split = paymentMethod === 'trove' ? fees.serviceSplit(row.price_cents) : { fee: 0, net: 0 };

  let code;
  do { code = 'SRV-' + require('crypto').randomBytes(3).toString('hex').toUpperCase(); }
  while (db.prepare('SELECT 1 FROM service_bookings WHERE code = ?').get(code));

  const info = db.prepare(`INSERT INTO service_bookings
      (code, service_id, provider_id, buyer_id, name, email, phone, area,
       preferred_date, notes, payment_method, title, price_cents, price_type,
       terms_version, commission_cents, provider_net_cents, lang)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, row.id, row.provider_id, req.session.userId || null,
      name, email, phone, String(b.area).trim().slice(0, 60),
      String(b.preferredDate || '').trim().slice(0, 60),
      String(b.notes || '').trim().slice(0, 1000),
      paymentMethod, row.title, row.price_cents, row.price_type,
      require('../config').SERVICES_TERMS_VERSION, split.fee, split.net,
      req.lang === 'ar' ? 'ar' : 'en'); // the customer's emails follow the page they booked from

  const created = db.prepare('SELECT * FROM service_bookings WHERE id = ?').get(info.lastInsertRowid);
  svc.mail('requested', created);
  // The requester's own private link (also in their email) — guests have no account.
  res.status(201).json({ booking: { id: created.id, code, status: 'requested', viewPath: `/services/booking/${code}?t=${svc.linkToken(created)}` } });
});

// GET /api/services/my-bookings — the signed-in customer's requests.
router.get('/my-bookings', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT bk.*, p.name AS provider_name FROM service_bookings bk
    JOIN service_providers p ON p.id = bk.provider_id
    WHERE bk.buyer_id = ? ORDER BY bk.created_at DESC`).all(req.user.id);
  res.json({ bookings: rows.map(shapeBookingForBuyer) });
});

// POST /api/services/bookings/:id/cancel — a customer can withdraw a booking
// before the service day; anything paid through Trove is refunded in full.
router.post('/bookings/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const bk = db.prepare('SELECT * FROM service_bookings WHERE id = ? AND buyer_id = ?').get(req.params.id, req.user.id);
    if (!bk) return res.status(404).json({ error: 'Booking not found' });
    const r = await svc.cancel(bk, { by: 'customer' });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, refunded: r.refunded, booking: shapeBookingForBuyer(r.booking) });
  } catch (e) { next(e); }
});

/* ---------------- The private booking link (guests) ----------------
 * /services/booking/<code>?t=<token> and /services/pay/<code>-<token> read and
 * act on one booking with no account. The token is an HMAC of the booking, so
 * a wrong or missing token looks exactly like a booking that doesn't exist.
 * Never cached: the answer depends on a secret in the URL.                 */
function byLink(req, res) {
  res.set('Cache-Control', 'no-store');
  const t = req.method === 'GET' ? req.query.t : (req.body || {}).t;
  const bk = svc.byCodeAndToken(req.params.code, t);
  if (!bk) { res.status(404).json({ error: 'We couldn’t find that booking — check the link in your email' }); return null; }
  return bk;
}

router.get('/booking/:code', (req, res) => {
  const bk = byLink(req, res); if (!bk) return;
  const view = svc.forCustomer(bk);
  res.json({ booking: { ...view, termsVersion: bk.terms_version || '' } });
});

router.post('/booking/:code/cancel', async (req, res, next) => {
  try {
    const bk = byLink(req, res); if (!bk) return;
    const r = await svc.cancel(bk, { by: 'customer' });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, refunded: r.refunded, booking: svc.forCustomer(r.booking) });
  } catch (e) { next(e); }
});

router.post('/booking/:code/pay', async (req, res, next) => {
  try {
    const bk = byLink(req, res); if (!bk) return;
    const r = await svc.paymentSession(bk);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (e) { next(e); }
});

// The same public shapes, for the server-rendered Services pages (src/seo.js):
// what a crawler reads is exactly what the page's own script renders.
router.publicData = { liveServices, approvedProviders, providerPage };

module.exports = router;
