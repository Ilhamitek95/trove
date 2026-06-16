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

module.exports = db;
