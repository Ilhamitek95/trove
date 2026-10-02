'use strict';
/**
 * Second sign-in step for the admin account (October 2026 review, F037).
 *
 * The admin can see every customer's address and phone, download decrypted
 * IBANs, issue refunds and act as any shop, so a password (or a Google
 * sign-in) alone is not enough. After the first step succeeds for an admin:
 *
 *   1. the session holds only a CHALLENGE (no userId — nothing is signed in);
 *      a 6-digit code goes to the admin's own email via email.js. When email
 *      is not configured (local dev) the code is printed to the server log.
 *   2. POST /api/auth/admin-code { code, trust } finishes the sign-in on a
 *      fresh session stamped adminVerifiedFor/adminVerifiedAt. Codes last 10
 *      minutes and allow 5 tries; 'trust' remembers this browser for 30 days
 *      (httpOnly cookie, only its SHA-256 stored in admin_devices), so a
 *      trusted browser skips step 2 next time. A password change or reset
 *      forgets every trusted browser.
 *   3. Admin sessions — and shop view, which runs on the admin's say-so —
 *      last ADMIN_SESSION_HOURS (default 12), enforced on the server.
 *
 * RECOVERY (the owner can never be locked out): set ADMIN_2FA=off in the
 * Render environment and redeploy — the admin signs in with the password
 * alone (and sessions go back to 14 days). Remove it again afterwards. The
 * password itself can always be reset from the sign-in page.
 */
const crypto = require('crypto');
const db = require('./db');

const SESSION_KEYS = ['adminVerifiedFor', 'adminVerifiedAt'];
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEVICE_DAYS = 30;
const DEVICE_COOKIE = 'trove_admin_device';

const enabled = () => !['0', 'off', 'false', 'no'].includes(String(process.env.ADMIN_2FA || '').trim().toLowerCase());
const sessionMs = () => {
  const h = Number(process.env.ADMIN_SESSION_HOURS);
  return (Number.isFinite(h) && h >= 1 && h <= 72 ? h : 12) * 3600 * 1000;
};
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const codeHash = (userId, code) => sha(`${userId}:${code}:${process.env.SESSION_SECRET || 'dev-secret-change-me'}`);

/** a••••@gmail.com — enough for the admin to recognise their inbox. */
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

/** Is this browser one the admin trusted (and still within 30 days)? */
function trustedDevice(req, user) {
  const token = readCookie(req, DEVICE_COOKIE);
  if (!token || token.length > 200) return false;
  const row = db.prepare('SELECT id FROM admin_devices WHERE token_hash=? AND user_id=? AND expires_at > ?').get(sha(token), user.id, Date.now());
  if (!row) return false;
  db.prepare("UPDATE admin_devices SET last_used_at=datetime('now') WHERE id=?").run(row.id);
  return true;
}

function trustDevice(res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO admin_devices (user_id, token_hash, expires_at) VALUES (?,?,?)')
    .run(user.id, sha(token), Date.now() + DEVICE_DAYS * 86400000);
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/api/auth',
    secure: process.env.NODE_ENV === 'production',
    maxAge: DEVICE_DAYS * 86400000,
  });
}

/** Forget every trusted browser of this account (password change / reset). */
const forgetDevices = (userId) => db.prepare('DELETE FROM admin_devices WHERE user_id=?').run(userId).changes;

/** Does signing this user in need the emailed code first? */
const needsCode = (req, user) => enabled() && !!user && user.role === 'admin' && !trustedDevice(req, user);

/** Fields that mark a fully signed-in admin session. */
const verifiedFields = (user) => ({ userId: user.id, adminVerifiedFor: user.id, adminVerifiedAt: Date.now() });

/** For tests only: the last code issued (never kept outside NODE_ENV=test). */
let lastCode = null;

/**
 * Start the second step: a fresh session holding only the challenge, and the
 * code on its way to the admin's inbox. Resolves { needsCode, sentTo }.
 */
async function startChallenge(req, user, { startSession }) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  if (process.env.NODE_ENV === 'test') lastCode = code;
  await startSession(req, {
    adminChallenge: { userId: user.id, hash: codeHash(user.id, code), expires: Date.now() + CODE_TTL_MS, attempts: 0 },
  }, { keep: [] });
  sendCode(user, code);
  return { needsCode: true, sentTo: maskEmail(user.email) };
}

