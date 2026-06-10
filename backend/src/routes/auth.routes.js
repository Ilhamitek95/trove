'use strict';
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, publicUser, requireAuth } = require('../middleware');

const router = express.Router();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// POST /api/auth/register  { email, password, name, role?, shopName? }
router.post('/register', (req, res) => {
  const { email, password, name, role = 'buyer', shopName } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'An account with this email already exists' });

  const info = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)')
    .run(email, hashPassword(password), name, role);
  const userId = info.lastInsertRowid;

  // Sellers get a shop scaffold immediately.
  if (role === 'seller' || role === 'both') {
    const base = slugify(shopName || name);
    let slug = base, n = 1;
    while (db.prepare('SELECT 1 FROM shops WHERE slug = ?').get(slug)) slug = `${base}-${++n}`;
    db.prepare('INSERT INTO shops (user_id, name, slug) VALUES (?,?,?)').run(userId, shopName || `${name}'s shop`, slug);
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
