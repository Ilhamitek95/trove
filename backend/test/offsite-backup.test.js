'use strict';
/**
 * F083 off-site backups: the nightly job sends an encrypted database copy and
 * mirrors photos + private documents to S3-compatible storage (a fake S3
 * here that checks every Signature V4 itself), rotates old copies, alerts
 * the owner on failure and sends a weekly OK; scripts/restore-backup.js puts
 * a database copy and the files back.
 */
const { testEnv } = require('./helpers');
const KEY = 'ab'.repeat(32);
testEnv({ ADMIN_EMAIL: 'owner@test.local', BACKUP_KEEP: '3' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/* ---- a fake S3 bucket that verifies SigV4 independently ---- */
const store = new Map(); // key -> Buffer
let failNext = 0;
let rejectedSignatures = 0;
const KEY_ID = 'test-key-id';
const SECRET = 'test-secret-value';
const BUCKET = 'trove-backups';

function verify(req, url) {
  const auth = req.headers.authorization || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m || m[1] !== KEY_ID) return false;
  const [, , day, region, signedHeaders, sig] = m;
  const q = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const names = signedHeaders.split(';');
  const canon = [req.method, url.pathname, q, names.map((h) => `${h}:${req.headers[h]}\n`).join(''), signedHeaders, req.headers['x-amz-content-sha256']].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${day}/${region}/s3/aws4_request`, crypto.createHash('sha256').update(canon).digest('hex')].join('\n');
  const h = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const kSign = h(h(h(h(`AWS4${SECRET}`, day), region), 's3'), 'aws4_request');
  return crypto.createHmac('sha256', kSign).update(toSign).digest('hex') === sig;
}

const s3server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!verify(req, url)) { rejectedSignatures++; res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
    if (failNext > 0) { failNext--; res.writeHead(500); return res.end('<Error><Code>InternalError</Code></Error>'); }
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (parts[0] !== BUCKET) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
    const key = parts.slice(1).join('/');
    if (req.method === 'PUT') { store.set(key, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
    if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && !key) {
      // ListObjectsV2, two keys per page so continuation is exercised
      const prefix = url.searchParams.get('prefix') || '';
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get('continuation-token') || 0);
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${store.get(k).length}</Size></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    if (req.method === 'GET') {
      if (!store.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
      res.writeHead(200); return res.end(store.get(key));
    }
    res.writeHead(405); res.end();
  });
});

let endpoint, db, offsite, sent;
const ENV = () => ({ ...process.env, BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_KEY_ID: KEY_ID, BACKUP_S3_SECRET: SECRET, BACKUP_ENC_KEY: KEY, BACKUP_REMOTE_KEEP: '2' });
const up = (rel, content) => { const f = path.join(process.env.UPLOADS_DIR, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
const priv = (rel, content) => { const f = path.join(process.env.PRIVATE_DIR, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };

before(async () => {
  await new Promise((r) => s3server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${s3server.address().port}`;
  db = require('../src/db');
  offsite = require('../src/offsite-backup');
  sent = [];
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@test.local','x','Owner','admin')").run();
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer1@test.local','x','Buyer One','buyer')").run();
});
after(() => new Promise((r) => s3server.close(r)));

test('encryption round-trips and refuses a tampered or foreign file', async () => {
  const key = Buffer.from(KEY, 'hex');
  const blob = offsite.encryptBuffer(Buffer.from('hello trove'), key);
  assert.equal(blob.length, 'hello trove'.length + offsite.OVERHEAD);
  assert.equal(offsite.decryptBuffer(blob, key).toString(), 'hello trove');
  blob[blob.length - 20] ^= 1;
  assert.throws(() => offsite.decryptBuffer(blob, key));
  assert.throws(() => offsite.decryptBuffer(offsite.encryptBuffer(Buffer.from('x'), key), Buffer.alloc(32, 7)));
  // file streaming
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trove-enc-'));
  const src = path.join(dir, 'a.bin');
  fs.writeFileSync(src, crypto.randomBytes(300000));
  await offsite.encryptFile(src, path.join(dir, 'a.enc'), key);
  assert.ok(!fs.readFileSync(path.join(dir, 'a.enc')).includes(fs.readFileSync(src).subarray(0, 64)), 'nothing in the clear');
  await offsite.decryptFile(path.join(dir, 'a.enc'), path.join(dir, 'b.bin'), key);
  assert.ok(fs.readFileSync(path.join(dir, 'b.bin')).equals(fs.readFileSync(src)));
});

