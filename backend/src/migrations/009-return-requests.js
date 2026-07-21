'use strict';
/**
 * Buyer return requests. One request per order (whole-order returns, matching
 * the whole-order refund architecture). Photos live in `images` as a JSON
 * array of /uploads URLs, same convention as reviews. Money snapshot columns
 * (refund_cents / fee_cents) are stamped at approval so the record shows what
 * actually went back to the card even if fee config changes later.
 */
module.exports = {
  id: '009-return-requests',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS return_requests (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id       INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        buyer_id       INTEGER NOT NULL REFERENCES users(id),
        reason         TEXT NOT NULL,
        details        TEXT NOT NULL DEFAULT '',
        images         TEXT NOT NULL DEFAULT '[]',
        status         TEXT NOT NULL DEFAULT 'requested', -- requested | approved | declined
        refund_cents   INTEGER,
        fee_cents      INTEGER,
        decline_reason TEXT,
        decided_at     TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_returns_buyer ON return_requests(buyer_id);
      CREATE INDEX IF NOT EXISTS idx_returns_status ON return_requests(status);
    `);
  },
};
