'use strict';
/**
 * Stale service bookings (medium-findings round 2026-10-02, group F4).
 *
 * service_bookings.reminded_at  when the provider was reminded about a
 *                               request still waiting for their answer
 *                               (service-bookings.sweepStale sends it once,
 *                               two days after the request). Requests left
 *                               unanswered for a week are closed by the same
 *                               sweep (cancelled_by = 'expired'), and so are
 *                               bookings still waiting for payment once their
 *                               service date has passed.
 *
 * Additive only: nothing existing is rewritten.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '024-F4-booking-sweep',
  up(db) {
    addColumn(db, 'service_bookings', 'reminded_at', 'TEXT');
  },
};
