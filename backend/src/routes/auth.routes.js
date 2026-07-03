'use strict';
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, publicUser, requireAuth } = require('../middleware');

const router = express.Router();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// POST /api/auth/register
// { email, password, name, role?, shopName?,
//   about?, location?, category?, plannedProducts?, links? }  ← seller application
// A seller application with an email that already has an account attaches the
// shop to THAT account (existing buyers can become sellers) — allowed when the
// applicant is signed in as the account, or the submitted password matches it.
router.post('/register', (req, res) => {
  const { email, password, name, role = 'buyer', shopName } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
  const wantsShop = role === 'seller' || role === 'both';
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing && !password) return res.status(400).json({ error: 'email, password and name are required' });

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
    const info = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)')
      .run(email, hashPassword(password), name, role);
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
    db.prepare(`INSERT INTO shops (user_id, name, slug, status, bio, location, category, pitch_products, pitch_links)
      VALUES (?,?,?,'pending',?,?,?,?,?)`)
      .run(userId, shopName || `${name}'s shop`, slug,
        clean(req.body.about, 2000), clean(req.body.location, 120),
        clean(req.body.category, 40), clean(req.body.plannedProducts, 2000), clean(req.body.links, 300));
  }

  req.session.userId = userId;
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
});

// POST /api/auth/login  { email, password }
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
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
