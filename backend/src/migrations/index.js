'use strict';
/**
 * Tiny migration runner. Files in this directory named NNN-*.js export
 * { id, up(db) } and are applied once each, in filename order, recorded in
 * schema_migrations. The db handle is passed in — migration files must NOT
 * require('../db') (circular require: db.js calls this runner at the end of
 * its own initialisation).
 *
 * Safety (F274):
 *   - before anything is applied to a database that already has data, a
 *     copy is taken with backup.js (prefix 'pre-migration', the newest three
 *     kept, sign-in sessions removed like every backup) — a migration that
 *     commits but mangles data can be rolled back to the minute before it;
 *   - every pending migration of this boot runs inside ONE transaction, so a
 *     failure in any of them leaves the database exactly as the previous
 *     deploy had it (all of them or none), and the error names the file;
 *   - work outside the database (deleting files) must not happen inside that
 *     transaction, or a rollback would leave rows pointing at deleted files:
 *     a migration registers it with ctx.afterCommit(fn), run only once
 *     everything has committed.
 *
 * Numbering: each new file takes the next free number and never reuses one
 * (the two 016-… files are historical and stay as they are; parallel work
 * branches use 026-<letter>-… so their files never collide).
 */
const fs = require('fs');
const path = require('path');

function pending(db, dir = __dirname) {
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}-.*\.js$/.test(f)).sort();
  const out = [];
  for (const file of files) {
    const mig = require(path.join(dir, file));
    if (!mig.id || typeof mig.up !== 'function') throw new Error(`migration ${file} must export { id, up }`);
    if (!applied.has(mig.id)) out.push({ file, mig });
  }
  return { applied, todo: out };
}

// opts.dir: another folder of migration files (tests only).
function run(db, { backup = true, dir = __dirname } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const { applied, todo } = pending(db, dir);
  if (!todo.length) return [];

  // A brand-new database (nothing applied yet) has nothing worth copying.
  if (backup && applied.size && process.env.MIGRATION_BACKUP !== '0') {
    try {
      const { file } = require('../backup').run(new Date(), { prefix: 'pre-migration', db });
      console.log(`migrations: safety copy before ${todo.length} migration(s) → ${file}`);
    } catch (e) {
      // A failed copy (e.g. a full disk) is reported loudly but does not stop
      // the boot: the nightly backups still exist, and a site that cannot
      // start helps nobody. The migrations themselves stay all-or-nothing.
      console.error('migrations: could not take the pre-migration safety copy:', e.message);
    }
  }

  let current = null;
  const afterCommit = [];
  const ctx = { afterCommit: (fn) => afterCommit.push(fn) };
  try {
    db.transaction(() => {
      for (const { file, mig } of todo) {
        current = file;
        mig.up(db, ctx);
        db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(mig.id);
      }
    })();
  } catch (e) {
    e.message = `migration ${current} failed, so none of this boot's ${todo.length} migration(s) were applied: ${e.message}`;
    throw e;
  }
  for (const { mig } of todo) console.log(`migration applied: ${mig.id}`);
  for (const fn of afterCommit) {
    try { fn(); } catch (e) { console.error('migrations: after-commit step failed:', e.message); }
  }
  return todo.map((t) => t.mig.id);
}

module.exports = { run, pending };
