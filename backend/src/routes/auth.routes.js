'use strict';
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, publicUser, requireAuth } = require('../middleware');
const { normalizeUAEMobile } = require('../phone');

const router = express.Router();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// POST /api/auth/register
// { email, password, name, role?, shopName?,
//   about?, location?, category?, plannedProducts?, links? }  ← seller application
// A seller application with an email that already has an account attaches the
// shop to THAT account (existing buyers can become sellers) — allowed when the
// applicant is signed in as the account, or the submitted password matches it.
router.post('/register', (req, res) => {
  const { password, name, role = 'buyer', shopName } = req.body || {};
  // Emails are identities, not prose: match and store them case-insensitively.
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
  const wantsShop = role === 'seller' || role === 'both';
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing && !password) return res.status(400).json({ error: 'email, password and name are required' });
  // Optional UAE mobile — becomes a second way to sign in. ("mobile" here;
  // "phone" is already the seller application's WhatsApp field.)
  let mobile = null;
  if (String(req.body?.mobile || '').trim()) {
    mobile = normalizeUAEMobile(req.body.mobile);
    if (!mobile) return res.status(400).json({ error: 'Enter a UAE mobile number, like 05x xxx xxxx' });
    const taken = db.prepare('SELECT id FROM users WHERE phone = ?').get(mobile);
    if (taken && (!existing || taken.id !== existing.id))
      return res.status(409).json({ error: 'An account with this mobile number already exists' });
  }
  // Instagram and WhatsApp are required to apply — validated up front so a
  // failed application never leaves behind an account without a shop.
  if (wantsShop && !String(req.body.instagram || '').trim())
    return res.status(400).json({ error: 'Instagram is required for a shop application' });
  if (wantsShop && !String(req.body.phone || '').trim())
    return res.status(400).json({ error: 'A WhatsApp number is required for a shop application' });
  // Trove is Dubai & Abu Dhabi only — sellers included.
  if (wantsShop) {
    const { SERVICE_AREAS, isServiceable } = require('../service-area');
    if (!isServiceable(req.body.location))
      return res.status(400).json({ error: `Trove is currently open to makers in ${SERVICE_AREAS.join(' and ')} only` });
  }

  let userId;
  if (existing) {
    if (!wantsShop) return res.status(409).json({ error: 'An account with this email already exists' });
    const ownsAccount = req.session.userId === existing.id
      || (password && verifyPassword(password, existing.password_hash));
    if (!ownsAccount) {
      return res.status(409).json({ code: 'exists_wrong_password', error: 'An account with this email already exists' });
    }
    if (db.prepare('SELECT 1 FROM shops WHERE user_id = ?').get(existing.id)) {
      return res.status(409).json({ code: 'already_has_shop', error: 'This account already has a shop' });
    }
    userId = existing.id;
    // Buyers become sellers; an admin keeps admin (requireAdmin depends on it).
    if (existing.role === 'buyer') db.prepare("UPDATE users SET role = 'seller' WHERE id = ?").run(userId);
  } else {
    const info = db.prepare('INSERT INTO users (email, password_hash, name, role, phone) VALUES (?,?,?,?,?)')
      .run(email, hashPassword(password), name, role, mobile);
    userId = info.lastInsertRowid;
  }

  // Sellers get a shop scaffold immediately — but it starts 'pending' and only
  // appears on the storefront once the super admin approves it. The application
  // details (story, planned products, links) are stored for the review queue.
  if (wantsShop) {
    const base = slugify(shopName || name);
    let slug = base, n = 1;
    while (db.prepare('SELECT 1 FROM shops WHERE slug = ?').get(slug)) slug = `${base}-${++n}`;
    const clean = (v, max) => String(v || '').trim().slice(0, max);
    // Normalise the Instagram field to "instagram.com/handle" whether they
    // typed @handle, a bare handle, or a full URL.
    const ig = (() => {
      let v = clean(req.body.instagram, 120).replace(/^@/, '');
      if (!v) return '';
      return /instagram\.com/i.test(v) ? v.replace(/^https?:\/\//i, '') : `instagram.com/${v}`;
    })();
    // Direct entry for licensed makers: a UAE trade / e-Trader license number
    // queues the shop for the Connect rail (activated when RAIL_B_ENABLED and
    // an admin has verified the license) — they onboard on consignment
    // meanwhile, so nothing blocks them from selling.
    const licenseNumber = clean(req.body.licenseNumber, 60);
    const info = db.prepare(`INSERT INTO shops (user_id, name, slug, status, bio, location, category, pitch_products, pitch_links,
        pitch_instagram, pitch_experience, pitch_maker, pitch_channels, pitch_capacity, pitch_phone, license_number, connect_queue)
      VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, shopName || `${name}'s shop`, slug,
        clean(req.body.about, 2000), clean(req.body.location, 120),
        clean(req.body.category, 40), clean(req.body.plannedProducts, 2000), clean(req.body.links, 300),
        ig, clean(req.body.experience, 60), clean(req.body.maker, 80),
        clean(req.body.channels, 120), clean(req.body.capacity, 40), clean(req.body.phone, 40),
        licenseNumber, licenseNumber ? 1 : 0);
    // License image is saved AFTER the inserts so a failed application never
    // leaves an orphan file; a bad image must not sink the application either.
    if (licenseNumber && req.body.licenseImage) {
      try {
        const file = require('../uploads').savePrivateDataUrl(req.body.licenseImage, 'licenses', `license-${info.lastInsertRowid}`);
        db.prepare('UPDATE shops SET license_image=? WHERE id=?').run(file, info.lastInsertRowid);
      } catch (e) { console.warn('license image rejected:', e.message); }
    }
  }

  req.session.userId = userId;
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
});

// POST /api/auth/login  { email | identifier, password }
// The identifier may be an email address or a UAE mobile number.
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  const rawId = String(req.body?.identifier ?? req.body?.email ?? '').trim();
  let user, wrong = 'Wrong email or password';
  if (rawId.includes('@')) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(rawId.toLowerCase());
  } else {
    wrong = 'Wrong mobile number or password';
    const mobile = normalizeUAEMobile(rawId);
    user = mobile ? db.prepare('SELECT * FROM users WHERE phone = ?').get(mobile) : undefined;
  }
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: wrong });
  }
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

// POST /api/auth/google  { credential } — a Google Identity Services ID token.
// An existing account with that (verified) Google email signs straight in;
// otherwise a buyer account is created. Google-created accounts get a random
// unusable password — their owner signs in with Google.
router.post('/google', async (req, res) => {
  const google = require('../google-auth');
  if (!google.enabled()) return res.status(503).json({ error: 'Google sign-in is not switched on yet' });
  try {
    const g = await google.verifyIdToken(req.body?.credential);
    if (!g) return res.status(401).json({ error: 'Google could not confirm that sign-in — please try again' });
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(g.email);
    if (!user) {
      const info = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)')
        .run(g.email, hashPassword(require('crypto').randomBytes(32).toString('hex')), g.name, 'buyer');
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('google sign-in failed:', e.message);
    res.status(502).json({ error: 'Google sign-in is unavailable right now — try again in a moment' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me  -> current user + whether they have a shop
router.get('/me', requireAuth, (req, res) => {
  const shop = db.prepare('SELECT id, name, slug FROM shops WHERE user_id = ?').get(req.user.id);
  res.json({ user: publicUser(req.user), shop: shop || null });
});

module.exports = router;
