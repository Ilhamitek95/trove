'use strict';
/**
 * Payout safety + services VAT (review round 2026-10-02, group B).
 *
 *   settlement_items.iban_encrypted / payout_account_name / payout_bank_name
 *       the bank account the run was drafted against, copied (ciphertext
 *       only) at run time. The bank file pays THIS copy, so the account the
 *       owner reviewed is the one the transfer goes to — a later change to
 *       the shop's live details cannot redirect a drafted run.
 *   shops.payout_hold / payout_hold_reason / bank_changed_at
 *       a held shop is left out of every run until the owner releases it:
 *       'manual' (owner's investigation hold, Seller Agreement v4) or
 *       'bank_details_changed' (the first run after a bank change waits for
 *       the owner's confirmation). A suspended shop is held regardless.
 *   provider_payout_details.hold_reason / changed_at
 *       the same bank-change hold for service providers.
 *   service_bookings.vat_amount_cents / vat_reversed_cents / credit_note_ref
 *       output VAT on card bookings paid through Trove, captured at payment
 *       once VAT_REGISTERED is on and given back on refund (credit note
 *       CN-<booking code>), mirroring orders.
 *
 * Additive only: nothing existing is rewritten.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '022-B-payout-safety-service-vat',
  up(db) {
    addColumn(db, 'settlement_items', 'iban_encrypted', 'TEXT');
    addColumn(db, 'settlement_items', 'payout_account_name', 'TEXT');
    addColumn(db, 'settlement_items', 'payout_bank_name', 'TEXT');

    addColumn(db, 'shops', 'payout_hold', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'shops', 'payout_hold_reason', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'shops', 'bank_changed_at', 'TEXT');

    addColumn(db, 'provider_payout_details', 'hold_reason', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'provider_payout_details', 'changed_at', 'TEXT');

    addColumn(db, 'service_bookings', 'vat_amount_cents', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'service_bookings', 'vat_reversed_cents', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'service_bookings', 'credit_note_ref', 'TEXT');
  },
};
