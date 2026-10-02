'use strict';
/**
 * Off-site backups (F083, owner 2026-10-02). The nightly VACUUM INTO copy
 * (backup.js) sits on the same Render disk as the live database; this module
 * sends an ENCRYPTED copy of it, and of every uploaded photo and private
 * document, to S3-compatible storage (Cloudflare R2, AWS S3, Backblaze B2 …),
 * so losing the disk — or the whole Render account — is survivable.
 *
 * Switched on by environment variables (all five required; nothing is sent
 * without them and the nightly job says so in the weekly email):
 *   BACKUP_S3_ENDPOINT   e.g. https://<account id>.r2.cloudflarestorage.com
 *   BACKUP_S3_BUCKET     e.g. trove-backups
 *   BACKUP_S3_KEY_ID     the access key id of an API token limited to that bucket
 *   BACKUP_S3_SECRET     its secret
 *   BACKUP_ENC_KEY       64 hex characters (32 bytes). Keep a copy OUTSIDE
 *                        Render (password manager): without it the off-site
 *                        copies cannot be read.
 * Optional: BACKUP_S3_REGION (default 'auto', R2's; AWS needs the bucket's
 * region), BACKUP_S3_PREFIX (default 'trove/'), BACKUP_REMOTE_KEEP (database
 * copies kept off-site, default 14 — older ones are deleted so erased
 * personal data does not live on in old copies for ever).
 *
 * Layout in the bucket:
 *   <prefix>db/trove-YYYYMMDD-HHMM.db.enc          one per night
 *   <prefix>files/uploads/<path>.enc                mirror of UPLOADS_DIR
 *   <prefix>files/private/<path>.enc                mirror of PRIVATE_DIR
 * The file mirror is a sync: new or changed files go up, files deleted on
 * the server (a removed photo, an erased ID document) are deleted off-site
 * the same night.
 *
 * Encryption: AES-256-GCM; an encrypted object is 'TRVB1' + 12-byte IV +
 * ciphertext + 16-byte tag. Requests are signed with AWS Signature V4
 * (no SDK dependency). scripts/restore-backup.js reads all of this back —
 * see RESTORE.md.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const MAGIC = Buffer.from('TRVB1');
const IV_LEN = 12;
const TAG_LEN = 16;
const OVERHEAD = MAGIC.length + IV_LEN + TAG_LEN;
const EMPTY_SHA = crypto.createHash('sha256').update('').digest('hex');

/* ---------------- configuration ---------------- */

/** The off-site settings, or null when any required one is missing. Throws on a malformed key. */
function config(env = process.env) {
  const need = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET', 'BACKUP_ENC_KEY'];
  if (need.some((k) => !String(env[k] || '').trim())) return null;
  const key = String(env.BACKUP_ENC_KEY).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('BACKUP_ENC_KEY must be 64 hex characters (32 bytes)');
  let prefix = String(env.BACKUP_S3_PREFIX == null ? 'trove/' : env.BACKUP_S3_PREFIX).trim().replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return {
    endpoint: new URL(String(env.BACKUP_S3_ENDPOINT).trim()),
    bucket: String(env.BACKUP_S3_BUCKET).trim(),
    keyId: String(env.BACKUP_S3_KEY_ID).trim(),
    secret: String(env.BACKUP_S3_SECRET).trim(),
    region: String(env.BACKUP_S3_REGION || 'auto').trim(),
    encKey: Buffer.from(key, 'hex'),
    prefix,
    keep: Math.max(1, Number(env.BACKUP_REMOTE_KEEP) || 14),
  };
}
const missing = (env = process.env) => ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET', 'BACKUP_ENC_KEY']
  .filter((k) => !String(env[k] || '').trim());

/* ---------------- encryption ---------------- */

function encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}
function decryptBuffer(buf, key) {
  if (buf.length < OVERHEAD || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Trove backup file');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(buf.subarray(buf.length - TAG_LEN));
  return Buffer.concat([d.update(buf.subarray(MAGIC.length + IV_LEN, buf.length - TAG_LEN)), d.final()]);
}
/** Stream-encrypt a (large) file. */
async function encryptFile(src, dst, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dst);
  out.write(Buffer.concat([MAGIC, iv]));
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(src);
    input.on('error', reject);
    c.on('error', reject);
    out.on('error', reject);
    input.pipe(c).on('data', (d) => { if (!out.write(d)) { c.pause(); out.once('drain', () => c.resume()); } })
      .on('end', () => { out.end(c.getAuthTag(), resolve); });
  });
}
/** Stream-decrypt a file written by encryptFile (or encryptBuffer). Throws if it was altered. */
async function decryptFile(src, dst, key) {
  const size = fs.statSync(src).size;
  if (size < OVERHEAD) throw new Error('not a Trove backup file');
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(MAGIC.length + IV_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, head, 0, head.length, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { fs.closeSync(fd); }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Trove backup file');
  const d = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
  d.setAuthTag(tag);
  const tmp = `${dst}.partial`;
  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(src, { start: head.length, end: size - TAG_LEN - 1 });
      const out = fs.createWriteStream(tmp);
      input.on('error', reject); d.on('error', reject); out.on('error', reject);
      out.on('finish', resolve);
      input.pipe(d).pipe(out);
    });
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing written */ }
    throw e;
  }
}

