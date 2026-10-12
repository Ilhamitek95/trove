'use strict';
const express = require('express');
const db = require('../db');
const { hashPasswordAsync, verifyPasswordAsync, checkPasswordAsync, publicUser, requireAuth, startSession } = require('../middleware');
const validate = require('../validate');
const { normalizeUAEMobile } = require('../phone');
const accounts = require('../accounts');
const notify = require('../notify');
const guestOrders = require('../guest-orders');
const twofa = require('../admin-2fa');

const router = express.Router();

/**
 * Sign a user in after the first step (password or Google). An admin on an
 * untrusted browser gets the emailed code instead (admin-2fa.js) and
 * `{ needsCode, sentTo }` comes back; everyone else is signed in on a fresh
 * session. Resolves the JSON body to send.
 */
async function signInAfterFirstStep(req, user, extra = {}) {
  if (twofa.needsCode(req, user)) return { ...(await twofa.startChallenge(req, user, { startSession })), ...extra };
  const fields = user.role === 'admin' && twofa.enabled() ? twofa.verifiedFields(user) : { userId: user.id };
  await startSession(req, fields);
  return { user: publicUser(user), ...extra };
}
const randomSecret = () => require('crypto').randomBytes(32).toString('hex');
const { slugify } = require('../slug'); // the URL rule, for stored slugs too (F375)

// POST /api/auth/register
// { email, password, name, role?, shopName?,
//   about?, location?, category?, plannedProducts?, links? }  ← seller application
// A seller application with an email that already has an account attaches the
// shop to THAT account (existing buyers can become sellers) — allowed when the
// applicant is signed in as the account, or the submitted password matches it.
// Roles a sign-up may ask for. Admin is never self-served — the only admin is
// bootstrapped from ADMIN_EMAIL in server.js.
const SIGNUP_ROLES = ['buyer', 'seller', 'both'];

router.post('/register', async (req, res, next) => { try {
  const { password, name, shopName } = req.body || {};
  const role = req.body?.role == null ? 'buyer' : req.body.role;
  if (!SIGNUP_ROLES.includes(role)) return res.status(400).json({ error: 'Choose a buyer or seller account' });
  // Emails are identities, not prose: match and store them case-insensitively.
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
  const nameCheck = validate.shortText(name, { label: 'Your name', max: validate.LIMITS.personName });
  if (nameCheck.error) return res.status(400).json({ error: nameCheck.error });
  const wantsShop = role === 'seller' || role === 'both';
  // The slow password work (async bcrypt, F276) happens HERE, before the
  // checks and writes below, which then run in one go: no other request
  // (a double-click on Apply) can slip in between a check and its write.
  const before = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  let passwordMatches = false;
  let newHash = null;
  if (before) {
    if (wantsShop && password && req.session.userId !== before.id) passwordMatches = await verifyPasswordAsync(password, before.password_hash);
  } else if (!validate.emailError(email) && !validate.passwordError(password)) {
    newHash = await hashPasswordAsync(password);
  }
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // An account that appeared or vanished during the pause: start again.
  if (!!existing !== !!before || (existing && existing.id !== before.id)) return res.status(409).json({ error: 'Something changed while we were checking — please try again' });
  // A NEW account's address must look like one (an existing account keeps
  // working with whatever it was created with).
  if (!existing && validate.emailError(email)) return res.status(400).json({ error: validate.EMAIL_ERROR });
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
    // A new account is unconfirmed, so it only ever gets a free number (F203,
    // accounts.mobileClaim); an existing account's number is not changed here.
    if (!accounts.mobileClaim(mobile, existing || null).ok) return res.status(409).json({ error: 'An account with this mobile number already exists' });
  }
  // A way to see the work (Instagram, or a website/portfolio for makers who
  // sell without one — F382) and WhatsApp are required to apply — validated
  // up front so a failed application never leaves behind an account without a shop.
  if (wantsShop && !String(req.body.instagram || '').trim() && !String(req.body.links || '').trim())
    return res.status(400).json({ error: 'Share your Instagram or a website so our curation team can see your work' });
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
    const ownsAccount = req.session.userId === existing.id || passwordMatches;
    if (!ownsAccount) {
      return res.status(409).json({ code: 'exists_wrong_password', error: 'An account with this email already exists' });
    }
    // The admin account never signs in through a form that skips its second
    // step: apply while signed in as the admin, or not at all.
    if (existing.role === 'admin' && req.session.userId !== existing.id) {
      return res.status(409).json({ code: 'sign_in_required', error: 'Sign in first, then apply' });
    }
    if (db.prepare('SELECT 1 FROM shops WHERE user_id = ?').get(existing.id)) {
      return res.status(409).json({ code: 'already_has_shop', error: 'This account already has a shop' });
    }
    userId = existing.id;
    // Buyers become sellers; an admin keeps admin (requireAdmin depends on it).
    if (existing.role === 'buyer') db.prepare("UPDATE users SET role = 'seller' WHERE id = ?").run(userId);
  } else {
    if (!newHash) return res.status(400).json({ error: validate.passwordError(password) || 'email, password and name are required' });
    const info = db.prepare('INSERT INTO users (email, password_hash, name, role, phone) VALUES (?,?,?,?,?)')
      .run(email, newHash, nameCheck.value, role, mobile);
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
        // Encrypted at rest like Emirates ID photos (F259); plain only where
        // no PAYOUT_ENC_KEY is configured (local development).
        const up = require('../uploads');
        const file = require('../crypto').hasKey()
          ? up.saveEncryptedPrivate(req.body.licenseImage, 'licenses', `license-${info.lastInsertRowid}`).file
          : up.savePrivateDataUrl(req.body.licenseImage, 'licenses', `license-${info.lastInsertRowid}`);
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

  await startSession(req, { userId });
  res.status(201).json({ user: publicUser(fresh), created });
} catch (e) { next(e); } });

