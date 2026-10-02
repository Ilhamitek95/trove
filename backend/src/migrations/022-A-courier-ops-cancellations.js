'use strict';
/**
 * Courier health, item cancellations, disputes and tax documents
 * (fix round 2026-10-02, group A).
 *
 * shipments
 *   packed_at              the maker tapped 'Packed' (the parcel is ready at
 *                          their door). Separate from ready_at, which is the
 *                          courier booking actually going through.
 *   collected_at           the courier reported the parcel collected from the
 *                          maker (OTO pickedUp…, Quiqup collected…). Before
 *                          this a 'shipped' parcel was only packed.
 *   booking_error          the last courier booking failure (create order or
 *                          book the collection), NULL once it goes through
 *   booking_error_at       when it failed
 *   booking_attempts       how many times Trove has tried (sweep retries)
 *   attention              '' or what a person must look at (booking_failed,
 *                          courier_cancel_failed, lost, returning,
 *                          delivered_after_cancel, not_collected,
 *                          refunded_in_transit, delivery_attempts)
 *   attention_at           when the flag was raised (the admin was emailed)
 *   cancelled_at           when Trove cancelled the parcel
 *
 * order_items.cancelled_qty  units cancelled before dispatch (admin)
 *
 * order_cancellations / order_cancellation_items — one row per admin
 * cancellation of not-yet-dispatched units: the refund it sent, the delivery
 * fee it gave back (whole order cancelled), the VAT it reversed and its
 * credit-note reference CN-<order>-C<id>.
 *
 * orders
 *   hold_reason            '' or why the order's maker credits are held from
 *                          settlement (dispute, external_refund)
 *   dispute_status         Stripe dispute status, NULL when there is none
 *   dispute_due_by         evidence deadline (SQLite UTC text)
 *   external_refund_cents  money refunded straight from the Stripe dashboard
 *                          (not through Trove) that Trove has accounted for
 *   refund_ref             the Stripe refund id of a whole-order refund
 *   whole_refund_cents     what that whole-order refund paid back (the rest
 *                          after earlier returns/cancellations)
 *   whole_refund_vat_cents the VAT on its credit note CN-<order> — only the
 *                          VAT not already reversed by earlier credit notes
 *   tax_invoice_no         sequential tax invoice number (only once VAT
 *                          registered: INV-000001…)
 *
 * ops_state — small key/value store for operational readings (the OTO
 * wallet balance and whether the low-balance email has gone).
 *
 * Backfill: parcels already out for delivery or delivered were collected, and
 * a 'shipped' parcel that was never courier-booked was handed over by the
 * maker — both get collected_at. Additive only.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '022-A-courier-ops-cancellations',
  up(db) {
    addColumn(db, 'shipments', 'packed_at', 'TEXT');
    addColumn(db, 'shipments', 'collected_at', 'TEXT');
    addColumn(db, 'shipments', 'booking_error', 'TEXT');
    addColumn(db, 'shipments', 'booking_error_at', 'TEXT');
    addColumn(db, 'shipments', 'booking_attempts', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'shipments', 'attention', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'shipments', 'attention_at', 'TEXT');
    addColumn(db, 'shipments', 'cancelled_at', 'TEXT');
    addColumn(db, 'shipments', 'collect_alerted_at', 'TEXT');

    addColumn(db, 'order_items', 'cancelled_qty', 'INTEGER NOT NULL DEFAULT 0');

    addColumn(db, 'orders', 'hold_reason', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'orders', 'dispute_status', 'TEXT');
    addColumn(db, 'orders', 'dispute_due_by', 'TEXT');
    addColumn(db, 'orders', 'external_refund_cents', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'orders', 'refund_ref', 'TEXT');
    // What the whole-order refund itself gave back and the VAT its credit
    // note (CN-<order>) carries — only what earlier returns/cancellations had
    // not already reversed, so no VAT is ever credited twice.
    addColumn(db, 'orders', 'whole_refund_cents', 'INTEGER');
    addColumn(db, 'orders', 'whole_refund_vat_cents', 'INTEGER');
    addColumn(db, 'orders', 'tax_invoice_no', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS order_cancellations (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id              INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status                TEXT NOT NULL DEFAULT 'pending', -- pending | refunded
        refund_cents          INTEGER NOT NULL DEFAULT 0,
        items_cents           INTEGER NOT NULL DEFAULT 0,
        delivery_refund_cents INTEGER NOT NULL DEFAULT 0,
        vat_reversed_cents    INTEGER NOT NULL DEFAULT 0,
        credit_note_ref       TEXT,
        refund_ref            TEXT,
        reason                TEXT NOT NULL DEFAULT 'buyer_request', -- buyer_request | not_shipped | other
        note                  TEXT,
        by_user_id            INTEGER,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        refunded_at           TEXT
      );
      CREATE TABLE IF NOT EXISTS order_cancellation_items (
        cancellation_id INTEGER NOT NULL REFERENCES order_cancellations(id) ON DELETE CASCADE,
        order_item_id   INTEGER NOT NULL REFERENCES order_items(id),
        qty             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ocancel_order ON order_cancellations(order_id);
      CREATE INDEX IF NOT EXISTS idx_ocancel_items ON order_cancellation_items(cancellation_id);
      CREATE TABLE IF NOT EXISTS ops_state (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tax_invoice ON orders(tax_invoice_no) WHERE tax_invoice_no IS NOT NULL;
    `);

    db.exec(`UPDATE shipments SET collected_at = COALESCE(collected_at, updated_at)
      WHERE status IN ('out_for_delivery','delivered')
         OR (status = 'shipped' AND (delivery_ref IS NULL OR delivery_ref = ''))
         OR (status = 'shipped' AND EXISTS (SELECT 1 FROM shipment_events e
              WHERE e.shipment_id = shipments.id AND e.note LIKE 'Collected by%'))`);
    // A parcel marked shipped (packed) by the maker was packed then.
    db.exec(`UPDATE shipments SET packed_at = COALESCE(packed_at, ready_at, updated_at)
      WHERE status IN ('shipped','out_for_delivery','delivered')`);
  },
};
