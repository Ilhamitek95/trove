'use strict';
/**
 * Account recovery + moderation lock (2026-09-30).
 *
 *   users.email_verified_at   set when the owner proves the address: the
 *                             welcome email's confirm link, a password reset
 *                             (the link went to that inbox) or Google sign-in.
 *   users.password_set        0 for accounts that only have the random
 *                             placeholder hash (Google-created, or a password
 *                             voided by the Google takeover rule) — the account
 *                             page then offers "Set a password" instead of
 *                             asking for the current one.
 *   auth_tokens               single-use emailed tokens (password reset and
 *                             email confirmation). Only a SHA-256 of the token
 *                             is stored, so a copy of the database can't be
 *                             used to take over an account.
 *   products.admin_hidden_at  an admin pulled the piece; the seller can't put it
 *                             back on sale until Trove lifts the hide.
 *   shops/service_providers.review_note
 *                             the admin's note on a decision (sent in the
 *                             rejection email).
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '016-account-recovery',
  up(db) {
    addColumn(db, 'users', 'email_verified_at', 'TEXT');
    addColumn(db, 'users', 'password_set', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'products', 'admin_hidden_at', 'TEXT');
    addColumn(db, 'shops', 'review_note', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'service_providers', 'review_note', "TEXT NOT NULL DEFAULT ''");
    db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,                 -- reset | verify
      token_hash TEXT NOT NULL UNIQUE,          -- sha256 hex of the emailed token
      email      TEXT NOT NULL,                 -- the address it was sent to
      expires_at INTEGER NOT NULL,              -- epoch ms
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind)');
  },
};
