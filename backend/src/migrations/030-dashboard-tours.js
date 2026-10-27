'use strict';
/**
 * Guided dashboard tour (owner, 2026-10-27: "push the tour on live website
 * now"). The tour (docs/tour.js) opens by itself once, on an approved
 * maker's or provider's first visit to their dashboard; these remember that
 * it has, on the account, so it does not open again on another device.
 *
 *   users.tour_sell_at       the /sell tour opened by itself
 *   users.tour_provider_at   the /provider tour opened by itself
 *
 * Nothing existing is rewritten: every account starts without either, so
 * approved makers and providers who sign in after this see it once.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '030-dashboard-tours',
  up(db) {
    addColumn(db, 'users', 'tour_sell_at', 'TEXT');
    addColumn(db, 'users', 'tour_provider_at', 'TEXT');
  },
};
