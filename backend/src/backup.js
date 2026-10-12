'use strict';
/**
 * Nightly SQLite backup — `VACUUM INTO` writes a consistent, compacted copy
 * of the live database while the site keeps serving (WAL mode, no lock on
 * readers or writers). Copies land next to the database in `backups/`
 * (BACKUPS_DIR overrides) on the persistent disk and the newest KEEP are
 * kept, so a bad migration, an accidental admin delete or a corrupted file
 * can be rolled back from the previous night without leaving Render.
 *
 * These local copies protect against data mistakes, not disk loss: the
 * nightly job (offsite-backup.js nightly()) also sends an encrypted copy of
 * each one, plus the photos and private documents, off-site when BACKUP_S3_*
 * are set. How to put one back: RESTORE.md / scripts/restore-backup.js.
 *
 * No live sign-ins in a copy (F278): the sessions table holds the ids the
 * sign-in cookies carry, so anyone holding a copy (and the session secret)
 * could sign in as anyone. Each copy is emptied of them right after VACUUM
 * INTO — in the copy only, never the live database — with secure_delete on
 * and a second VACUUM, so no trace stays in the file's free pages. A restore
 * simply signs everyone out.
 *
 * Also used before migrations run (migrations/index.js, prefix
 * 'pre-migration'), which is why the database handle can be passed in: that
 * runs while db.js is still opening the database.
 */
const fs = require('fs');
const path = require('path');

const KEEP = Number(process.env.BACKUP_KEEP || 7);
const PRE_MIGRATION_KEEP = 3;

function backupsDir() {
  if (process.env.BACKUPS_DIR) return process.env.BACKUPS_DIR;
  const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'trove.db');
  return path.join(path.dirname(dbFile), 'backups');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** Empty the sessions table of a backup copy (never the live file). */
function stripSessions(file) {
  const Database = require('better-sqlite3');
  const copy = new Database(file);
  try {
    copy.pragma('journal_mode = DELETE'); // no -wal file left beside the copy
    const has = copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    if (has) {
      copy.pragma('secure_delete = ON');
      copy.exec('DELETE FROM sessions');
      copy.exec('VACUUM');
    }
  } finally {
    copy.close();
  }
}

/**
 * Write one backup and prune old ones. Returns { file, kept, removed }.
 * opts.prefix names a one-off copy (e.g. 'trove-qa-cleanup'); such a file
 * does not match the nightly pattern, so the rotation below never prunes it
 * (pre-migration copies keep their own newest PRE_MIGRATION_KEEP).
 * opts.db: the database handle (default: the app's, src/db.js).
 */
function run(now = new Date(), opts = {}) {
  const db = opts.db || require('./db');
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const prefix = /^[a-z0-9-]+$/.test(opts.prefix || '') ? opts.prefix : 'trove';
  const file = path.join(dir, `${prefix}-${stamp(now)}.db`);
  // A same-minute rerun would collide; VACUUM INTO refuses to overwrite.
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try {
    stripSessions(file);
  } catch (e) {
    // A copy that still holds sign-ins must not be kept (or sent off-site).
    try { fs.unlinkSync(file); } catch (_) { /* best effort */ }
    throw new Error(`backup: could not clear sign-in sessions from the copy (${e.message})`);
  }

  const prune = (pattern, keep) => {
    const all = fs.readdirSync(dir).filter((f) => pattern.test(f)).sort(); // the timestamp sorts lexically
    const removed = [];
    while (all.length > keep) {
      const old = all.shift();
      try { fs.unlinkSync(path.join(dir, old)); removed.push(old); } catch (_) { /* best effort */ }
    }
    return { kept: all.length, removed };
  };
  if (prefix === 'pre-migration') {
    const r = prune(/^pre-migration-\d{8}-\d{4}\.db$/, PRE_MIGRATION_KEEP);
    return { file, ...r };
  }
  const r = prune(/^trove-\d{8}-\d{4}\.db$/, KEEP);
  return { file, ...r };
}

module.exports = { run, backupsDir, stripSessions, KEEP, PRE_MIGRATION_KEEP };
