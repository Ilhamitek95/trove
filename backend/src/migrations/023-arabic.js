'use strict';
/**
 * Arabic edition (owner, 2026-10-02).
 *
 *   users.lang             the account's language ('en' | 'ar'): set when the
 *                          reader switches language while signed in; emails
 *                          to the account go out in it
 *   orders.lang            the language of the checkout page, so a guest's
 *                          receipt and order emails match what they read
 *   service_bookings.lang  the same for a services booking request
 *
 *   translations           machine (or hand-edited) Arabic of what people
 *                          create: pieces, shop stories, provider bios,
 *                          services, site content, public reviews. One row per
 *                          (entity, entity_id, field, lang) with the SHA-256
 *                          of the English it was made from: a row shows only
 *                          while that English is unchanged. locked = 1 is a
 *                          hand-edited text the machine never overwrites.
 *   translation_queue      what still needs translating (src/translate.js)
 *   translation_spend      the day's Claude API spend, for the budget cap
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

module.exports = {
  id: '023-arabic',
  up(db) {
    addColumn(db, 'users', 'lang', "TEXT NOT NULL DEFAULT 'en'");
    addColumn(db, 'orders', 'lang', "TEXT NOT NULL DEFAULT 'en'");
    addColumn(db, 'service_bookings', 'lang', "TEXT NOT NULL DEFAULT 'en'");
    db.exec(`CREATE TABLE IF NOT EXISTS translations (
      entity       TEXT NOT NULL,              -- product | shop | service | provider | review | content
      entity_id    TEXT NOT NULL,              -- the row id (content: the section, e.g. 'sell.faq')
      field        TEXT NOT NULL,              -- 'name', 'description', 'options.0.values.1', 'items.2.q' …
      lang         TEXT NOT NULL,              -- 'ar'
      text         TEXT NOT NULL,
      source_hash  TEXT NOT NULL,              -- SHA-256 of the English it translates
      source_text  TEXT NOT NULL DEFAULT '',   -- that English (for the admin's side-by-side view)
      locked       INTEGER NOT NULL DEFAULT 0, -- 1 = hand-edited; never overwritten by the machine
      origin       TEXT NOT NULL DEFAULT 'machine', -- machine | manual
      model        TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entity, entity_id, field, lang)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS translation_queue (
      entity      TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      lang        TEXT NOT NULL,
      queued_at   TEXT NOT NULL DEFAULT (datetime('now')),
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      next_at     TEXT,                        -- back-off after a failure
      PRIMARY KEY (entity, entity_id, lang)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS translation_spend (
      day      TEXT PRIMARY KEY,               -- YYYY-MM-DD (UTC)
      usd      REAL NOT NULL DEFAULT 0,
      calls    INTEGER NOT NULL DEFAULT 0,
      tokens_in  INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0
    )`);
  },
};