test('config: off unless all five variables are set; a malformed key is refused', () => {
  assert.equal(offsite.config({}), null);
  assert.equal(offsite.config({ ...ENV(), BACKUP_S3_SECRET: '' }), null);
  assert.throws(() => offsite.config({ ...ENV(), BACKUP_ENC_KEY: 'short' }), /64 hex/);
  assert.equal(offsite.config(ENV()).region, 'auto');
});

test('not configured: the nightly job still makes the local copy and says off-site is off', async () => {
  const r = await offsite.nightly(new Date('2026-10-04T23:30:00Z'), { ...process.env }); // Monday 03:30 Dubai
  assert.equal(r.error, null);
  assert.ok(fs.existsSync(r.local.file));
  assert.match(r.offsite.skipped, /not configured/);
  const weekly = sent.find((m) => /off-site copy not set up/.test(m.subject));
  assert.ok(weekly, 'the Monday note tells the owner the off-site copy is not set up');
  assert.equal(weekly.to, 'owner@test.local');
  assert.equal(store.size, 0);
});

test('nightly: encrypted database copy + files mirror off-site; unchanged files are not re-sent; deletions follow', async () => {
  up('products/prod-1-1-0-1.jpg', Buffer.from('JPEGDATA-one'));
  up('products/prod-1-1-0-1.w480.jpg', Buffer.from('small'));
  up('shops/shop-1-2.jpg', Buffer.from('banner'));
  priv('eid/shop-1-front-3.enc', Buffer.from('already-encrypted-id'));
  const r1 = await offsite.nightly(new Date('2026-10-05T23:30:00Z'), ENV()); // Tuesday
  assert.equal(r1.error, null, r1.error && r1.error.message);
  assert.equal(rejectedSignatures, 0, 'every request carried a valid signature');
  const dbKeys = [...store.keys()].filter((k) => k.startsWith('trove/db/'));
  assert.equal(dbKeys.length, 1);
  const blob = store.get(dbKeys[0]);
  assert.ok(!blob.includes(Buffer.from('SQLite format 3')), 'the database copy is encrypted');
  assert.ok(!blob.includes(Buffer.from('buyer1@test.local')));
  assert.equal(r1.offsite.files.uploaded, 4);
  assert.ok(store.has('trove/files/uploads/products/prod-1-1-0-1.jpg.enc'));
  assert.ok(store.has('trove/files/private/eid/shop-1-front-3.enc.enc'));
  assert.ok(!store.get('trove/files/uploads/shops/shop-1-2.jpg.enc').includes(Buffer.from('banner')));

  // second night: nothing new → nothing re-sent; a removed photo disappears off-site
  fs.unlinkSync(path.join(process.env.UPLOADS_DIR, 'shops/shop-1-2.jpg'));
  const r2 = await offsite.nightly(new Date('2026-10-06T23:31:00Z'), ENV());
  assert.equal(r2.error, null);
  assert.equal(r2.offsite.files.uploaded, 0);
  assert.equal(r2.offsite.files.deleted, 1);
  assert.equal(r2.offsite.files.unchanged, 3);
  assert.ok(!store.has('trove/files/uploads/shops/shop-1-2.jpg.enc'), 'erased on the server → erased off-site');

  // third night: rotation keeps BACKUP_REMOTE_KEEP (2) database copies
  const r3 = await offsite.nightly(new Date('2026-10-07T23:32:00Z'), ENV());
  assert.equal(r3.error, null);
  assert.equal([...store.keys()].filter((k) => k.startsWith('trove/db/')).length, 2);
  assert.equal(r3.offsite.rotated.length, 1);
});

