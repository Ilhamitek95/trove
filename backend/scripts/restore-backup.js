#!/usr/bin/env node
'use strict';
/**
 * Put a backup back (F083). Step-by-step guide: RESTORE.md at the repo root.
 *
 *   node scripts/restore-backup.js --list
 *       the database copies on the server (backups/) and off-site
 *
 *   node scripts/restore-backup.js --db=latest              newest copy on the server
 *   node scripts/restore-backup.js --db=latest --remote     newest off-site copy
 *   node scripts/restore-backup.js --db=trove-20261001-2330.db [--remote]
 *       checks the copy (integrity + what is in it) and stops: a dry run.
 *       Add --yes to restore it: the current database is first saved as
 *       backups/trove-before-restore-*.db, then the copy is written into the
 *       live database with SQLite's online backup (safe while the site runs).
 *       Restart the service afterwards (Render → Manual Deploy → Restart service).
 *
 *   node scripts/restore-backup.js --files [--overwrite] [--yes]
 *       brings back photos (uploads) and private documents from off-site:
 *       files missing on the server (or, with --overwrite, every file).
 *
 * Off-site copies need the same BACKUP_S3_* variables and BACKUP_ENC_KEY the
 * server uses (on Render they are already set in the Shell).
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = Object.create(null);
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (!m) { console.error(`Unknown argument: ${a}`); process.exit(2); }
  args[m[1]] = m[2] === undefined ? true : m[2];
}

const offsite = require('../src/offsite-backup');
const backup = require('../src/backup');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'trove.db');
const NIGHTLY = /^trove-\d{8}-\d{4}\.db$/;

function fail(msg) { console.error(`\n${msg}\n`); process.exit(2); }
function cfgOrFail() {
  let cfg;
  try { cfg = offsite.config(); } catch (e) { fail(e.message); }
  if (!cfg) fail(`Off-site backup is not configured here (missing ${offsite.missing().join(', ')}).`);
  return cfg;
}
const localCopies = () => {
  const dir = backup.backupsDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.db$/.test(f)).sort() : [];
};

async function list() {
  console.log(`\nOn the server (${backup.backupsDir()}):`);
  const local = localCopies();
  console.log(local.length ? local.map((f) => `  ${f}`).join('\n') : '  (none)');
  let cfg = null;
  try { cfg = offsite.config(); } catch (e) { console.log(`\nOff-site: ${e.message}`); }
  if (!cfg) { console.log('\nOff-site: not configured.\n'); return; }
  const remote = (await offsite.list(cfg, `${cfg.prefix}db/`)).map((o) => o.key.slice(`${cfg.prefix}db/`.length).replace(/\.enc$/, '')).sort();
  console.log(`\nOff-site (${cfg.bucket}/${cfg.prefix}db/):`);
  console.log(remote.length ? remote.map((f) => `  ${f}`).join('\n') : '  (none)');
  const files = await offsite.list(cfg, `${cfg.prefix}files/`);
  console.log(`\nOff-site photos + documents: ${files.length} file(s)\n`);
}

/** The copy to restore, as a plain SQLite file on local disk: { file, label, temp }. */
async function fetchCopy(name) {
  if (args.remote) {
    const cfg = cfgOrFail();
    const keys = (await offsite.list(cfg, `${cfg.prefix}db/`)).map((o) => o.key).filter((k) => /\.db\.enc$/.test(k)).sort();
    const key = name === 'latest' ? keys[keys.length - 1]
      : keys.find((k) => k === `${cfg.prefix}db/${name}` || k === `${cfg.prefix}db/${name}.enc`);
    if (!key) fail(`No off-site copy called ${name}. Run with --list to see them.`);
    const tmpEnc = path.join(os.tmpdir(), `trove-restore-${process.pid}.enc`);
    const tmpDb = path.join(os.tmpdir(), `trove-restore-${process.pid}.db`);
    const res = await offsite.s3(cfg, { method: 'GET', key });
    fs.writeFileSync(tmpEnc, res.body);
    try { await offsite.decryptFile(tmpEnc, tmpDb, cfg.encKey); }
    catch (e) { fail(`Could not decrypt ${key}: ${e.message}. Is BACKUP_ENC_KEY the key the backup was made with?`); }
    finally { try { fs.unlinkSync(tmpEnc); } catch (_) { /* gone */ } }
    return { file: tmpDb, label: `off-site ${key}`, temp: true };
  }
  const dir = backup.backupsDir();
  const nightly = localCopies().filter((f) => NIGHTLY.test(f));
  const file = name === 'latest' ? (nightly.length ? path.join(dir, nightly[nightly.length - 1]) : null)
    : [path.join(dir, path.basename(name)), path.resolve(name)].find((f) => fs.existsSync(f));
  if (!file) fail(`No copy called ${name} on the server. Run with --list to see them.`);
  if (/\.enc$/.test(file)) {
    const cfg = cfgOrFail();
    const tmpDb = path.join(os.tmpdir(), `trove-restore-${process.pid}.db`);
    await offsite.decryptFile(file, tmpDb, cfg.encKey);
    return { file: tmpDb, label: file, temp: true };
  }
  return { file, label: file, temp: false };
}

