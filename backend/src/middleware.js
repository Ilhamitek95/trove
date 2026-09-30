'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');

const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

// Strip sensitive fields before sending a user to the client.
function publicUser(u) {
  if (!u) return null;
  // Their own sign-in mobile — used to prefill the courier field at checkout.
  // emailVerified: the owner confirmed the address (welcome link, a reset or
  // Google). hasPassword: false for Google-only accounts, whose stored hash
  // is a random placeholder — the account page offers "Set a password".
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, phone: u.phone || null,
    emailVerified: !!u.email_verified_at, hasPassword: u.password_set !== 0,
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in required' });
  req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!req.user) return res.status(401).json({ error: 'Session expired' });
  next();
}

/**
 * The shop this account runs from the seller dashboard. A maker: their own.
 * An admin: the Trove Collection (shops.is_house = 1) — "house mode", the
 * owner running Trove's own line as themselves, still an admin everywhere
 * else (no impersonation, no second account). An admin without a house shop
 * falls back to any shop they own.
 */
function dashboardShopFor(user) {
  if (user && user.role === 'admin') {
    const house = db.prepare('SELECT * FROM shops WHERE is_house = 1 ORDER BY id LIMIT 1').get();
    if (house) return house;
  }
  return user ? db.prepare('SELECT * FROM shops WHERE user_id = ? ORDER BY id LIMIT 1').get(user.id) : null;
}

// Requires a shop to run (see dashboardShopFor). Attaches req.shop, and
// req.houseMode when it is the Trove Collection.
function requireSeller(req, res, next) {
  requireAuth(req, res, () => {
    const shop = dashboardShopFor(req.user);
    if (!shop) return res.status(403).json({ error: 'No shop on this account' });
    req.shop = shop;
    req.houseMode = !!shop.is_house;
    next();
  });
}

// Requires the user to have a service-provider profile (any status — like
// sellers, providers can prepare their listings while the application is
// reviewed; only approved providers appear publicly). Attaches req.provider.
function requireProvider(req, res, next) {
  requireAuth(req, res, () => {
    const provider = db.prepare('SELECT * FROM service_providers WHERE user_id = ?').get(req.user.id);
    if (!provider) return res.status(403).json({ error: 'No provider profile on this account' });
    req.provider = provider;
    next();
  });
}

// Requires an admin (the trove platform owner) — gates the payout endpoints.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

/**
 * Swap the session for a brand-new one (new id, new cookie) and write
 * `fields` onto it — used on every privilege change (sign-in, sign-up, Google,
 * admin shop view in and out) so a session id planted before the change can
 * never ride along after it (session fixation). `keep` names the few values
 * that must survive, e.g. the demo checkout's pendingOrderId, which the
 * confirmation page's create-an-account offer still needs.
 */
function startSession(req, fields, { keep = ['pendingOrderId'] } = {}) {
  const carried = {};
  for (const k of keep) if (req.session && req.session[k] !== undefined) carried[k] = req.session[k];
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, carried, fields);
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

module.exports = { startSession, hashPassword, verifyPassword, publicUser, requireAuth, requireSeller, requireProvider, requireAdmin, dashboardShopFor };
