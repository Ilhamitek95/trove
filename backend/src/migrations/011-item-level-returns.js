'use strict';
/**
 * Item-level returns. A return request now names the exact order items going
 * back (return_request_items) instead of implying the whole order, so one
 * order can carry several requests inside its 30-day window. The UNIQUE on
 * return_requests.order_id has to go — SQLite can't drop a constraint, so the
 * table is rebuilt — and every existing request is backfilled as "all items",
 * which is exactly what it meant on the day it was created.
 */
module.exports = {
  id: '011-item-level-returns',
  up(db) {
    db.exec(`
      CREATE TABLE return_requests_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
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
    `);
    db.exec(`INSERT INTO return_requests_new
      SELECT id, order_id, buyer_id, reason, details, images, status,
             refund_cents, fee_cents, decline_reason, decided_at, created_at
      FROM return_requests`);
    db.exec('DROP TABLE return_requests');
    db.exec('ALTER TABLE return_requests_new RENAME TO return_requests');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_returns_buyer ON return_requests(buyer_id);
      CREATE INDEX IF NOT EXISTS idx_returns_status ON return_requests(status);
      CREATE INDEX IF NOT EXISTS idx_returns_order ON return_requests(order_id);
      CREATE TABLE return_request_items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id    INTEGER NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
        order_item_id INTEGER NOT NULL REFERENCES order_items(id),
        qty           INTEGER NOT NULL
      );
      CREATE INDEX idx_rri_request ON return_request_items(request_id);
      CREATE INDEX idx_rri_item ON return_request_items(order_item_id);
    `);
    db.exec(`INSERT INTO return_request_items (request_id, order_item_id, qty)
      SELECT rr.id, oi.id, oi.qty
      FROM return_requests rr JOIN order_items oi ON oi.order_id = rr.order_id`);
  },
};
