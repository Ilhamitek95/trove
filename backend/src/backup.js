'use strict';
/**
 * Nightly SQLite backup — `VACUUM INTO` writes a consistent, compacted copy
 * of the live database while the site keeps serving (WAL mode, no lock on
 * readers or writers). Copies land next to the database in `backups/`
 * (BACKUPS_DIR overrides) on the persistent disk and the newest KEEP are
 * kept, so a bad migration, an accidental admin delete or a corrupted file
 * can be rolled back from the previous night without leaving Render.
 *
 * This protects against data mistakes, not disk loss — Render's own disk
 * snapshots cover the disk itself.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const KEEP = Number(process.env.BACKUP_KEEP || 7);

function backupsDir() {
  if (process.env.BACKUPS_DIR) return process.env.BACKUPS_DIR;
  const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'trove.db');
  return path.join(path.dirname(dbFile), 'backups');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** Write one backup and prune old ones. Returns { file, kept, removed }. */
function run(now = new Date()) {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `trove-${stamp(now)}.db`);
  // A same-minute rerun would collide; VACUUM INTO refuses to overwrite.
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  const all = fs.readdirSync(dir)
    .filter((f) => /^trove-\d{8}-\d{4}\.db$/.test(f))
    .sort(); // the timestamp sorts lexically
  const removed = [];
  while (all.length > KEEP) {
    const old = all.shift();
    try { fs.unlinkSync(path.join(dir, old)); removed.push(old); } catch (_) { /* best effort */ }
  }
  return { file, kept: all.length, removed };
}

module.exports = { run, backupsDir, KEEP };
