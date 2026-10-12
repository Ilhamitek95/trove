'use strict';
/**
 * Low + nit round (12 Oct 2026), group C — the maker dashboard and the admin.
 *
 *   shops.photo_session_requested_at   when the maker asked Trove to
 *   shops.photo_session_arranged_at    photograph their pieces (F318), and
 *                                      when the owner marked it arranged.
 *                                      An open request = requested, not yet
 *                                      arranged; it shows in Admin → Needs
 *                                      you and Shops.
 *   idx_items_product                  order_items by piece: Shop Analytics'
 *                                      per-piece sales and the 'has this
 *                                      piece ever sold' check stop scanning
 *                                      every order line (F358).
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '026-C-photo-sessions',
  up(db) {
    addColumn(db, 'shops', 'photo_session_requested_at', 'TEXT');
    addColumn(db, 'shops', 'photo_session_arranged_at', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id)');
  },
};
