'use strict';
/**
 * Indexes for the lookups that scanned whole tables (F275). Each one serves
 * a path that runs on every request of its kind and grows with trading:
 *
 *   shipments(delivery_ref)              every courier status webhook
 *   orders(buyer_id)                     My orders, reviews, account checks
 *   orders(status, created_at)           the hourly unpaid-checkout sweep
 *   orders(stripe_payment_intent_id)     payment webhooks + missed-webhook recovery
 *   order_items(product_id)              product pages' sales, and the
 *                                        foreign-key check on every product delete
 *   seller_balances(settlement_id)       settlement runs and their payouts view
 *
 * The sessions(expire) index for the hourly session sweep lives with the
 * sessions table itself (src/session-store.js creates both).
 * Additive only: CREATE INDEX IF NOT EXISTS, no data changes.
 */
module.exports = {
  id: '026-E-indexes',
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shipments_delivery_ref ON shipments(delivery_ref);
      CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_orders_payment_intent ON orders(stripe_payment_intent_id);
      CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);
      CREATE INDEX IF NOT EXISTS idx_balances_settlement ON seller_balances(settlement_id);
    `);
  },
};
