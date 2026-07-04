'use strict';
/**
 * SQLite via better-sqlite3 — zero-config, single file (trove.db).
 * Swap to Postgres for production: keep the same column shapes, replace the
 * driver and the few `?`/`lastInsertRowid` idioms with your client's equivalents.
 *
 * Money is stored as integer minor units (fils for AED). Never store floats.
 */
const path = require('path');
const Database = require('better-sqlite3');

// DB_PATH lets the database live on a mounted persistent disk in production
// (e.g. Render Disk). Defaults to a local file for development.
const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'trove.db');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'buyer',   -- buyer | seller | both | admin
  stripe_customer_id TEXT,                        -- buyer side (saved cards live on Stripe)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shops (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  slug               TEXT UNIQUE NOT NULL,
  bio                TEXT DEFAULT '',
  location           TEXT DEFAULT '',
  color              TEXT DEFAULT '#A98B7D',
  is_house           INTEGER NOT NULL DEFAULT 0,  -- 1 = the trove label house brand
  stripe_account_id  TEXT,                        -- Stripe Connect (Express) account
  charges_enabled    INTEGER NOT NULL DEFAULT 0,
  payouts_enabled    INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id          INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT DEFAULT '',
  category         TEXT DEFAULT 'Home',
  price_cents      INTEGER NOT NULL,
  compare_at_cents INTEGER,
  stock            INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft', -- live | draft | hidden
  image_seed       TEXT DEFAULT 'new',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS addresses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT DEFAULT 'Home',
  name       TEXT NOT NULL,
  line       TEXT NOT NULL,
  city       TEXT NOT NULL,
  country    TEXT NOT NULL DEFAULT 'United Arab Emirates',
  phone      TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id                TEXT UNIQUE NOT NULL,   -- e.g. TRV-9F2K
  buyer_id                 INTEGER REFERENCES users(id),
  email                    TEXT NOT NULL,
  subtotal_cents           INTEGER NOT NULL,
  shipping_cents           INTEGER NOT NULL DEFAULT 0,
  total_cents              INTEGER NOT NULL,
  currency                 TEXT NOT NULL DEFAULT 'aed',
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending | paid | fulfilled | cancelled | failed
  shipping_json            TEXT,                   -- snapshot of the chosen address
  stripe_payment_intent_id TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id),
  shop_id          INTEGER NOT NULL REFERENCES shops(id),
  name_snapshot    TEXT NOT NULL,
  price_cents      INTEGER NOT NULL,               -- unit price at time of purchase
  qty              INTEGER NOT NULL,
  transfer_id      TEXT                            -- Stripe transfer to the shop (set after payout)
);

CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_shop ON order_items(shop_id);
`);

/* ---- additive migrations (safe to run on an existing database) ---- */
function addColumn(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}
// How each shop is paid: 'managed' (Trove collects, then pays out weekly by bank
// transfer) or 'connect' (seller's own Stripe account, paid per sale). The bank
// fields are used by the weekly managed-payout run.
addColumn('shops', 'payout_type',         "TEXT NOT NULL DEFAULT 'managed'");
// Seller-uploaded shop photo (public URL path under /uploads; '' = colour tile).
addColumn('shops', 'image',               "TEXT DEFAULT ''");
// Marketplace curation: new shops are 'pending' until the super admin approves
// them. Only 'approved' shops appear on the storefront or can be bought from.
// Default 'approved' so shops that existed before this feature stay live.
addColumn('shops', 'status',              "TEXT NOT NULL DEFAULT 'approved'");
// Seller application details, filled in when applying to open a shop and
// shown to the super admin in the review queue.
addColumn('shops', 'category',            "TEXT DEFAULT ''");   // main category they sell in
addColumn('shops', 'pitch_products',      "TEXT DEFAULT ''");   // what they plan to sell
addColumn('shops', 'pitch_links',         "TEXT DEFAULT ''");   // website (optional)
addColumn('shops', 'pitch_instagram',     "TEXT DEFAULT ''");   // instagram (required to apply)
addColumn('shops', 'pitch_experience',    "TEXT DEFAULT ''");   // how long they've been making
addColumn('shops', 'pitch_maker',         "TEXT DEFAULT ''");   // who makes the products
addColumn('shops', 'pitch_channels',      "TEXT DEFAULT ''");   // where they sell today
addColumn('shops', 'pitch_capacity',      "TEXT DEFAULT ''");   // orders/month they can handle
addColumn('shops', 'pitch_phone',         "TEXT DEFAULT ''");   // WhatsApp for the curation team
addColumn('shops', 'payout_bank_name',    "TEXT DEFAULT ''");
addColumn('shops', 'payout_account_name', "TEXT DEFAULT ''");
addColumn('shops', 'payout_iban',         "TEXT DEFAULT ''");
// Buyer service fee captured per order (delivery lives in shipping_cents).
addColumn('orders', 'service_fee_cents',  'INTEGER NOT NULL DEFAULT 0');
// Set when a managed sale has been swept into a weekly payout batch.
addColumn('order_items', 'payout_id',     'INTEGER');
// Etsy-style order personalisation: the seller switches it on per product and
// writes the prompt the buyer sees; the buyer's text is stored on the line item.
addColumn('products', 'personalization_enabled',  'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'personalization_required', 'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'personalization_prompt',   "TEXT DEFAULT ''");
addColumn('products', 'personalization_char_limit', 'INTEGER NOT NULL DEFAULT 256');
addColumn('order_items', 'personalization', "TEXT DEFAULT ''");
// Shopper search tags, a JSON array of short lowercase phrases. Sellers type
// them (or let Claude write them) in the product drawer; /api/products?q=
// matches against them.
addColumn('products', 'tags', "TEXT DEFAULT '[]'");

db.exec(`
CREATE TABLE IF NOT EXISTS payouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  amount_cents  INTEGER NOT NULL,                 -- net paid to the shop (after the platform fee)
  gross_cents   INTEGER NOT NULL DEFAULT 0,       -- shop sales before the fee
  fee_cents     INTEGER NOT NULL DEFAULT 0,       -- Trove's cut
  item_count    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | paid
  bank_snapshot TEXT,                             -- bank details captured at run time
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_payouts_shop ON payouts(shop_id);
CREATE INDEX IF NOT EXISTS idx_items_payout ON order_items(payout_id);

CREATE TABLE IF NOT EXISTS shipments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shop_id         INTEGER NOT NULL REFERENCES shops(id),
  status          TEXT NOT NULL DEFAULT 'processing', -- processing | shipped | out_for_delivery | delivered | cancelled
  carrier         TEXT DEFAULT '',
  tracking_number TEXT DEFAULT '',
  tracking_url    TEXT DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shipment_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_shop ON shipments(shop_id);
CREATE INDEX IF NOT EXISTS idx_shipevents_ship ON shipment_events(shipment_id);

-- Anonymous shopper search log (query text only, no user ids). Feeds the
-- trending-terms context the AI tag writer uses. See src/trends.js.
CREATE TABLE IF NOT EXISTS search_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  q          TEXT NOT NULL,
  results    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_search_log_time ON search_log(created_at);
`);

// Versioned migrations run last, so they always see the full baseline schema
// (fresh databases included). See src/migrations/index.js.
require('./migrations').run(db);

module.exports = db;
