'use strict';
/**
 * Money fix round, 12 Oct 2026 (group D). Additive only.
 *
 *   return_requests.maker_credit_kept   1 = an admin 'Refund now' where the
 *                                       buyer KEEPS the piece and Trove
 *                                       absorbs the refund: the maker's
 *                                       payment was not reversed (F222).
 *                                       0 for every existing request, which
 *                                       is exactly how they were refunded.
 *   idx_retcol_shipment                 return_collections by parcel — a
 *                                       courier event that names only the
 *                                       parcel is matched through it (F448).
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '026-D-money-fixes',
  up(db) {
    addColumn(db, 'return_requests', 'maker_credit_kept', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_retcol_shipment ON return_collections(shipment_id)');
  },
};
