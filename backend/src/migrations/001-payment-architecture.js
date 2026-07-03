'use strict';
/**
 * Two-rail payment architecture — schema surface.
 *
 * Rail A (consignment, the default): Trove purchases each item from the
 * supplier at order confirmation and resells it to the buyer; suppliers are
 * paid weekly after a 7-day post-delivery return window. Rail B (connect,
 * behind RAIL_B_ENABLED): licensed sellers on Stripe Connect Custom accounts
 * paid per sale via destination charges.
 */

// Local copy of the guarded-ALTER idiom so a half-touched dev database never
// crashes boot (this file cannot require('../db') — see migrations/index.js).
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '001-payment-architecture',
  up(db) {
    /* ---- shops: tier + supplier onboarding + graduation ---- */
    addColumn(db, 'shops', 'tier', "TEXT NOT NULL DEFAULT 'consignment'"); // consignment | connect
    addColumn(db, 'shops', 'emirates_id_last4',  "TEXT DEFAULT ''");
    addColumn(db, 'shops', 'emirates_id_issue',  "TEXT DEFAULT ''");
    addColumn(db, 'shops', 'emirates_id_expiry', "TEXT DEFAULT ''");
    addColumn(db, 'shops', 'iban_masked',        "TEXT DEFAULT ''");
    addColumn(db, 'shops', 'iban_encrypted',     'TEXT');                 // AES-256-GCM, base64(iv|tag|ct)
    addColumn(db, 'shops', 'agreement_version',     'TEXT');
    addColumn(db, 'shops', 'agreement_accepted_at', 'TEXT');
    addColumn(db, 'shops', 'agreement_hash',        'TEXT');              // sha256 of the agreement text accepted
    addColumn(db, 'shops', 'license_number',      "TEXT DEFAULT ''");     // UAE trade / e-Trader license
    addColumn(db, 'shops', 'license_image',       "TEXT DEFAULT ''");     // PRIVATE file path (never under /uploads)
    addColumn(db, 'shops', 'license_verified_at', 'TEXT');                // admin verification (graduation gate)
    addColumn(db, 'shops', 'graduation_flagged_at', 'TEXT');              // cap monitor hit
    addColumn(db, 'shops', 'connect_queue', 'INTEGER NOT NULL DEFAULT 0');// licensed at signup while Rail B was off

    /* ---- orders: rail, title transfer, return window, refunds, VAT ---- */
    addColumn(db, 'orders', 'rail', "TEXT NOT NULL DEFAULT 'consignment'");
    addColumn(db, 'orders', 'title_transferred_at', 'TEXT'); // when Trove purchases the goods (= payment success)
    addColumn(db, 'orders', 'delivered_at', 'TEXT');          // last shipment delivered
    addColumn(db, 'orders', 'return_window_ends_at', 'TEXT');
    addColumn(db, 'orders', 'refunded_at', 'TEXT');
    addColumn(db, 'orders', 'payment_method', "TEXT NOT NULL DEFAULT 'card'"); // 'cod' is schema-ready only
    addColumn(db, 'orders', 'vat_amount_cents', 'INTEGER NOT NULL DEFAULT 0');

    /* ---- shipments: per-shop delivery confirmation drives settlement ---- */
    addColumn(db, 'shipments', 'delivered_at', 'TEXT');
    addColumn(db, 'shipments', 'return_window_ends_at', 'TEXT');
    addColumn(db, 'shipments', 'delivery_ref', "TEXT DEFAULT ''"); // courier job reference

    /* ---- supplier ledger + weekly settlements + purchase documentation ---- */
    db.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_date    TEXT NOT NULL,                 -- the Tuesday of the run (date only)
        status      TEXT NOT NULL DEFAULT 'draft', -- draft | exported | paid
        total_cents INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        exported_at TEXT,
        paid_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS settlement_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_id  INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
        shop_id        INTEGER NOT NULL REFERENCES shops(id),
        amount_cents   INTEGER NOT NULL,            -- net payable this run (credits + netted debits)
        credit_cents   INTEGER NOT NULL DEFAULT 0,
        debit_cents    INTEGER NOT NULL DEFAULT 0,  -- refund debits netted in (stored negative)
        item_count     INTEGER NOT NULL DEFAULT 0,
        bank_reference TEXT NOT NULL,               -- 'Purchase of handmade goods — PO #<id>'
        bank_snapshot  TEXT,                        -- JSON: bank + holder + MASKED iban only
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_setitems_settlement ON settlement_items(settlement_id);
      CREATE INDEX IF NOT EXISTS idx_setitems_shop ON settlement_items(shop_id);

      -- Append-only supplier ledger. amount_cents is SIGNED: purchases we owe
      -- the supplier are positive (credit_sale), refund reversals and payouts
      -- are negative. settlement_id marks a row as swept into a run.
      CREATE TABLE IF NOT EXISTS seller_balances (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id       INTEGER NOT NULL REFERENCES shops(id),
        order_id      INTEGER REFERENCES orders(id),
        settlement_id INTEGER REFERENCES settlements(id),
        type          TEXT NOT NULL,   -- credit_sale | debit_refund | payout
        amount_cents  INTEGER NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_balances_shop ON seller_balances(shop_id);
      CREATE INDEX IF NOT EXISTS idx_balances_order ON seller_balances(order_id);
      -- One purchase credit per (order, shop): webhook retries and re-runs can
      -- never double-credit a supplier.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_balances_credit_once
        ON seller_balances(order_id, shop_id) WHERE type='credit_sale';

      -- Self-billed purchase documentation: suppliers do not invoice Trove;
      -- Trove generates the paper trail for each settlement item.
      CREATE TABLE IF NOT EXISTS purchase_notes (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_item_id INTEGER NOT NULL REFERENCES settlement_items(id) ON DELETE CASCADE,
        shop_id            INTEGER NOT NULL REFERENCES shops(id),
        html_path          TEXT NOT NULL,           -- under PRIVATE_DIR, never /uploads
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Stripe webhook idempotency: event ids we have fully processed.
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id    TEXT PRIMARY KEY,
        type        TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
