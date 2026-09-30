'use strict';
/**
 * 15-day returns, fortnightly maker payouts, refund on collection
 * (owner, 2026-09-30: 'bi-weekly shop payments with 15 days return policy').
 *
 * What it does to existing data:
 *   - orders.return_days = 30 on every order that already exists. Those
 *     buyers checked out under the 30-day promise, so they keep it; new
 *     orders leave it NULL and get fees.RETURN_WINDOW_DAYS (15).
 *   - orders.return_window_ends_at becomes the BUYER's deadline (it used to
 *     mirror the 7-day maker hold): delivered orders are re-stamped to
 *     delivered_at + their return days.
 *   - Maker credits: a shipment whose old 7-day hold has ALREADY closed keeps
 *     its stamp, so money that is payable today stays payable. A shipment
 *     still inside the old hold, whose credit has not been swept, moves to
 *     delivered_at + 15 days — the new hold.
 *   - Return requests gain the new states. Every existing 'approved' request
 *     was refunded at approval under the old flow, so it becomes 'refunded'
 *     (refunded_at = decided_at). Nothing else about them changes.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '016-returns-15-days',
  up(db) {
    /* ---- orders ---- */
    addColumn(db, 'orders', 'return_days', 'INTEGER');                            // NULL = current policy
    addColumn(db, 'orders', 'vat_reversed_cents', 'INTEGER NOT NULL DEFAULT 0'); // VAT given back on refunds
    addColumn(db, 'orders', 'credit_note_ref', 'TEXT');                          // whole-order refund credit note
    db.exec('UPDATE orders SET return_days = 30 WHERE return_days IS NULL');
    db.exec(`UPDATE orders SET return_window_ends_at = datetime(delivered_at, '+' || return_days || ' days')
      WHERE delivered_at IS NOT NULL`);

    /* ---- maker hold: extend only what is still inside the old window ---- */
    db.exec(`UPDATE shipments SET return_window_ends_at = datetime(delivered_at, '+15 days')
      WHERE status = 'delivered' AND delivered_at IS NOT NULL
        AND return_window_ends_at IS NOT NULL AND return_window_ends_at > datetime('now')
        AND NOT EXISTS (SELECT 1 FROM seller_balances b
          WHERE b.order_id = shipments.order_id AND b.shop_id = shipments.shop_id
            AND b.type = 'credit_sale' AND b.settlement_id IS NOT NULL)`);

    /* ---- return requests: approved → collection booked → collected → refunded ---- */
    addColumn(db, 'return_requests', 'fee_override', 'INTEGER');        // NULL = the rule; 1 charged / 0 waived by admin
    addColumn(db, 'return_requests', 'collection_booked_at', 'TEXT');
    addColumn(db, 'return_requests', 'collected_at', 'TEXT');
    addColumn(db, 'return_requests', 'refunded_at', 'TEXT');
    addColumn(db, 'return_requests', 'refund_ref', 'TEXT');             // Stripe refund id
    addColumn(db, 'return_requests', 'refund_note', 'TEXT');            // e.g. refunded early by admin
    addColumn(db, 'return_requests', 'vat_reversed_cents', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'return_requests', 'credit_note_ref', 'TEXT');
    db.exec(`UPDATE return_requests SET status = 'refunded', refunded_at = COALESCE(refunded_at, decided_at)
      WHERE status = 'approved'`);

    // One row per courier collection (a request spanning two shops = two pickups).
    db.exec(`
      CREATE TABLE IF NOT EXISTS return_collections (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id   INTEGER NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
        shipment_id  INTEGER NOT NULL REFERENCES shipments(id),
        shop_id      INTEGER NOT NULL,
        ref          TEXT,
        status       TEXT NOT NULL DEFAULT 'booking',  -- booking | booked | failed | collected
        note         TEXT,
        booked_at    TEXT,
        collected_at TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_retcol_request ON return_collections(request_id);
      CREATE INDEX IF NOT EXISTS idx_retcol_ref ON return_collections(ref);
    `);
  },
};
