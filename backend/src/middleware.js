'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');

const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

// Strip sensitive fields before sending a user to the client.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in required' });
  req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!req.user) return res.status(401).json({ error: 'Session expired' });
  next();
}

// Requires the user to own a shop (role seller/both). Attaches req.shop.
function requireSeller(req, res, next) {
  requireAuth(req, res, () => {
    const shop = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(req.user.id);
    if (!shop) return res.status(403).json({ error: 'No shop on this account' });
    req.shop = shop;
    next();
  });
}

module.exports = { hashPassword, verifyPassword, publicUser, requireAuth, requireSeller };