// POST /api/auth/login  { email | identifier, password }
// The identifier may be an email address or a UAE mobile number.
//   - the password check is async bcrypt (F276) and takes as long for an
//     unknown identifier as for a real one (a dummy hash, F201);
//   - each identity has its own budget of wrong passwords (F208, accounts.js);
//   - a mobile number signs in only for an account whose email is confirmed
//     (numbers are not SMS-checked yet, F203).
const PAUSED = 'Too many wrong passwords for this account. Try again in 15 minutes, or reset your password.';
router.post('/login', async (req, res, next) => { try {
  const { password } = req.body || {};
  const rawId = String(req.body?.identifier ?? req.body?.email ?? '').trim();
  let user, wrong = 'Wrong email or password';
  const viaMobile = !rawId.includes('@');
  if (!viaMobile) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(rawId.toLowerCase());
  } else {
    wrong = 'Wrong mobile number or password';
    const mobile = normalizeUAEMobile(rawId);
    user = mobile ? db.prepare('SELECT * FROM users WHERE phone = ?').get(mobile) : undefined;
  }
  const key = accounts.loginKey(user, rawId);
  const wait = accounts.loginPausedFor(key);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ code: 'account_paused', error: PAUSED });
  }
  const ok = await checkPasswordAsync(password, user);
  if (!ok) {
    // The failure that starts a pause tells the account owner (once per pause).
    if (accounts.recordLoginFailure(key) && user) notify.signInAttempts(user);
    return res.status(401).json({ error: wrong });
  }
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!user) return res.status(401).json({ error: wrong });
  if (viaMobile && !user.email_verified_at) {
    return res.status(403).json({ code: 'confirm_email_first', error: 'Your mobile number works for signing in once your email is confirmed. For now, sign in with your email address.' });
  }
  accounts.clearLoginFailures(user);
  guestOrders.claimQuietly(user); // only once the email is confirmed
  res.json(await signInAfterFirstStep(req, user));
} catch (e) { next(e); } });

// POST /api/auth/admin-code { code, trust? } — the admin's second step. On
// success the admin is signed in on a fresh session; trust=true remembers
// this browser for 30 days.
router.post('/admin-code', (req, res, next) => {
  const r = twofa.check(req, (req.body || {}).code);
  if (r.error) return res.status(r.status).json({ code: r.code, error: r.error });
  if ((req.body || {}).trust === true) twofa.trustDevice(res, r.user);
  startSession(req, twofa.verifiedFields(r.user), { keep: [] })
    .then(() => res.json({ user: publicUser(r.user) }))
    .catch(next);
});

