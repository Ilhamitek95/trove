'use strict';
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, publicUser, requireAuth, startSession } = require('../middleware');
const validate = require('../validate');
const { normalizeUAEMobile } = require('../phone');
const accounts = require('../accounts');
const notify = require('../notify');

const router = express.Router();
const randomSecret = () => require('crypto').randomBytes(32).toString('hex');
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// POST /api/auth/register
// { email, password, name, role?, shopName?,
//   about?, location?, category?, plannedProducts?, links? }  ← seller application
// A seller application with an email that already has an account attaches the
// shop to THAT account (existing buyers can become sellers) — allowed when the
// applicant is signed in as the account, or the submitted password matches it.
// Roles a sign-up may ask for. Admin is never self-served — the only admin is
// bootstrapped from ADMIN_EMAIL in server.js.
const SIGNUP_ROLES = ['buyer', 'seller', 'both'];

router.post('/register', (req, res, next) => {
  const { password, name, shopName } = req.body || {};
  const role = req.body?.role == null ? 'buyer' : req.body.role;
  if (!SIGNUP_ROLES.includes(role)) return res.status(400).json({ error: 'Choose a buyer or seller account' });
  // Emails are identities, not prose: match and store them case-insensitively.
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
  const nameCheck = validate.shortText(name, { label: 'Your name', max: validate.LIMITS.personName });
  if (nameCheck.error) return res.status(400).json({ error: nameCheck.error });
  const wantsShop = role === 'seller' || role === 'both';
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing && !password) return res.status(400).json({ error: 'email, password and name are required' });
  if (!existing) {
    const pwErr = validate.passwordError(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
  }
  // The shop name is shown on the storefront and in the admin review queue.
  const shopNameCheck = validate.shortText(shopName, { label: 'Shop name', max: validate.LIMITS.shopName, optional: true });
  if (wantsShop && shopNameCheck.error) return res.status(400).json({ error: shopNameCheck.error });
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
  // The application's short answers are shown in the admin review queue.
  if (wantsShop) {
    const bad = validate.markupField(req.body, ['category', 'experience', 'maker', 'channels', 'capacity', 'links', 'instagram', 'phone', 'licenseNumber', 'location']);
    if (bad) return res.status(400).json({ error: "Application answers can't contain < or >" });
  }
  // Trove is Dubai & Abu Dhabi only — sellers included.
  if (wantsShop) {
    const { SERVICE_AREAS, isServiceable } = require('../service-area');
    if (!isServiceable(req.body.location))
      return res.status(400).json({ error: `Trove is currently open to makers in ${SERVICE_AREAS.join(' and ')} only` });
  }

  let userId, created = false, shopId = null;
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
      .run(email, hashPassword(password), nameCheck.value, role, mobile);
    userId = info.lastInsertRowid;
    created = true;
  }

  // Sellers get a shop scaffold immediately — but it starts 'pending' and only
  // appears on the storefront once the super admin approves it. The application
  // details (story, planned products, links) are stored for the review queue.
  if (wantsShop) {
    const displayName = shopNameCheck.value || `${nameCheck.value}'s shop`.slice(0, validate.LIMITS.shopName);
    const base = slugify(displayName) || 'shop';
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
      .run(userId, displayName, slug,
        clean(req.body.about, 2000), clean(req.body.location, 120),
        clean(req.body.category, 40), clean(req.body.plannedProducts, 2000), clean(req.body.links, 300),
        ig, clean(req.body.experience, 60), clean(req.body.maker, 80),
        clean(req.body.channels, 120), clean(req.body.capacity, 40), clean(req.body.phone, 40),
        licenseNumber, licenseNumber ? 1 : 0);
    shopId = info.lastInsertRowid;
    // License image is saved AFTER the inserts so a failed application never
    // leaves an orphan file; a bad image must not sink the application either.
    if (licenseNumber && req.body.licenseImage) {
      try {
        const file = require('../uploads').savePrivateDataUrl(req.body.licenseImage, 'licenses', `license-${info.lastInsertRowid}`);
        db.prepare('UPDATE shops SET license_image=? WHERE id=?').run(file, info.lastInsertRowid);
      } catch (e) { console.warn('license image rejected:', e.message); }
    }
  }

  // Emails are best-effort and never hold up the sign-up: a welcome with the
  // confirm-your-email link for a new account, and the application
  // received + admin alert pair for a new shop.
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (created) notify.welcomeVerify(fresh);
  if (shopId) notify.shopApplied(shopId);

  startSession(req, { userId })
    .then(() => res.status(201).json({ user: publicUser(fresh) }))
    .catch(next);
});

