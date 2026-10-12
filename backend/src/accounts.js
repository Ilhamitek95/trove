'use strict';
/**
 * Account recovery helpers: single-use emailed tokens (password reset and
 * email confirmation) and "sign out everywhere else".
 *
 * A token is 32 random bytes, sent once in an email link. Only its SHA-256
 * is stored, so the database alone can't be used to reset anyone's password.
 * Issuing a new token of the same kind retires the older unused ones, so only
 * the latest email works.
 */
const crypto = require('crypto');
const db = require('./db');

const HOUR = 60 * 60 * 1000;
const TTL = { reset: HOUR, verify: 7 * 24 * HOUR };

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Create a token for the user and return the raw value (for the email link). */
function issueToken(user, kind, now = Date.now()) {
  if (!TTL[kind]) throw new Error(`unknown token kind ${kind}`);
  const token = crypto.randomBytes(32).toString('base64url');
  db.transaction(() => {
    db.prepare("UPDATE auth_tokens SET used_at=datetime('now') WHERE user_id=? AND kind=? AND used_at IS NULL").run(user.id, kind);
    db.prepare('INSERT INTO auth_tokens (user_id, kind, token_hash, email, expires_at) VALUES (?,?,?,?,?)')
      .run(user.id, kind, hashToken(token), user.email, now + TTL[kind]);
  })();
  return token;
}

/**
 * Look a token up without spending it. Returns { row, user } or null when it
 * is unknown, used, expired, or was sent to an address the account no longer
 * has.
 */
function findToken(token, kind, now = Date.now()) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash=? AND kind=?').get(hashToken(token), kind);
  if (!row || row.used_at || row.expires_at < now) return null;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  if (!user || user.email !== row.email) return null;
  return { row, user };
}

/** Spend a token: true only for the one caller that marks it used. */
function spendToken(row) {
  return db.prepare("UPDATE auth_tokens SET used_at=datetime('now') WHERE id=? AND used_at IS NULL").run(row.id).changes === 1;
}

/**
 * End every stored session of this user except `keepSid` (the one making the
 * change, if any). Sessions live as JSON in the sessions table; an admin in
 * "shop view" of this account is a session with userId = this user too, and
 * is signed out with the rest. A session this user left in shop view
 * (impersonatorId = this user) is ended too: its 'Back to admin' would
 * otherwise hand an old session full admin powers after a password change.
 */
function endOtherSessions(userId, keepSid = null) {
  return db.prepare(`DELETE FROM sessions
    WHERE (json_extract(sess, '$.userId') = ? OR json_extract(sess, '$.impersonatorId') = ?)
      AND sid IS NOT ?`)
    .run(userId, userId, keepSid).changes;
}

/* ---------------- reset-email brakes (F207) ----------------
 * Someone scripting 'Forgot your password?' for a maker's address must not
 * flood the inbox, nor keep cancelling the link the maker is about to open:
 * at most one reset email per account every RESET_COOLDOWN_MS (the link
 * already sent stays valid meanwhile) and RESET_DAILY_CAP a day. The page's
 * answer never changes (no account discovery).                            */
const RESET_COOLDOWN_MS = 2 * 60 * 1000;
const RESET_DAILY_CAP = 5;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Whether a new reset email may go to this account now. */
function resetAllowed(userId, now = Date.now()) {
  const day = db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id=? AND kind='reset' AND created_at > ?").get(userId, sqlTime(now - 24 * HOUR)).n;
  if (day >= RESET_DAILY_CAP) return false;
  const recent = db.prepare("SELECT 1 FROM auth_tokens WHERE user_id=? AND kind='reset' AND used_at IS NULL AND expires_at > ? AND created_at > ?")
    .get(userId, now, sqlTime(now - RESET_COOLDOWN_MS));
  return !recent;
}

/** Hourly housekeeping (F472): emailed links that expired over a month ago. */
function purgeOldTokens(now = Date.now()) {
  return db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now - 30 * 24 * HOUR).changes;
}

