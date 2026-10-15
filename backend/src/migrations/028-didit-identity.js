'use strict';
/**
 * Identity checks through Didit (15 Oct 2026, src/didit.js).
 *
 * A maker without a verified trade licence can establish their identity by
 * a Didit check (Emirates ID scan + live selfie + face match) instead of
 * uploading ID photos for the admin to compare. Trove keeps the result only:
 * no photos, no selfie, no full ID number.
 *
 *   shops.didit_session_id   the maker's latest Didit session
 *   shops.didit_status       its status as Didit last reported it
 *                            ('Not Started', 'In Progress', 'In Review',
 *                            'Approved', 'Declined', 'Abandoned', 'Expired'…)
 *   shops.didit_updated_at   when Trove last read that status
 *   shops.identity_name      the full name printed on the verified ID, so
 *                            the payout account holder can be compared with it
 *
 *   identity_sessions        one row per Didit session Trove started: who,
 *                            when the maker consented, the status, and a
 *                            short summary (document type, issuing country,
 *                            last four digits, dates, decline reasons).
 *                            Kept and deleted with the other identity
 *                            records (src/privacy.js).
 *
 * On approval the shop gets verification_method='didit' and
 * identity_checked_at (identity_checked_by stays NULL: no admin ticked it),
 * plus the last four digits and dates of the ID, as the photo route records
 * them. Nothing existing is rewritten.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '028-didit-identity',
  up(db) {
    addColumn(db, 'shops', 'didit_session_id', 'TEXT');
    addColumn(db, 'shops', 'didit_status', 'TEXT');
    addColumn(db, 'shops', 'didit_updated_at', 'TEXT');
    addColumn(db, 'shops', 'identity_name', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS identity_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      provider    TEXT NOT NULL DEFAULT 'didit',
      session_id  TEXT NOT NULL UNIQUE,
      status      TEXT NOT NULL DEFAULT 'Not Started',
      consent_at  TEXT NOT NULL,
      summary     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at  TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_identity_sessions_shop ON identity_sessions(shop_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_identity_sessions_status ON identity_sessions(status, updated_at)');
  },
};
