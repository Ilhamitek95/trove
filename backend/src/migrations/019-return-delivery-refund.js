'use strict';
/**
 * Delivery refund on whole-order fault returns (owner, 2026-09-30): when the
 * whole order comes back because it arrived faulty or damaged, was the wrong
 * item or was not as described, the original delivery fee is refunded on top
 * of the items (rule in src/returns.js).
 *
 *   return_requests.delivery_refund_cents  the delivery fee this request
 *                                          refunds, stamped at approval
 *                                          (NULL = not decided yet)
 *   return_requests.delivery_override      the admin's call at approval:
 *                                          1 = refund it, 0 = keep it,
 *                                          NULL = the rule decided
 *
 * Additive only. Requests approved before this change keep NULL, which every
 * reader treats as no delivery refund — their stamped refund_cents is what
 * the buyer was promised and is left exactly as it is.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '019-return-delivery-refund',
  up(db) {
    addColumn(db, 'return_requests', 'delivery_refund_cents', 'INTEGER');
    addColumn(db, 'return_requests', 'delivery_override', 'INTEGER');
  },
};
