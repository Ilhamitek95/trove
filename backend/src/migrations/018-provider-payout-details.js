'use strict';
/**
 * Manual provider payouts (owner, 2026-09-30: providers are paid by bank
 * transfer from Serein Consultancy on Trove's behalf).
 *
 *   provider_payout_details   one row per provider: account holder, bank,
 *                             IBAN encrypted with PAYOUT_ENC_KEY exactly like
 *                             shops.iban_encrypted, plus the masked form for
 *                             display. A table of its own (not columns on
 *                             service_providers) because several admin views
 *                             return service_providers rows whole — the
 *                             ciphertext must never ride along with them.
 *                             `source` = 'own' (typed by the provider) or
 *                             'shop' (copied server-side from their shop).
 *   provider_credits.payer_name
 *                             who sent the transfer, stamped at Mark paid
 *                             (PROVIDER_PAYER_NAME, default Serein Consultancy).
 *
 * Additive only: nothing existing is rewritten.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '018-provider-payout-details',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS provider_payout_details (
      provider_id    INTEGER PRIMARY KEY REFERENCES service_providers(id) ON DELETE CASCADE,
      account_name   TEXT NOT NULL,
      bank_name      TEXT NOT NULL,
      iban_encrypted TEXT NOT NULL,
      iban_masked    TEXT NOT NULL,
      source         TEXT NOT NULL DEFAULT 'own',
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    addColumn(db, 'provider_credits', 'payer_name', "TEXT NOT NULL DEFAULT ''");
  },
};
