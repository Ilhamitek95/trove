'use strict';
/**
 * Identity verification for unlicensed suppliers: Emirates ID photos (stored
 * encrypted under PRIVATE_DIR, only the relative path + mime live here) and
 * the supplier's home address. Collected at payout-setup; admin-only viewing.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '006-eid-verification',
  up(db) {
    addColumn(db, 'shops', 'eid_front_file', 'TEXT');   // relative path under PRIVATE_DIR, .enc
    addColumn(db, 'shops', 'eid_front_mime', 'TEXT');
    addColumn(db, 'shops', 'eid_back_file', 'TEXT');
    addColumn(db, 'shops', 'eid_back_mime', 'TEXT');
    addColumn(db, 'shops', 'seller_address', 'TEXT');   // home address (line · area, emirate)
  },
};