test('a failure emails the owner once a day, naming the last good backup', async () => {
  sent.length = 0;
  failNext = 1;
  const r = await offsite.nightly(new Date('2026-10-08T23:30:00Z'), ENV());
  assert.ok(r.error);
  const alerts = sent.filter((m) => /backup FAILED/.test(m.subject));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].to, 'owner@test.local');
  assert.match(alerts[0].html, /HTTP 500/);
  assert.match(alerts[0].html, /last backup that worked/i);
  failNext = 1;
  await offsite.nightly(new Date('2026-10-08T23:45:00Z'), ENV());
  assert.equal(sent.filter((m) => /backup FAILED/.test(m.subject)).length, 1, 'not twice on the same day');
});

test('weekly OK on Monday when off-site is on', async () => {
  sent.length = 0;
  const r = await offsite.nightly(new Date('2026-10-11T23:30:00Z'), ENV()); // Monday 12 Oct, Dubai
  assert.equal(r.error, null);
  const ok = sent.find((m) => m.subject === 'Trove backups OK');
  assert.ok(ok);
  assert.match(ok.html, /Off-site: database copy uploaded/);
});

/* ---- restore script, run exactly as the owner would ---- */
function runScript(args) {
  return new Promise((resolve) => {
    const env = { ...ENV() };
    delete env.ANTHROPIC_API_KEY;
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-backup.js'), ...args],
      { cwd: path.join(__dirname, '..'), env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('restore script: lists, dry-runs, then restores the newest off-site database copy into the live file', async () => {
  // the newest off-site copy has buyer1 but not buyer2
  const r = await offsite.nightly(new Date('2026-10-12T23:30:00Z'), ENV());
  assert.equal(r.error, null);
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer2@test.local','x','Late','buyer')").run();
  db.prepare("DELETE FROM users WHERE email='buyer1@test.local'").run();

  const ls = await runScript(['--list']);
  assert.equal(ls.code, 0, ls.stderr);
  assert.match(ls.stdout, /Off-site \(trove-backups\/trove\/db\/\):[\s\S]*trove-20261012-2330\.db/);

  const dry = await runScript(['--db=latest', '--remote']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /integrity: ok/);
  assert.match(dry.stdout, /Dry run/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email='buyer1@test.local'").get().n, 0, 'dry run changed nothing');

  const real = await runScript(['--db=latest', '--remote', '--yes']);
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /Saved the current database first: .*trove-before-restore-/);
  // this process's own connection sees the restored data
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email='buyer1@test.local'").get().n, 1, 'restored');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email='buyer2@test.local'").get().n, 0);
  assert.ok(fs.readdirSync(require('../src/backup').backupsDir()).some((f) => f.startsWith('trove-before-restore-')));
});

test('restore script: brings back missing photos and documents from off-site', async () => {
  const lost = path.join(process.env.UPLOADS_DIR, 'products/prod-1-1-0-1.jpg');
  const lostId = path.join(process.env.PRIVATE_DIR, 'eid/shop-1-front-3.enc');
  fs.unlinkSync(lost); fs.unlinkSync(lostId);
  const dry = await runScript(['--files']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /to bring back: 2/);
  assert.ok(!fs.existsSync(lost));
  const real = await runScript(['--files', '--yes']);
  assert.equal(real.code, 0, real.stderr);
  assert.equal(fs.readFileSync(lost, 'utf8'), 'JPEGDATA-one');
  assert.equal(fs.readFileSync(lostId, 'utf8'), 'already-encrypted-id');
});

test('server.js schedules the combined nightly job', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/offsite-backup'\)\.nightly\(\)/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'RESTORE.md')), 'RESTORE.md exists');
});