/* ---------------- S3 (Signature V4) ---------------- */

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// RFC 3986 encoding, as S3 wants it (keeps A-Z a-z 0-9 - _ . ~).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * One signed request. { method, key, query, body: Buffer | path-to-file, }
 * Resolves { status, headers, body: Buffer }; rejects on network errors and
 * on any status outside 2xx (except allow404 for GET/DELETE).
 */
function s3(cfg, { method, key = '', query = {}, body = null, allow404 = false }) {
  const base = cfg.endpoint.pathname.replace(/\/+$/, '');
  const uriPath = `${base}/${enc(cfg.bucket)}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const isFile = typeof body === 'string';
  const payloadHash = body == null ? EMPTY_SHA : 'UNSIGNED-PAYLOAD';
  const length = body == null ? 0 : isFile ? fs.statSync(body).size : body.length;
  const host = cfg.endpoint.host;
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [method, uriPath, qs, signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, day), cfg.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  const lib = cfg.endpoint.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method, host: cfg.endpoint.hostname, port: cfg.endpoint.port || undefined,
      path: uriPath + (qs ? `?${qs}` : ''),
      headers: { ...headers, authorization: auth, 'content-length': length },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) };
        if ((res.statusCode >= 200 && res.statusCode < 300) || (allow404 && res.statusCode === 404)) return resolve(out);
        const code = (/<Code>([^<]*)<\/Code>/.exec(out.body.toString('utf8')) || [])[1] || '';
        const e = new Error(`off-site storage ${method} ${key || '(bucket)'}: HTTP ${res.statusCode}${code ? ` ${code}` : ''}`);
        e.status = res.statusCode;
        reject(e);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`off-site storage ${method} ${key}: timed out`)));
    req.on('error', reject);
    if (body == null) req.end();
    else if (isFile) fs.createReadStream(body).on('error', reject).pipe(req);
    else req.end(body);
  });
}

const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Every object under a prefix: [{ key, size }] (follows continuation tokens). */
async function list(cfg, prefix) {
  const out = [];
  let token = null;
  for (let guard = 0; guard < 10000; guard++) {
    const query = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const xml = (await s3(cfg, { method: 'GET', query })).body.toString('utf8');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = (/<Key>([\s\S]*?)<\/Key>/.exec(m[1]) || [])[1];
      const size = Number((/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1] || 0);
      if (key != null) out.push({ key: xmlDecode(key), size });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated ? xmlDecode((/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml) || [])[1] || '') : null;
    if (!token) break;
  }
  return out;
}

/* ---------------- what is backed up ---------------- */

const uploadsDir = () => require('./uploads').UPLOADS_DIR;
const privateDir = () => process.env.PRIVATE_DIR || path.join(uploadsDir(), '..', 'private');
/** The folders mirrored off-site, by their name in the bucket. */
const roots = () => ({ uploads: path.resolve(uploadsDir()), private: path.resolve(privateDir()) });

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && !e.name.endsWith('.partial')) out.push(full);
  }
  return out;
}

/** Upload one local database backup (a VACUUM INTO file), encrypted. Returns its key. */
async function uploadDb(cfg, file) {
  const tmp = path.join(os.tmpdir(), `trove-offsite-${process.pid}-${Date.now()}.enc`);
  try {
    await encryptFile(file, tmp, cfg.encKey);
    const key = `${cfg.prefix}db/${path.basename(file)}.enc`;
    await s3(cfg, { method: 'PUT', key, body: tmp });
    return key;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
  }
}

/** Keep the newest cfg.keep database copies off-site; delete the rest. */
async function rotateDb(cfg) {
  const all = (await list(cfg, `${cfg.prefix}db/`)).map((o) => o.key).filter((k) => /\/trove-\d{8}-\d{4}\.db\.enc$/.test(k)).sort();
  const removed = [];
  while (all.length > cfg.keep) {
    const k = all.shift();
    await s3(cfg, { method: 'DELETE', key: k, allow404: true });
    removed.push(k);
  }
  return removed;
}

/**
 * Mirror the uploads + private folders: upload what is new or a different
 * size, delete off-site what is gone from the server. Returns counts.
 */
async function syncFiles(cfg) {
  const remote = new Map((await list(cfg, `${cfg.prefix}files/`)).map((o) => [o.key, o.size]));
  const seen = new Set();
  let uploaded = 0, unchanged = 0, deleted = 0, bytes = 0;
  for (const [name, dir] of Object.entries(roots())) {
    for (const file of walk(dir)) {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      const key = `${cfg.prefix}files/${name}/${rel}.enc`;
      seen.add(key);
      const size = fs.statSync(file).size;
      if (remote.get(key) === size + OVERHEAD) { unchanged++; continue; }
      const body = encryptBuffer(fs.readFileSync(file), cfg.encKey);
      await s3(cfg, { method: 'PUT', key, body });
      uploaded++; bytes += size;
    }
  }
  for (const key of remote.keys()) {
    if (seen.has(key)) continue;
    await s3(cfg, { method: 'DELETE', key, allow404: true });
    deleted++;
  }
  return { uploaded, unchanged, deleted, bytes };
}

/**
 * The off-site half of the nightly backup. `dbFile` = tonight's local copy.
 * Returns a summary, or { skipped } when not configured.
 */
async function run(dbFile, env = process.env) {
  const cfg = config(env);
  if (!cfg) return { skipped: `not configured (missing ${missing(env).join(', ')})` };
  const dbKey = await uploadDb(cfg, dbFile);
  const rotated = await rotateDb(cfg);
  const files = await syncFiles(cfg);
  return { dbKey, rotated, files };
}

/* ---------------- the nightly job: local copy + off-site + alerts ---------------- */

function state() { return require('./db'); }
function getState(key) {
  try {
    const r = state().prepare('SELECT value FROM ops_state WHERE key=?').get(key);
    return r ? JSON.parse(r.value) : null;
  } catch (_) { return null; }
}
function setState(key, value) {
  try {
    state().prepare(`INSERT INTO ops_state (key, value, updated_at) VALUES (?,?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, JSON.stringify(value));
  } catch (e) { console.error('backup: could not record state:', e.message); }
}
const dubaiDay = (d) => new Date(d.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const isMondayInDubai = (d) => new Date(d.getTime() + 4 * 3600 * 1000).getUTCDay() === 1;

/**
 * Run the whole nightly backup: local VACUUM INTO (backup.js) then the
 * off-site copy. A failure emails ADMIN_EMAIL (once a day at most); on
 * Mondays a short 'backups OK' note goes out instead (unless
 * BACKUP_WEEKLY_EMAIL=0), which also says when the off-site copy is not set up.
 */
async function nightly(now = new Date(), env = process.env) {
  const notify = require('./notify');
  const result = { local: null, offsite: null, error: null };
  try {
    result.local = require('./backup').run(now);
    result.offsite = await run(result.local.file, env);
    const ok = { at: now.toISOString(), file: path.basename(result.local.file), offsite: result.offsite.skipped ? null : result.offsite };
    setState('backup_last_ok', ok);
    const nights = (getState('backup_ok_nights') || []).filter((d) => d >= dubaiDay(new Date(now.getTime() - 7 * 86400000)));
    if (!nights.includes(dubaiDay(now))) nights.push(dubaiDay(now));
    setState('backup_ok_nights', nights);
    console.log(`backup: wrote ${result.local.file} (${result.local.kept} kept)` + (result.offsite.skipped
      ? ` · off-site ${result.offsite.skipped}`
      : ` · off-site ${result.offsite.dbKey}, files +${result.offsite.files.uploaded} -${result.offsite.files.deleted}`));
    if (isMondayInDubai(now) && env.BACKUP_WEEKLY_EMAIL !== '0' && getState('backup_weekly_sent') !== dubaiDay(now)) {
      setState('backup_weekly_sent', dubaiDay(now));
      const off = result.offsite;
      await notify.adminAlert({
        subject: off.skipped ? 'Trove backups: on the server only — off-site copy not set up' : 'Trove backups OK',
        title: off.skipped ? 'Backups run, but only on the server' : 'Backups OK',
        kicker: 'Weekly backup check',
        lines: [
          `Nightly backups that worked in the last 7 days: ${nights.length} of 7.`,
          `Latest: ${path.basename(result.local.file)} (copies kept on the server: ${result.local.kept}).`,
          off.skipped
            ? 'The encrypted off-site copy is NOT switched on, so a lost server disk would lose orders and photos. Set the BACKUP_S3_* variables and BACKUP_ENC_KEY on Render (see RESTORE.md).'
            : `Off-site: database copy uploaded, ${off.files.uploaded} new photo/document file(s) sent, ${off.files.deleted} removed, ${off.files.unchanged} already there.`,
        ],
      });
    }
  } catch (e) {
    result.error = e;
    console.error('backup failed:', e);
    setState('backup_last_error', { at: now.toISOString(), message: String(e && e.message || e) });
    if (getState('backup_alerted') !== dubaiDay(now)) {
      setState('backup_alerted', dubaiDay(now));
      const last = getState('backup_last_ok');
      await notify.adminAlert({
        subject: 'Trove backup FAILED last night',
        title: 'The nightly backup failed',
        kicker: 'Backups',
        lines: [
          `What went wrong: ${String(e && e.message || e).slice(0, 300)}`,
          last ? `The last backup that worked: ${last.file} (${last.at.slice(0, 16).replace('T', ' ')} UTC).` : 'No successful backup is on record yet.',
          'Nothing is lost yet, but please look at it today: forward this email to whoever looks after the site, or check RESTORE.md. A full disk is the usual cause.',
        ],
      });
    }
  }
  return result;
}

module.exports = {
  config, missing, run, nightly, list, s3, syncFiles, uploadDb, rotateDb,
  encryptBuffer, decryptBuffer, encryptFile, decryptFile, roots, OVERHEAD,
};
