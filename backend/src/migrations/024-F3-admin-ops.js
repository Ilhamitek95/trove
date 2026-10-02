'use strict';
/**
 * Medium-findings round (2 Oct 2026), group F3 — the admin panel and money.
 *
 *   admin_actions            a lasting record of what the admin did (F065):
 *                            every admin write, and every write made in shop
 *                            view, with when, who, which shop view, the
 *                            target, what it was before (where the route
 *                            knows) and what was asked for. Written by
 *                            src/admin-audit.js; Admin → Activity lists it.
 *   provider_payout_batches  the provider bank transfer file, frozen (F105):
 *                            downloading the file stores per provider the
 *                            exact credit/debit rows, the amount and the
 *                            reference in it; 'Mark paid' closes exactly that
 *                            batch, never what happens to be payable later.
 *   job_runs                 the last success / failure of each scheduled job
 *                            (settlement, backup, courier set-up, sweeps), so
 *                            a failure reaches the owner by email and shows
 *                            on the admin Overview (F145).
 *   orders.delivery_edited_at  when the admin last corrected the delivery
 *                            details after payment (F199).
 *
 * Settlements gain the status 'cancelled' (a draft the admin cancelled) and
 * an undo of 'paid' (F185) — both are plain values in the existing columns.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '024-F3-admin-ops',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS admin_actions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      at                     TEXT NOT NULL DEFAULT (datetime('now')),
      admin_id               INTEGER,
      admin_email            TEXT NOT NULL DEFAULT '',
      impersonating_shop_id  INTEGER,
      method                 TEXT NOT NULL DEFAULT '',
      path                   TEXT NOT NULL DEFAULT '',
      action                 TEXT NOT NULL,
      target_type            TEXT NOT NULL DEFAULT '',
      target_id              TEXT NOT NULL DEFAULT '',
      before_json            TEXT,
      after_json             TEXT,
      note                   TEXT NOT NULL DEFAULT '',
      status                 INTEGER
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS admin_actions_at ON admin_actions(at)');
    db.exec('CREATE INDEX IF NOT EXISTS admin_actions_target ON admin_actions(target_type, target_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS provider_payout_batches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id    INTEGER NOT NULL REFERENCES service_providers(id),
      reference      TEXT NOT NULL,
      amount_cents   INTEGER NOT NULL,
      credit_ids     TEXT NOT NULL DEFAULT '[]',
      debit_ids      TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      superseded_at  TEXT,
      paid_at        TEXT,
      payer_name     TEXT NOT NULL DEFAULT ''
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS provider_payout_batches_open ON provider_payout_batches(provider_id, paid_at, superseded_at)');

    db.exec(`CREATE TABLE IF NOT EXISTS job_runs (
      job            TEXT PRIMARY KEY,
      last_ok_at     TEXT,
      last_ok_note   TEXT NOT NULL DEFAULT '',
      last_error_at  TEXT,
      last_error     TEXT NOT NULL DEFAULT '',
      failing        INTEGER NOT NULL DEFAULT 0,
      alerted_on     TEXT NOT NULL DEFAULT ''
    )`);

    addColumn(db, 'orders', 'delivery_edited_at', 'TEXT');
  },
};