// POST /api/auth/login  { email | identifier, password }
// The identifier may be an email address or a UAE mobile number.
router.post('/login', (req, res, next) => {
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
  startSession(req, { userId: user.id }).then(() => res.json({ user: publicUser(user) })).catch(next);
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
      const info = db.prepare("INSERT INTO users (email, password_hash, name, role, password_set, email_verified_at) VALUES (?,?,?,?,0,datetime('now'))")
        .run(g.email, hashPassword(randomSecret()),
          String(g.name || '').replace(/[<>]/g, '').trim().slice(0, validate.LIMITS.personName) || g.email.split('@')[0], 'buyer');
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else if (!user.email_verified_at) {
      // Google has just proved who owns this inbox, while the account's
      // password was set by whoever registered it and never proved. That is
      // the pre-hijack hole: someone signs up with a victim's email, waits
      // for the victim to arrive via Google, and keeps a working password.
      // So Google counts as confirming the email, the unproven password
      // stops working (a reset link to the inbox sets a new one), and every
      // session opened with it is signed out.
      db.prepare("UPDATE users SET email_verified_at=datetime('now'), password_hash=?, password_set=0 WHERE id=?")
        .run(hashPassword(randomSecret()), user.id);
      accounts.endOtherSessions(user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    try { await startSession(req, { userId: user.id }); }
    catch (e) { console.error('google sign-in session failed:', e.message); return res.status(500).json({ error: 'Something went wrong on our side — please try again' }); }
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('google sign-in failed:', e.message);
    res.status(502).json({ error: 'Google sign-in is unavailable right now — try again in a moment' });
  }
});

/* ---------------- Password reset ----------------
 * POST /api/auth/forgot { email } — always the same neutral 200, whether or
 * not the address has an account (no account discovery). When it does, a
 * one-hour, single-use link goes to that inbox. Rate-limited with sign-in.
 * Works for Google-only accounts too: the reset simply sets a password.  */
const FORGOT_REPLY = 'If that email has a Trove account, a link to reset the password is on its way. It expires in an hour.';
router.post('/forgot', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email && email.length <= 254 && email.includes('@')) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) notify.passwordReset(user);
  }
  res.json({ ok: true, message: FORGOT_REPLY });
});

// GET /api/auth/reset?token= — is this link still good? (lets the page say
// so before the person types a new password). Spends nothing.
router.get('/reset', (req, res) => {
  const found = accounts.findToken(String(req.query.token || ''), 'reset');
  res.json({ valid: !!found });
});

