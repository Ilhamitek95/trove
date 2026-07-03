'use strict';
/**
 * Tiny migration runner. Files in this directory named NNN-*.js export
 * { id, up(db) } and are applied once each, in filename order, inside a
 * transaction, recorded in schema_migrations. The db handle is passed in —
 * migration files must NOT require('../db') (circular require: db.js calls
 * this runner at the end of its own initialisation).
 */
const fs = require('fs');
const path = require('path');

function run(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const files = fs.readdirSync(__dirname).filter((f) => /^\d{3}-.*\.js$/.test(f)).sort();
  for (const file of files) {
    const mig = require(path.join(__dirname, file));
    if (!mig.id || typeof mig.up !== 'function') throw new Error(`migration ${file} must export { id, up }`);
    if (applied.has(mig.id)) continue;
    db.transaction(() => {
      mig.up(db);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(mig.id);
    })();
    console.log(`migration applied: ${mig.id}`);
  }
}

module.exports = { run };