function sendCode(user, code) {
  const email = require('./email');
  if (!email.enabled()) {
    // Local dev / no email configured: the code goes to the server log.
    console.log(`admin sign-in code for ${user.email}: ${code} (email not configured)`);
  }
  const msg = email.adminSignInCode({ name: user.name, code, minutes: CODE_TTL_MS / 60000 });
  Promise.resolve().then(() => email.send({ to: user.email, ...msg }))
    .catch((e) => console.error('admin sign-in code email failed:', e.message));
}

/** A new code for the challenge already on this session (same rules). */
function resend(req) {
  const ch = req.session && req.session.adminChallenge;
  if (!ch) return null;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(ch.userId);
  if (!user || user.role !== 'admin') return null;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  if (process.env.NODE_ENV === 'test') lastCode = code;
  Object.assign(ch, { hash: codeHash(user.id, code), expires: Date.now() + CODE_TTL_MS, attempts: 0 });
  sendCode(user, code);
  return { needsCode: true, sentTo: maskEmail(user.email) };
}

/**
 * Check a typed code against the session's challenge. Returns
 * { user } on success, or { error, status, code } on failure. Five wrong
 * tries (or an expired code) end the challenge — sign in again.
 */
function check(req, typed) {
  const ch = req.session && req.session.adminChallenge;
  if (!ch) return { status: 400, code: 'no_challenge', error: 'Your sign-in has timed out — please sign in again' };
  if (ch.expires < Date.now() || ch.attempts >= MAX_ATTEMPTS) {
    delete req.session.adminChallenge;
    return { status: 400, code: 'no_challenge', error: 'That code has expired — please sign in again for a new one' };
  }
  const clean = String(typed || '').replace(/\s+/g, '');
  const ok = /^\d{6}$/.test(clean) && crypto.timingSafeEqual(Buffer.from(codeHash(ch.userId, clean)), Buffer.from(ch.hash));
  if (!ok) {
    ch.attempts += 1;
    const left = MAX_ATTEMPTS - ch.attempts;
    if (left <= 0) delete req.session.adminChallenge;
    return { status: 400, code: left <= 0 ? 'no_challenge' : 'wrong_code',
      error: left <= 0 ? 'Too many wrong codes — please sign in again for a new one' : `That code is not right — ${left} ${left === 1 ? 'try' : 'tries'} left` };
  }
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(ch.userId);
  if (!user || user.role !== 'admin') { delete req.session.adminChallenge; return { status: 400, code: 'no_challenge', error: 'Please sign in again' }; }
  return { user };
}

/** Keep an admin session's cookie no longer than its server-side lifetime. */
function capCookie(req) {
  const at = req.session && req.session.adminVerifiedAt;
  if (!enabled() || !at || !req.session.cookie) return;
  req.session.cookie.maxAge = Math.max(1000, at + sessionMs() - Date.now());
}

/**
 * App-level guard, right after the session middleware. An admin session (or
 * shop view, which runs on the admin's authority) that never completed the
 * second step — e.g. one opened before this shipped — or has outlived
 * ADMIN_SESSION_HOURS is signed out: every route then sees no user.
 */
function guard(req, _res, next) {
  const s = req.session;
  if (!enabled() || !s || !s.userId) return next();
  let adminId = s.impersonatorId || null;
  if (!adminId) {
    const u = db.prepare('SELECT role FROM users WHERE id=?').get(s.userId);
    if (u && u.role === 'admin') adminId = s.userId;
  }
  if (!adminId) return next();
  const fresh = s.adminVerifiedFor === adminId && Number(s.adminVerifiedAt) > Date.now() - sessionMs();
  if (!fresh) {
    for (const k of ['userId', 'impersonatorId', ...SESSION_KEYS]) delete s[k];
  }
  next();
}

module.exports = {
  SESSION_KEYS, DEVICE_COOKIE, MAX_ATTEMPTS, enabled, sessionMs, maskEmail,
  needsCode, startChallenge, resend, check, verifiedFields, trustDevice, forgetDevices, trustedDevice,
  capCookie, guard,
  _lastCode: () => (process.env.NODE_ENV === 'test' ? lastCode : null),
};