async function restoreDb(name) {
  const Database = require('better-sqlite3');
  const copy = await fetchCopy(name);
  try {
    const src = new Database(copy.file, { readonly: true, fileMustExist: true });
    const check = src.prepare('PRAGMA integrity_check').pluck().get();
    if (check !== 'ok') { src.close(); fail(`${copy.label} failed the integrity check (${check}). Pick another copy.`); }
    const n = (t) => { try { return src.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get(); } catch (_) { return '?'; } };
    const last = (() => { try { return src.prepare('SELECT MAX(created_at) FROM orders').pluck().get() || '(no orders)'; } catch (_) { return '?'; } })();
    console.log(`\nCopy: ${copy.label}`);
    console.log(`  integrity: ok`);
    console.log(`  accounts ${n('users')} · shops ${n('shops')} · pieces ${n('products')} · orders ${n('orders')} · newest order ${last}`);
    console.log(`Live database: ${DB_PATH}`);
    if (!args.yes) {
      src.close();
      console.log('\nDry run - nothing was changed. Add --yes to restore this copy.\n');
      return;
    }
    const safety = backup.run(new Date(), { prefix: 'trove-before-restore' });
    console.log(`\nSaved the current database first: ${safety.file}`);
    await src.backup(DB_PATH);
    src.close();
    console.log(`Restored ${copy.label} into ${DB_PATH}.`);
    console.log('Now restart the service (Render → your service → Manual Deploy → Restart service) so every page reads the restored data.\n');
  } finally {
    if (copy.temp) { try { fs.unlinkSync(copy.file); } catch (_) { /* gone */ } }
  }
}

async function restoreFiles() {
  const cfg = cfgOrFail();
  const roots = offsite.roots();
  const objects = await offsite.list(cfg, `${cfg.prefix}files/`);
  const plan = [];
  for (const o of objects) {
    const m = /^files\/(uploads|private)\/(.+)\.enc$/.exec(o.key.slice(cfg.prefix.length));
    if (!m || m[2].split('/').some((s) => s === '..' || s === '')) continue;
    const dest = path.join(roots[m[1]], ...m[2].split('/'));
    if (!args.overwrite && fs.existsSync(dest) && fs.statSync(dest).size === o.size - offsite.OVERHEAD) continue;
    plan.push({ key: o.key, dest });
  }
  console.log(`\nOff-site files: ${objects.length}; to bring back: ${plan.length}${args.overwrite ? ' (overwrite)' : ' (missing or different on the server)'}`);
  if (!args.yes) { console.log('\nDry run - nothing was changed. Add --yes to download them.\n'); return; }
  let done = 0;
  for (const p of plan) {
    const res = await offsite.s3(cfg, { method: 'GET', key: p.key });
    fs.mkdirSync(path.dirname(p.dest), { recursive: true });
    fs.writeFileSync(p.dest, offsite.decryptBuffer(res.body, cfg.encKey));
    done++;
  }
  console.log(`Brought back ${done} file(s).\n`);
}

(async () => {
  if (args.list) return list();
  if (args.db) return restoreDb(String(args.db === true ? 'latest' : args.db));
  if (args.files) return restoreFiles();
  console.log('Use --list, --db=latest [--remote] [--yes] or --files [--yes]. See RESTORE.md.');
  return null;
})().catch((e) => { console.error(`\nRestore failed: ${e.message}\n`); process.exit(1); });
