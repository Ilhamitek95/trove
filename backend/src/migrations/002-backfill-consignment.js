'use strict';
/**
 * Backfills for databases that predate the two-rail architecture (including
 * the live production DB). Everything here is idempotent and keyed on
 * "value not set yet", so re-running against an already-migrated database is
 * a no-op — but the runner only applies it once anyway.
 */

// Sales made before this migration were sold under the old 10% terms; their
// ledger credits honour that. New sales credit at COMMISSION_PERCENT (20).
const LEGACY_FEE_PERCENT = 10;

module.exports = {
  id: '002-backfill-consignment',
  up(db) {
    // 1. Shops that had chosen their own Stripe keep that intent as the tier.
    //    ('managed' shops fall to the column default 'consignment'.)
    db.exec(`UPDATE shops SET tier='connect' WHERE payout_type='connect' AND tier='consignment'`);

    // 2. Paid orders: Trove's purchase of the goods happened at payment time.
    db.exec(`UPDATE orders SET title_transferred_at = created_at
             WHERE status IN ('paid','fulfilled') AND title_transferred_at IS NULL`);

    // 3. Already-delivered shipments: best-effort delivery timestamp, and the
    //    7-day return window measured from it.
    db.exec(`UPDATE shipments
             SET delivered_at = updated_at,
                 return_window_ends_at = datetime(updated_at, '+7 days')
             WHERE status='delivered' AND delivered_at IS NULL`);

    // 4. Orders whose every shipment is delivered get order-level stamps too.
    db.exec(`UPDATE orders SET
               delivered_at = (SELECT MAX(sh.delivered_at) FROM shipments sh WHERE sh.order_id = orders.id),
               return_window_ends_at = datetime((SELECT MAX(sh.delivered_at) FROM shipments sh WHERE sh.order_id = orders.id), '+7 days')
             WHERE delivered_at IS NULL
               AND EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id = orders.id)
               AND NOT EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id = orders.id AND sh.status != 'delivered')`);

    // 5. Money still owed to managed shops (unswept by the old weekly payout
    //    run, no Stripe transfer) becomes supplier ledger credits, grouped per
    //    (order, shop) exactly like the old OUTSTANDING sweep so no fils is
    //    lost or double-counted. The old run/preview endpoints are retired in
    //    the same release, so these credits are the only path to payment.
    const groups = db.prepare(`
      SELECT oi.order_id, oi.shop_id, SUM(oi.price_cents * oi.qty) AS gross
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN shops  s ON s.id = oi.shop_id
      WHERE s.payout_type = 'managed'
        AND o.status IN ('paid','fulfilled')
        AND oi.payout_id IS NULL
        AND oi.transfer_id IS NULL
      GROUP BY oi.order_id, oi.shop_id
      HAVING gross > 0`).all();
    const insert = db.prepare(`INSERT OR IGNORE INTO seller_balances (shop_id, order_id, type, amount_cents)
                               VALUES (?,?, 'credit_sale', ?)`);
    for (const g of groups) {
      const fee = Math.round((g.gross * LEGACY_FEE_PERCENT) / 100);
      insert.run(g.shop_id, g.order_id, g.gross - fee);
    }
    if (groups.length) console.log(`backfill: ${groups.length} legacy sale credit(s) moved to the supplier ledger at ${LEGACY_FEE_PERCENT}%`);
  },
};
