'use strict';
/**
 * Which Terms of Sale an order was placed under (F345). The Terms say 'the
 * version shown when you place an order is the one that applies to that
 * order', so each order now records it:
 *
 *   orders.terms_version   'v3', … — stamped on every new order by the
 *                          orders_terms_version trigger, which db.js
 *                          re-creates at each boot from
 *                          config.BUYER_TERMS_VERSION (so a version bump in
 *                          the code is picked up by the next deploy, and
 *                          every way an order is created is covered).
 *
 * Orders placed before this column existed stay '' (unknown): the deploy
 * times of v1/v2/v3 are not recorded precisely enough to back-fill them
 * without guessing, and a guessed version is worse than none.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '026-E-order-terms-version',
  up(db) {
    addColumn(db, 'orders', 'terms_version', "TEXT NOT NULL DEFAULT ''");
  },
};
