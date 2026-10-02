'use strict';
/**
 * F141: `npm run seed` empties the database. It must refuse on production and
 * on a database with real accounts unless --force-wipe is given, and back up
 * a non-empty database before it wipes anything. Runs seed.js as a separate
 * process against throwaway databases, exactly as `npm run seed` would.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND = path.join(__dirname, '..');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-seed-guard-'));
  return { dir, file: path.join(dir, 'trove.db') };
}
function run(args, { db, nodeEnv }) {
  const env = { ...process.env, DB_PATH: db.file, UPLOADS_DIR: path.join(db.dir, 'uploads'), PRIVATE_DIR: path.join(db.dir, 'private') };
  delete env.ANTHROPIC_API_KEY;
  delete env.BACKUPS_DIR;
  if (nodeEnv) env.NODE_ENV = nodeEnv; else delete env.NODE_ENV;
  return spawnSync(process.execPath, args, { cwd: BACKEND, env, encoding: 'utf8', timeout: 60000 });
}
const sql = (db, code) => run(['-e', `const d=require('./src/db');${code}`], { db, nodeEnv: 'development' });
const count = (db, q) => Number(sql(db, `process.stdout.write(String(d.prepare(${JSON.stringify(q)}).get().n))`).stdout);
const backups = (db) => (fs.existsSync(path.join(db.dir, 'backups')) ? fs.readdirSync(path.join(db.dir, 'backups')) : []);

test('seed refuses on production, even on an empty database', () => {
  const db = freshDb();
  const r = run(['src/seed.js'], { db, nodeEnv: 'production' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refused/);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users'), 0, 'nothing was seeded');
});

test('seed refuses a database with real accounts, and keeps them', () => {
  const db = freshDb();
  sql(db, "d.prepare(\"INSERT INTO users (email,password_hash,name,role) VALUES ('real.buyer@gmail.com','x','Real','buyer')\").run()");
  const r = run(['src/seed.js'], { db, nodeEnv: 'development' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not demo logins/);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM users WHERE email='real.buyer@gmail.com'"), 1, 'the real account survived');
  assert.deepEqual(backups(db), []);
});

test('seed runs on an empty or demo-only local database; a rerun backs up first', () => {
  const db = freshDb();
  const first = run(['src/seed.js'], { db, nodeEnv: 'development' });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(count(db, 'SELECT COUNT(*) AS n FROM users') > 3);
  assert.deepEqual(backups(db), [], 'an empty database needs no backup');
  const again = run(['src/seed.js'], { db, nodeEnv: 'development' });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(backups(db).some((f) => /^trove-before-seed-\d{8}-\d{4}\.db$/.test(f)), 'backed up before the wipe');
});

test('--force-wipe overrides the guard, after a backup', () => {
  const db = freshDb();
  sql(db, "d.prepare(\"INSERT INTO users (email,password_hash,name,role) VALUES ('real.maker@gmail.com','x','Real','seller')\").run()");
  const r = run(['src/seed.js', '--force-wipe'], { db, nodeEnv: 'development' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM users WHERE email='real.maker@gmail.com'"), 0);
  assert.ok(backups(db).some((f) => f.startsWith('trove-before-seed-')));
});

test('the boot-time SEED_DEMO seed never runs in production', () => {
  const src = fs.readFileSync(path.join(BACKEND, 'src', 'server.js'), 'utf8');
  assert.match(src, /SEED_DEMO === '1'[\s\S]{0,200}NODE_ENV === 'production'/);
  const yaml = fs.readFileSync(path.join(BACKEND, '..', 'render.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /key:\s*SEED_DEMO/, 'render.yaml does not set SEED_DEMO');
  const readme = fs.readFileSync(path.join(BACKEND, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /Shell\*\* → `npm run seed`/, 'README no longer tells the owner to seed on Render');
});