// POST /api/auth/admin-code/resend — a new code for the sign-in in progress.
router.post('/admin-code/resend', (req, res) => {
  const r = twofa.resend(req);
  if (!r) return res.status(400).json({ code: 'no_challenge', error: 'Your sign-in has timed out — please sign in again' });
  res.json(r);
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
    // An unusable random password, hashed before the account is looked up
    // (async bcrypt, F276) so the lookup and its write run in one go.
    const placeholder = await hashPasswordAsync(randomSecret());
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(g.email);
    // Whether this sign-in opened the account: the page reports a sign-up or
    // a log-in to analytics (no personal data — just which of the two).
    const created = !user;
    if (!user) {
      const info = db.prepare("INSERT INTO users (email, password_hash, name, role, password_set, email_verified_at) VALUES (?,?,?,?,0,datetime('now'))")
        .run(g.email, placeholder,
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
        .run(placeholder, user.id);
      accounts.endOtherSessions(user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    guestOrders.claimQuietly(user); // Google has proven the inbox
    let body;
    try { body = await signInAfterFirstStep(req, user, { created }); }
    catch (e) { console.error('google sign-in session failed:', e.message); return res.status(500).json({ error: 'Something went wrong on our side — please try again' }); }
    res.json(body);
  } catch (e) {
    console.error('google sign-in failed:', e.message);
    res.status(502).json({ error: 'Google sign-in is unavailable right now — try again in a moment' });
  }
});

/* ---------------- Password reset ----------------
 * POST /api/auth/forgot { email } — always the same neutral 200, whether or
 * not the address has an account (no account discovery). When it does, a
 * one-hour, single-use link goes to that inbox. Rate-limited with sign-in,
 * and per account (F207): one email every two minutes at most — the link
 * already sent stays valid meanwhile — and five a day.
 * Works for Google-only accounts too: the reset simply sets a password.  */
const FORGOT_REPLY = 'If that email has a Trove account, a link to reset the password is on its way. It expires in an hour.';
router.post('/forgot', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email && email.length <= 254 && email.includes('@')) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user && accounts.resetAllowed(user.id)) notify.passwordReset(user);
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
router.post('/reset', async (req, res, next) => { try {
  const { token, password } = req.body || {};
  const pwErr = validate.passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!accounts.findToken(token, 'reset')) return res.status(400).json({ code: 'bad_token', error: BAD_LINK });
  // Hash first (async, F276); the token is spent and the password saved after, in one go.
  const hash = await hashPasswordAsync(password);
  const found = accounts.findToken(token, 'reset');
  if (!found || !accounts.spendToken(found.row)) return res.status(400).json({ code: 'bad_token', error: BAD_LINK });
  const { user } = found;
  // The link reached the inbox, so the email is proven as well.
  db.prepare("UPDATE users SET password_hash=?, password_set=1, email_verified_at=COALESCE(email_verified_at, datetime('now')) WHERE id=?")
    .run(hash, user.id);
  db.prepare("UPDATE auth_tokens SET used_at=datetime('now') WHERE user_id=? AND kind='reset' AND used_at IS NULL").run(user.id);
  accounts.endOtherSessions(user.id);
  accounts.clearLoginFailures(user); // a paused sign-in (F208) is lifted by the reset
  twofa.forgetDevices(user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  guestOrders.claimQuietly(fresh); // the reset link proved the inbox
  notify.passwordChanged(fresh);
  // The admin still finishes with the emailed code (the link only proved the inbox).
  if (twofa.needsCode(req, fresh)) return res.json(await twofa.startChallenge(req, fresh, { startSession }));
  await startSession(req, { userId: user.id }, { keep: [] });
  res.json({ user: publicUser(fresh) });
} catch (e) { next(e); } });

// POST /api/auth/password { current, password } — change it while signed in.
// A Google-only account has no password to confirm, so it may set one. Every
// other session of the account is signed out; this one carries on (on a
// fresh session id).
router.post('/password', requireAuth, async (req, res, next) => { try {
  if (req.session.impersonatorId) return res.status(403).json({ error: 'Only the shop owner can change their password' });
  const { current, password } = req.body || {};
  const u = req.user;
  if (u.password_set !== 0 && !(await verifyPasswordAsync(current, u.password_hash))) {
    return res.status(400).json({ code: 'wrong_password', error: 'Your current password is not right' });
  }
  const pwErr = validate.passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const hash = await hashPasswordAsync(password);
  db.prepare('UPDATE users SET password_hash=?, password_set=1 WHERE id=?').run(hash, u.id);
  db.prepare("UPDATE auth_tokens SET used_at=datetime('now') WHERE user_id=? AND kind='reset' AND used_at IS NULL").run(u.id);
  accounts.endOtherSessions(u.id);
  accounts.clearLoginFailures(u);
  twofa.forgetDevices(u.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  notify.passwordChanged(fresh);
  await startSession(req, { userId: u.id });
  res.json({ ok: true, user: publicUser(fresh) });
} catch (e) { next(e); } });

// POST /api/auth/sessions/end-others — 'Sign out of all other devices'
// (F439): ends every other session of this account, keeps this one. Not in
// shop view (the admin would sign the maker out everywhere).
router.post('/sessions/end-others', requireAuth, (req, res) => {
  if (req.session.impersonatorId) return res.status(403).json({ error: 'Only the account owner can do this — it is not available in shop view' });
  const ended = accounts.endOtherSessions(req.user.id, req.sessionID);
  res.json({ ok: true, ended });
});

/* ---------------- Email confirmation ----------------
 * GET /api/auth/verify-email?token= — the welcome email's button. It does NOT
 * confirm anything by itself (F200): mail scanners and link previews open
 * every link in an email, which used to confirm an account someone else had
 * opened in the inbox owner's name. It shows a small page with a 'Confirm my
 * email' button instead; the button's POST confirms and lands on the account
 * (or sign-in) page with a notice, as the link used to.                   */
const verifyLanding = (req, userId) => {
  const u = req.session.userId && db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(req.session.userId);
  if (userId) return req.session.userId === userId ? '/account?verified=1' : '/login?verified=1';
  return u && u.email_verified_at ? '/account?verified=1' : '/login?verify=expired';
};
router.get('/verify-email', (req, res) => {
  const token = String(req.query.token || '');
  const found = accounts.findToken(token, 'verify');
  if (!found) return res.redirect(302, verifyLanding(req));
  if (found.user.email_verified_at) { accounts.spendToken(found.row); return res.redirect(302, verifyLanding(req, found.user.id)); }
  const lang = found.user.lang === 'ar' ? 'ar' : 'en';
  res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex, nofollow').set('Referrer-Policy', 'no-referrer');
  res.type('html').send(require('../verify-page').render({ lang, token, email: found.user.email }));
});
router.post('/verify-email', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const found = accounts.findToken(String((req.body && req.body.token) || ''), 'verify');
  if (!found || !accounts.spendToken(found.row)) return res.redirect(303, verifyLanding(req));
  db.prepare("UPDATE users SET email_verified_at=COALESCE(email_verified_at, datetime('now')) WHERE id=?").run(found.user.id);
  guestOrders.claimQuietly(found.user.id); // orders placed as a guest with this email
  res.redirect(303, verifyLanding(req, found.user.id));
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
function sessionShape(req) {
  // The admin's dashboard shop is the Trove Collection (house mode, middleware.js).
  const own = require('../middleware').dashboardShopFor(req.user);
  const shop = own ? { id: own.id, name: own.name, slug: own.slug, ...(own.is_house ? { isHouse: true } : {}) } : null;
  const provider = db.prepare('SELECT id, name, slug, status FROM service_providers WHERE user_id = ?').get(req.user.id);
  return { user: publicUser(req.user), shop: shop || null, provider: provider || null, impersonating: !!req.session.impersonatorId };
}
router.get('/me', requireAuth, (req, res) => res.json(sessionShape(req)));

// GET /api/auth/session -> the same shape when signed in, and a plain 200
// { user: null } when not. Every public page asks this on load; a signed-out
// visitor is the normal case, not an error, so it must not answer 401 (the
// browser logs every 401 as a console error).
router.get('/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = req.session.userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) : null;
  if (!user) return res.json({ user: null, shop: null, provider: null, impersonating: false });
  req.user = user;
  res.json(sessionShape(req));
});

module.exports = router;
