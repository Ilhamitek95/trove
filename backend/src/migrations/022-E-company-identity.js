'use strict';
/**
 * Company identity (owner, 2026-10-02): the code defaults of 'site.company'
 * now name Serein Consultancy LLC, whose brands Trove and Trove at Home are.
 * A saved override wins over the defaults field by field, so an override the
 * owner once saved with EVERY field blank would keep hiding them. Remove only
 * that all-blank override; one with anything filled in is the owner's own
 * wording and is left exactly as it is.
 *
 * Also adds the two columns the privacy tooling needs (src/privacy.js):
 *   users.anonymised_at  when an account was closed and anonymised
 *   shops.closed_at      when a shop was closed (starts the ID-document
 *                        retention clock in the nightly sweep)
 * and the privacy_log table (what the tools did, no personal data).
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

module.exports = {
  id: '022-E-company-identity',
  up(db) {
    const row = db.prepare("SELECT value FROM site_content WHERE section='site.company'").get();
    if (row) {
      let v = null;
      try { v = JSON.parse(row.value); } catch (_) { v = null; }
      const blank = !v || typeof v !== 'object'
        || Object.values(v).every((x) => typeof x !== 'string' || !x.trim());
      if (blank) db.prepare("DELETE FROM site_content WHERE section='site.company'").run();
    }
    addColumn(db, 'users', 'anonymised_at', 'TEXT');
    addColumn(db, 'shops', 'closed_at', 'TEXT');
    // What the privacy tools did, without keeping the person's address: the
    // subject is a SHA-256 of the lower-cased email, so a repeat request can
    // be matched without the log itself holding personal data.
    db.exec(`CREATE TABLE IF NOT EXISTS privacy_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      action       TEXT NOT NULL,              -- export | anonymise | delete_id_documents | sweep
      subject_hash TEXT NOT NULL DEFAULT '',
      detail       TEXT NOT NULL DEFAULT '',   -- counts only, never personal data
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  },
};