// POST /api/auth/reset { token, password } — set the new password, spend the
// token, sign out every session of the account, then sign this browser in.
const BAD_LINK = 'This reset link has expired or was already used — ask for a new one.';
router.post('/reset', (req, res, next) => {
  const { token, password } = req.body || {};
  const pwErr = validate.passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const found = accounts.findToken(token, 'reset');
  if (!found || !accounts.spendToken(found.row)) return res.status(400).json({ code: 'bad_token', error: BAD_LINK });
  const { user } = found;
  // The link reached the inbox, so the email is proven as well.
  db.prepare("UPDATE users SET password_hash=?, password_set=1, email_verified_at=COALESCE(email_verified_at, datetime('now')) WHERE id=?")
    .run(hashPassword(password), user.id);
  db.prepare("UPDATE auth_tokens SET used_at=datetime('now') WHERE user_id=? AND kind='reset' AND used_at IS NULL").run(user.id);
  accounts.endOtherSessions(user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  notify.passwordChanged(fresh);
  startSession(req, { userId: user.id }, { keep: [] }).then(() => res.json({ user: publicUser(fresh) })).catch(next);
});

// POST /api/auth/password { current, password } — change it while signed in.
// A Google-only account has no password to confirm, so it may set one. Every
// other session of the account is signed out; this one carries on (on a
// fresh session id).
router.post('/password', requireAuth, (req, res, next) => {
  if (req.session.impersonatorId) return res.status(403).json({ error: 'Only the shop owner can change their password' });
  const { current, password } = req.body || {};
  const u = req.user;
  if (u.password_set !== 0 && !verifyPassword(String(current || ''), u.password_hash)) {
    return res.status(400).json({ code: 'wrong_password', error: 'Your current password is not right' });
  }
  const pwErr = validate.passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  db.prepare('UPDATE users SET password_hash=?, password_set=1 WHERE id=?').run(hashPassword(password), u.id);
  db.prepare("UPDATE auth_tokens SET used_at=datetime('now') WHERE user_id=? AND kind='reset' AND used_at IS NULL").run(u.id);
  accounts.endOtherSessions(u.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  notify.passwordChanged(fresh);
  startSession(req, { userId: u.id }).then(() => res.json({ ok: true, user: publicUser(fresh) })).catch(next);
});

/* ---------------- Email confirmation ---------------- */
// GET /api/auth/verify-email?token= — the welcome email's button. Confirms
// the address and lands on the account (or sign-in) page with a notice.
router.get('/verify-email', (req, res) => {
  const found = accounts.findToken(String(req.query.token || ''), 'verify');
  if (!found || !accounts.spendToken(found.row)) {
    const u = req.session.userId && db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(req.session.userId);
    return res.redirect(302, u && u.email_verified_at ? '/account?verified=1' : '/login?verify=expired');
  }
  db.prepare("UPDATE users SET email_verified_at=COALESCE(email_verified_at, datetime('now')) WHERE id=?").run(found.user.id);
  res.redirect(302, req.session.userId === found.user.id ? '/account?verified=1' : '/login?verified=1');
});

// POST /api/auth/verify-email/resend — send the confirm link again.
router.post('/verify-email/resend', requireAuth, (req, res) => {
  if (req.user.email_verified_at) return res.json({ ok: true, already: true });
  notify.welcomeVerify(req.user);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// POST /api/auth/stop-impersonating → leave the admin's "shop view" and
// become the admin again. Only a session that entered through
// /api/admin/impersonate carries an impersonatorId, and the stored id must
// still belong to an admin account for the switch back to happen.
router.post('/stop-impersonating', (req, res, next) => {
  const adminId = req.session.impersonatorId;
  if (!adminId) return res.status(400).json({ error: 'Not in shop view' });
  delete req.session.impersonatorId;
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  if (!admin || admin.role !== 'admin') {
    return req.session.destroy(() => res.status(403).json({ error: 'Admin account no longer exists' }));
  }
  startSession(req, { userId: admin.id }).then(() => res.json({ user: publicUser(admin) })).catch(next);
});

// GET /api/auth/me  -> current user + whether they have a shop or a
// service-provider profile (every page's boot reads this one shape).
router.get('/me', requireAuth, (req, res) => {
  const shop = db.prepare('SELECT id, name, slug FROM shops WHERE user_id = ?').get(req.user.id);
  const provider = db.prepare('SELECT id, name, slug, status FROM service_providers WHERE user_id = ?').get(req.user.id);
  res.json({ user: publicUser(req.user), shop: shop || null, provider: provider || null, impersonating: !!req.session.impersonatorId });
});

module.exports = router;
