'use strict';
/**
 * The provider's note to the customer on confirming a booking (low-findings
 * round 2026-10-12, group B — F416).
 *
 * service_bookings.confirm_note  optional, plain text (max 500): what the
 *                                final price includes, why the date was
 *                                picked… Shown on the booking page and in
 *                                the 'confirmed' email (pay link or direct).
 *
 * Additive only: nothing existing is rewritten.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '026-B-booking-confirm-note',
  up(db) {
    addColumn(db, 'service_bookings', 'confirm_note', "TEXT NOT NULL DEFAULT ''");
  },
};
