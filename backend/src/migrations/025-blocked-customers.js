'use strict';
/**
 * Block a customer from buying (F199, the last part of the finding).
 *
 *   blocked_customers   one row per blocked email address: who blocked them,
 *                       when, and the owner's private reason. The row also
 *                       carries the account id when there is one, so a
 *                       blocked buyer who changes their email stays blocked.
 *                       Unblocking deletes the row; the Activity log keeps
 *                       both events. Written by src/customer-block.js.
 */
module.exports = {
  id: '025-blocked-customers',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS blocked_customers (
      email       TEXT PRIMARY KEY,
      user_id     INTEGER,
      note        TEXT NOT NULL DEFAULT '',
      blocked_at  TEXT NOT NULL DEFAULT (datetime('now')),
      blocked_by  TEXT NOT NULL DEFAULT ''
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS blocked_customers_user ON blocked_customers(user_id)');
  },
};