/* ---------------- per-account sign-in brake (F208/F276) ----------------
 * The IP limiter (traffic.js) can't stop guesses spread over many addresses,
 * so each sign-in identity also has its own budget: LOGIN_MAX_FAILURES wrong
 * passwords in LOGIN_WINDOW_MS, then sign-in for it pauses until the oldest
 * failure ages out (a reset link still works at any time, and a successful
 * reset or password change lifts the pause). The key is the account when
 * there is one, else the typed identifier, so an unknown address pauses the
 * same way and the answer reveals nothing. In memory: one process, and a
 * restart only ever lifts a pause early.                                   */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // key → [timestamps]
const loginKey = (user, identifier) => (user ? `u:${user.id}` : `id:${String(identifier || '').trim().toLowerCase()}`);
function recentFailures(key, now) {
  const list = (loginFailures.get(key) || []).filter((t) => t > now - LOGIN_WINDOW_MS);
  if (list.length) loginFailures.set(key, list); else loginFailures.delete(key);
  return list;
}
/** Seconds until this identity may try again, or 0 when it may now. */
function loginPausedFor(key, now = Date.now()) {
  const list = recentFailures(key, now);
  if (list.length < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((list[0] + LOGIN_WINDOW_MS - now) / 1000));
}
/** Record a wrong password; true when this failure is the one that starts the pause. */
function recordLoginFailure(key, now = Date.now()) {
  const list = recentFailures(key, now);
  list.push(now);
  loginFailures.set(key, list);
  if (loginFailures.size > 50000) { // a flood of made-up identifiers never grows memory without bound
    for (const k of loginFailures.keys()) { loginFailures.delete(k); if (loginFailures.size <= 25000) break; }
  }
  return list.length === LOGIN_MAX_FAILURES;
}
function clearLoginFailures(user) { if (user) loginFailures.delete(loginKey(user)); }

/* ---------------- sign-in mobile numbers (F203) ----------------
 * There is no SMS/WhatsApp code yet, so nobody has proved they own a number.
 * Until there is: a number signs in only for an account whose email is
 * confirmed (auth.routes.js login), and a number held by an account that
 * never confirmed its email does not block an account that has — the
 * unconfirmed holder simply loses it. Owner decision pending: an SMS code
 * provider, after which numbers are confirmed properly.                    */
/** Whether `mobile` may go on `claimer` (a user row, or null for a new account): { ok, takeFrom }. */
function mobileClaim(mobile, claimer) {
  const holder = db.prepare('SELECT id, email_verified_at FROM users WHERE phone = ?').get(mobile);
  if (!holder || (claimer && holder.id === claimer.id)) return { ok: true, takeFrom: null };
  if (!holder.email_verified_at && claimer && claimer.email_verified_at) return { ok: true, takeFrom: holder.id };
  return { ok: false, takeFrom: null };
}
/** Clear the number from the account that loses it (run in the same transaction as the new holder's save). */
function releaseMobile(userId) {
  if (userId) db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(userId);
}

/** The public site address for links in emails. */
const siteUrl = () => (process.env.PUBLIC_URL || String(process.env.CLIENT_URL || '').split(',')[0] || 'https://troveathome.com').trim().replace(/\/+$/, '');

/** Who hears about new applications: ADMIN_EMAIL, else the first admin. */
function adminEmail() {
  const env = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (env) return env;
  const row = db.prepare("SELECT email FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  return row ? row.email : null;
}

module.exports = {
  TTL, hashToken, issueToken, findToken, spendToken, endOtherSessions, siteUrl, adminEmail,
  resetAllowed, purgeOldTokens, RESET_COOLDOWN_MS, RESET_DAILY_CAP, mobileClaim, releaseMobile,
  loginKey, loginPausedFor, recordLoginFailure, clearLoginFailures, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS,
  _resetLoginFailures: () => loginFailures.clear(),
};
