'use strict';
/**
 * Quiqup collects from the maker, so every shop needs a real pickup address
 * and a phone the courier can call (shops only had a free-text "area" and,
 * for unlicensed sellers, a home address). Shipments record when the maker
 * handed the parcel over (`ready_at`) so the hand-over is sent once.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '015-quiqup-pickup',
  up(db) {
    addColumn(db, 'shops', 'pickup_address', "TEXT DEFAULT ''"); // building · street · area, emirate
    addColumn(db, 'shops', 'pickup_phone',   "TEXT DEFAULT ''"); // +9715XXXXXXXX, courier-facing only
    addColumn(db, 'shipments', 'ready_at', 'TEXT');              // when the maker marked it ready for collection
  },
};
