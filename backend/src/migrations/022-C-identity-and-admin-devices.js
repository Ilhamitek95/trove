'use strict';
/**
 * October 2026 review, group C (seller onboarding, admin, sign-in).
 *
 *   shops.verification_method  how the maker's identity was established:
 *                              'emirates_id' (photos + home address, checked
 *                              by an admin), 'trade_licence' (an admin
 *                              verified the licence) — and later 'uae_pass'
 *                              once Trove is onboarded with UAE Pass. NULL =
 *                              not established yet. See src/identity.js.
 *   shops.identity_checked_at  when an admin ticked 'ID checked' against the
 *   shops.identity_checked_by  photos and the typed details (admin user id).
 *   shops.eid_reminder_for     the Emirates ID expiry date the maker was last
 *                              reminded about (one reminder per expiry date;
 *                              a new ID means a new date, so a new reminder).
 *   admin_devices              browsers where the admin completed the emailed
 *                              sign-in code and ticked 'trust this device'.
 *                              Only a SHA-256 of the cookie value is stored.
 *
 * Existing shops: a shop whose licence an admin already verified is marked
 * 'trade_licence'. Nothing else is rewritten — makers with ID photos on file
 * still wait for the admin's 'ID checked' tick.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '022-C-identity-and-admin-devices',
  up(db) {
    addColumn(db, 'shops', 'verification_method', 'TEXT');
    addColumn(db, 'shops', 'identity_checked_at', 'TEXT');
    addColumn(db, 'shops', 'identity_checked_by', 'INTEGER');
    addColumn(db, 'shops', 'eid_reminder_for', 'TEXT');
    db.exec(`UPDATE shops SET verification_method='trade_licence'
      WHERE verification_method IS NULL AND license_verified_at IS NOT NULL`);
    db.exec(`CREATE TABLE IF NOT EXISTS admin_devices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      expires_at   INTEGER NOT NULL
    )`);
  },
};
