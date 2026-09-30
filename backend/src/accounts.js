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
 * is signed out with the rest.
 */
function endOtherSessions(userId, keepSid = null) {
  return db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid IS NOT ?")
    .run(userId, keepSid).changes;
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

module.exports = { TTL, hashToken, issueToken, findToken, spendToken, endOtherSessions, siteUrl, adminEmail };
