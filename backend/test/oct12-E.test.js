'use strict';
/**
 * 12 Oct fix round, group E (platform, auth, security, content).
 * One test (or a few) per behaviour change, named after the finding.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com', EMAIL_RETRY_DELAY_MS: '10' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PW = 'testpass123';
let ctx, db, sent, ipN = 0, adminCookie, realSend;

/** A request from its own address, so the per-IP limits never trip this file up. */
async function call(method, pathname, { body, cookie, headers, raw, ip } = {}) {
  const res = await fetch(ctx.baseUrl + pathname, {
    method, redirect: 'manual',
    headers: {
      'x-forwarded-for': ip || `198.18.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers || {}),
    },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
function makeUser(email, extra = {}) {
  const { hashPassword } = require('../src/middleware');
  const cols = { email, password_hash: hashPassword(PW), name: 'Test Person', role: 'buyer', ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
}
async function signIn(identifier, password = PW) {
  const r = await call('POST', '/api/auth/login', { body: { identifier, password } });
  assert.equal(r.status, 200, r.text);
  return r.cookie;
}

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  sent = [];
  realSend = require('../src/email').send;
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
  makeUser('owner@test.local', { role: 'admin', email_verified_at: '2026-10-01 10:00:00' });
  adminCookie = await ctx.loginAs('owner@test.local', PW);
});
after(async () => { await ctx.close(); });

/* ---------------- boot-time checks (F209, F206) ---------------- */

function boot(env, { until = /trove running/, ms = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      cwd: path.join(__dirname, '..'), env: { ...env, PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT || '' },
    });
    let out = '';
    const done = (code) => { clearTimeout(timer); resolve({ code, out }); };
    const timer = setTimeout(() => { child.kill(); done('timeout'); }, ms);
    const onData = (d) => { out += d; if (until && until.test(out)) { child.kill(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => done(code));
  });
}
const tempDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trove-e-boot-')), 'trove.db');

test('F209: production refuses to start without SESSION_SECRET (or with the development default)', async () => {
  const { productionProblems } = require('../src/security');
  assert.equal(productionProblems({ NODE_ENV: 'production' }).length, 1);
  assert.equal(productionProblems({ NODE_ENV: 'production', SESSION_SECRET: 'dev-secret-change-me' }).length, 1);
  assert.equal(productionProblems({ NODE_ENV: 'production', SESSION_SECRET: 'a-real-long-secret' }).length, 0);
  assert.equal(productionProblems({ NODE_ENV: 'test' }).length, 0, 'dev and tests keep working');
  const r = await boot({ NODE_ENV: 'production', DB_PATH: tempDb(), PORT: '0', CRON_DISABLED: '1', STRIPE_MOCK: '1' }, { until: null });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FATAL: SESSION_SECRET is not set/);
  // createApp refuses too (any other way the app is built).
  const prev = { env: process.env.NODE_ENV, secret: process.env.SESSION_SECRET };
  process.env.NODE_ENV = 'production'; delete process.env.SESSION_SECRET;
  try { assert.throws(() => require('../src/app').createApp(), /SESSION_SECRET/); }
  finally { process.env.NODE_ENV = prev.env; process.env.SESSION_SECRET = prev.secret; }
});

test('F206: the boot promotes ADMIN_EMAIL to admin only once that account has confirmed its email', async () => {
  const dbFile = tempDb();
  const Database = require('better-sqlite3');
  // Let the app create the schema on a first boot, then plant an unconfirmed account.
  const env = { NODE_ENV: 'test', DB_PATH: dbFile, PORT: '0', CRON_DISABLED: '1', STRIPE_MOCK: '1', SESSION_SECRET: 's', ADMIN_EMAIL: 'boss@test.local' };
  let r = await boot(env);
  assert.match(r.out, /trove running/, r.out);
  let d = new Database(dbFile);
  d.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local','x','Squatter','buyer')").run();
  d.close();
  r = await boot(env);
  assert.match(r.out, /NOT made admin/);
  d = new Database(dbFile);
  assert.equal(d.prepare("SELECT role FROM users WHERE email='boss@test.local'").get().role, 'buyer');
  d.prepare("UPDATE users SET email_verified_at=datetime('now') WHERE email='boss@test.local'").run();
  d.close();
  r = await boot(env);
  assert.match(r.out, /promoted boss@test\.local to admin/);
  d = new Database(dbFile);
  assert.equal(d.prepare("SELECT role FROM users WHERE email='boss@test.local'").get().role, 'admin');
  d.close();
});

/* ---------------- headers, CORS, pages (F272, F270, F467, F471) ---------------- */

test('F272: another website gets no CORS headers (not a 500); its writes are refused with 403', async () => {
  const get = await call('GET', '/api/config', { headers: { origin: 'https://evil.example' } });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('access-control-allow-origin'), null);
  const img = await call('GET', '/img/og-default.jpg', { headers: { origin: 'https://pinterest.example' } });
  assert.notEqual(img.status, 500);
  const post = await call('POST', '/api/auth/login', { headers: { origin: 'https://evil.example' }, body: { email: 'x@test.local', password: 'y' } });
  assert.equal(post.status, 403);
  // The site's own origin (CLIENT_URL / localhost in tests) still works.
  const own = await call('GET', '/api/config', { headers: { origin: 'http://localhost:4242' } });
  assert.equal(own.status, 200);
});

test('F270: /services with a private token in its address carries no Tag Manager', async () => {
  const plain = await call('GET', '/services', { headers: { accept: 'text/html' } });
  assert.match(plain.text, /gtm:begin/);
  const tok = await call('GET', '/services?t=abc123', { headers: { accept: 'text/html' } });
  assert.equal(tok.status, 200);
  assert.doesNotMatch(tok.text, /googletagmanager|gtm:begin/);
  const legacy = await call('GET', '/trove-services.html?x=1');
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/services?x=1');
});

test('F467: working notes (*.md) are never served', async () => {
  for (const p of ['/PHOTOGRAPHY-MANIFEST.md', '/img/README.md', '/fonts/README.md']) {
    const r = await call('GET', p);
    assert.equal(r.status, 404, p);
  }
});

test('F471/F506: Permissions-Policy and form-action are sent', async () => {
  const r = await call('GET', '/');
  assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.match(r.headers.get('content-security-policy'), /form-action 'self' https:\/\/hooks\.stripe\.com/);
});

/* ---------------- health (F436) ---------------- */

test('F436: /api/health checks the database and a disk write, and reports free space', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.db, true);
  assert.equal(r.data.disk, true);
  assert.ok(r.data.diskFreePercent === null || typeof r.data.diskFreePercent === 'number');
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (f, ...a) => { if (String(f).endsWith('.health-check')) throw new Error('EROFS'); return realWrite(f, ...a); };
  try {
    const bad = await call('GET', '/api/health');
    assert.equal(bad.status, 503);
    assert.equal(bad.data.disk, false);
  } finally { fs.writeFileSync = realWrite; }
});

test('F436: a nearly full disk warns the owner (job alert) without failing the check', () => {
  const health = require('../src/health');
  const realStat = fs.statfsSync;
  fs.statfsSync = () => ({ blocks: 1000, bavail: 50, bsize: 4096 });
  health._reset();
  try {
    const s = health.diskSpace(Date.now());
    assert.equal(s.low, true);
    assert.equal(s.freePercent, 5);
    const row = db.prepare("SELECT failing FROM job_runs WHERE job='disk-space'").get();
    assert.equal(row.failing, 1);
    assert.equal(health.check().ok, true, 'low space alone never fails the health check');
  } finally { fs.statfsSync = realStat; health._reset(); }
});

/* ---------------- rate-limit key (F277) ---------------- */

test('F277: rotating a forged first X-Forwarded-For entry does not reset the sign-in limit', async () => {
  let last;
  for (let i = 0; i < 31; i++) {
    // The proxy (simulated) appends the real client 203.0.113.77; the visitor rotates the first entry.
    last = await call('POST', '/api/auth/login', { ip: `10.${i}.0.1, 203.0.113.77`, body: { email: `forger${i}@test.local`, password: 'nope' } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, 'the bucket is the real client, whatever the visitor writes first');
  // A visitor-sent CF-Connecting-IP is ignored off Render.
  const cf = await call('POST', '/api/auth/login', { ip: '203.0.113.77', headers: { 'cf-connecting-ip': '198.51.100.1' }, body: { email: 'forger-x@test.local', password: 'nope' } });
  assert.equal(cf.status, 429);
});

/* ---------------- backups and migrations (F278, F274, F275) ---------------- */

test('F278: a backup copy carries no sign-in sessions; the live database keeps them', () => {
  const live = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  assert.ok(live > 0, 'there are live sessions to leave out');
  const { file } = require('../src/backup').run(new Date('2026-10-12T01:02:00Z'));
  const Database = require('better-sqlite3');
  const copy = new Database(file, { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0, 'everything else is copied');
  copy.close();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, live, 'the live table is untouched');
  assert.ok(!fs.readFileSync(file).includes(Buffer.from('"userId"')), 'no session JSON left in free pages');
});

test('F274: pending migrations get a safety copy first and are all-or-nothing', () => {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-e-mig-'));
  const scratch = new Database(path.join(dir, 'scratch.db'));
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  fs.writeFileSync(path.join(migDir, '001-base.js'), "module.exports={id:'001-base',up(db){db.exec('CREATE TABLE base (x INTEGER)')}};");
  const runner = require('../src/migrations/index');
  runner.run(scratch, { dir: migDir }); // a brand-new database: no copy needed
  fs.writeFileSync(path.join(migDir, '002-good.js'), "module.exports={id:'002-good',up(db){db.exec('CREATE TABLE good (x INTEGER)')}};");
  fs.writeFileSync(path.join(migDir, '003-bad.js'), "module.exports={id:'003-bad',up(db){db.exec('INSERT INTO nowhere VALUES (1)')}};");
  const backups = require('../src/backup').backupsDir();
  const before = fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => f.startsWith('pre-migration-')).length : 0;
  assert.throws(() => runner.run(scratch, { dir: migDir }), /migration 003-bad\.js failed, so none of this boot's 2 migration\(s\) were applied/);
  assert.equal(scratch.prepare("SELECT 1 FROM sqlite_master WHERE name='good'").get(), undefined, '002 rolled back with 003');
  assert.deepEqual(scratch.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), ['001-base']);
  const after = fs.readdirSync(backups).filter((f) => f.startsWith('pre-migration-')).length;
  assert.equal(after, before + 1, 'a pre-migration copy was written');
  scratch.close();
});

test('F274: file work a migration defers with ctx.afterCommit runs only once the whole boot has committed', () => {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-e-mig2-'));
  const scratch = new Database(path.join(dir, 'scratch.db'));
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  const marker = path.join(dir, 'plain.txt').replace(/\\/g, '/');
  fs.writeFileSync(marker, 'plain');
  fs.writeFileSync(path.join(migDir, '001-files.js'), `module.exports={id:'001-files',up(db,ctx){db.exec('CREATE TABLE f (x INTEGER)');ctx.afterCommit(()=>require('fs').unlinkSync('${marker}'))}};`);
  fs.writeFileSync(path.join(migDir, '002-bad.js'), "module.exports={id:'002-bad',up(db){db.exec('INSERT INTO nowhere VALUES (1)')}};");
  const runner = require('../src/migrations/index');
  assert.throws(() => runner.run(scratch, { dir: migDir, backup: false }), /002-bad\.js failed/);
  assert.ok(fs.existsSync(marker), 'a rolled-back boot never runs the deferred file work');
  fs.unlinkSync(path.join(migDir, '002-bad.js'));
  runner.run(scratch, { dir: migDir, backup: false });
  assert.ok(!fs.existsSync(marker), 'it runs after the commit');
  scratch.close();
});

test('F275: the lookup indexes exist', () => {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
  for (const n of ['idx_shipments_delivery_ref', 'idx_orders_buyer', 'idx_orders_status_created', 'idx_orders_payment_intent', 'idx_items_product', 'idx_balances_settlement', 'idx_sessions_expire']) {
    assert.ok(names.has(n), n);
  }
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM shipments WHERE delivery_ref = ?').all('x').map((r) => r.detail).join(' ');
  assert.match(plan, /USING INDEX idx_shipments_delivery_ref/);
});

test('F472: emailed links that expired over a month ago are purged', () => {
  const accounts = require('../src/accounts');
  const uid = makeUser('purge@test.local');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  accounts.issueToken(user, 'reset', Date.now() - 40 * 24 * 3600 * 1000);
  accounts.issueToken(user, 'verify');
  assert.equal(accounts.purgeOldTokens(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id=?').get(uid).n, 1);
});

/* ---------------- passwords and sign-in (F202, F276, F201, F208, F207) ---------------- */

test('F202: a password sent as a number is a wrong password, never a server error', async () => {
  makeUser('numeric@test.local');
  const login = await call('POST', '/api/auth/login', { body: { email: 'numeric@test.local', password: 12345678 } });
  assert.equal(login.status, 401);
  const reg = await call('POST', '/api/auth/register', { body: { email: 'numeric2@test.local', name: 'N', password: 12345678 } });
  assert.equal(reg.status, 400);
  const apply = await call('POST', '/api/auth/register', { body: { email: 'numeric@test.local', name: 'N', password: 12345678, role: 'seller', shopName: 'S', instagram: '@s', phone: '0501234567', location: 'Dubai' } });
  assert.equal(apply.status, 409, 'an existing account with a wrong (numeric) password, not a 500');
});

test('F276/F201: password checks are async bcrypt with the same hashes; unknown accounts still pay for a check', async () => {
  const mw = require('../src/middleware');
  const hash = mw.hashPassword('old-hash-still-ok');
  assert.equal(await mw.verifyPasswordAsync('old-hash-still-ok', hash), true, 'hashes from before still verify');
  const asyncHash = await mw.hashPasswordAsync('new-one-123');
  assert.equal(mw.verifyPassword('new-one-123', asyncHash), true);
  assert.equal(await mw.checkPasswordAsync('anything', null), false);
  assert.equal(await mw.verifyPasswordAsync({ evil: 1 }, hash), false);
  const t0 = Date.now();
  await mw.checkPasswordAsync('anything', undefined);
  assert.ok(Date.now() - t0 >= 5, 'a dummy bcrypt check runs for an unknown account');
});

test('F208: ten wrong passwords pause sign-in for that account (even with the right one), email the owner once; a reset lifts it', async () => {
  require('../src/accounts')._resetLoginFailures();
  const uid = makeUser('target@test.local', { email_verified_at: '2026-10-01 10:00:00' });
  sent.length = 0;
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/api/auth/login', { body: { email: 'target@test.local', password: `guess-${i}` } });
    assert.equal(r.status, 401);
  }
  const paused = await call('POST', '/api/auth/login', { body: { email: 'target@test.local', password: PW } });
  assert.equal(paused.status, 429);
  assert.equal(paused.data.code, 'account_paused');
  assert.ok(Number(paused.headers.get('retry-after')) > 0);
  await tick();
  const mails = sent.filter((m) => m.to === 'target@test.local');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Several wrong passwords/);
  // Unknown addresses pause the same way (the answer reveals nothing).
  for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', { body: { email: 'ghost@test.local', password: 'x' } });
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ghost@test.local', password: 'x' } })).data.code, 'account_paused');
  // A reset link still works and lifts the pause.
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const token = require('../src/accounts').issueToken(user, 'reset');
  const reset = await call('POST', '/api/auth/reset', { body: { token, password: 'a-brand-new-pass' } });
  assert.equal(reset.status, 200, reset.text);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'target@test.local', password: 'a-brand-new-pass' } })).status, 200);
});

test('F208: the most common passwords are refused when a password is chosen', () => {
  const v = require('../src/validate');
  for (const pw of ['password1', '12345678', 'qwerty123', 'aaaaaaaa', 'abcdefgh', 'Password123']) assert.equal(v.passwordError(pw), v.COMMON_PASSWORD_ERROR, pw);
  for (const pw of ['k7pq2mxz', 'testpass123', 'my kiln is warm']) assert.equal(v.passwordError(pw), null, pw);
});

test('F207: one reset email per account every two minutes (the first link stays valid), five a day', async () => {
  const uid = makeUser('flood@test.local');
  sent.length = 0;
  for (let i = 0; i < 3; i++) await call('POST', '/api/auth/forgot', { body: { email: 'flood@test.local' } });
  await tick();
  assert.equal(sent.filter((m) => m.to === 'flood@test.local').length, 1, 'one email, however often the form is sent');
  const live = db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id=? AND kind='reset' AND used_at IS NULL").get(uid).n;
  assert.equal(live, 1, 'the first link was not cancelled');
  // Past the cooldown another may go — up to five a day.
  for (let i = 0; i < 6; i++) {
    db.prepare("UPDATE auth_tokens SET created_at=datetime(created_at, '-3 minutes') WHERE user_id=?").run(uid);
    await call('POST', '/api/auth/forgot', { body: { email: 'flood@test.local' } });
  }
  await tick();
  assert.equal(sent.filter((m) => m.to === 'flood@test.local').length, 5, 'the daily cap');
});

/* ---------------- mobile numbers (F203) ---------------- */

test('F203: an unconfirmed account cannot hold a number against a confirmed one, and cannot sign in with it', async () => {
  makeUser('squatter@test.local', { phone: '+971551112222' });
  const ownerId = makeUser('realowner@test.local', { email_verified_at: '2026-10-01 10:00:00' });
  const squat = await call('POST', '/api/auth/login', { body: { identifier: '055 111 2222', password: PW } });
  assert.equal(squat.status, 403, 'an unconfirmed account does not sign in by mobile');
  const cookie = await signIn('realowner@test.local');
  const claim = await call('PATCH', '/api/account/me', { cookie, body: { phone: '0551112222' } });
  assert.equal(claim.status, 200, claim.text);
  assert.equal(db.prepare("SELECT phone FROM users WHERE email='squatter@test.local'").get().phone, null, 'the unconfirmed holder lost it');
  assert.equal(db.prepare('SELECT phone FROM users WHERE id=?').get(ownerId).phone, '+971551112222');
  // A confirmed holder keeps it.
  makeUser('another@test.local', { email_verified_at: '2026-10-01 10:00:00' });
  const other = await signIn('another@test.local');
  assert.equal((await call('PATCH', '/api/account/me', { cookie: other, body: { phone: '0551112222' } })).status, 409);
  // A new sign-up never takes anyone's number.
  const reg = await call('POST', '/api/auth/register', { body: { email: 'newbie@test.local', name: 'New', password: 'k7pq2mxz', mobile: '0551112222' } });
  assert.equal(reg.status, 409);
});

/* ---------------- sessions (F439) ---------------- */

test('F439: sign out of all other devices keeps this one', async () => {
  makeUser('devices@test.local');
  const a = await signIn('devices@test.local');
  const b = await signIn('devices@test.local');
  const r = await call('POST', '/api/auth/sessions/end-others', { cookie: a });
  assert.equal(r.status, 200);
  assert.ok(r.data.ended >= 1);
  assert.equal((await call('GET', '/api/auth/me', { cookie: a })).status, 200, 'this device stays signed in');
  assert.equal((await call('GET', '/api/auth/me', { cookie: b })).status, 401, 'the other one is out');
  assert.equal((await call('POST', '/api/auth/sessions/end-others')).status, 401);
});

/* ---------------- slugs (F375) ---------------- */

test('F375: a new shop gets the same slug its address would use', async () => {
  const r = await call('POST', '/api/auth/register', { body: {
    role: 'seller', email: 'cafe@test.local', name: 'Zoé', password: 'k7pq2mxz', shopName: 'Café & Co',
    instagram: '@cafeco', phone: '0501234567', location: 'Al Quoz, Dubai',
  } });
  assert.equal(r.status, 201, r.text);
  assert.equal(db.prepare("SELECT slug FROM shops WHERE name='Café & Co'").get().slug, 'cafe-and-co');
  assert.equal(require('../src/seo').slugify("Mara's Kiln"), require('../src/slug').slugify("Mara's Kiln"));
});

/* ---------------- email (F281, F282, F525, F200) ---------------- */

test('F281: Resend gets a timeout, one idempotent retry on a 5xx, none on a 4xx; logs mask the address', async () => {
  const email = require('../src/email');
  assert.equal(email.maskEmail('layla@gmail.com'), 'l***@gmail.com');
  const fresh = { send: realSend }; // the module's own send (the export is stubbed for the rest of the file)
  const realFetch = global.fetch;
  const calls = [];
  process.env.RESEND_API_KEY = 're_test';
  try {
    let n = 0;
    global.fetch = async (url, opts) => {
      calls.push({ url, key: opts.headers['idempotency-key'], signal: !!opts.signal, body: JSON.parse(opts.body) });
      n += 1;
      return n === 1 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    };
    const out = await fresh.send({ to: 'layla@gmail.com', subject: 'Hi', html: '<p>Hi</p>', replyTo: 'buyer@test.local' });
    assert.equal(out.id, 'em_1');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].key, calls[1].key, 'the retry carries the same idempotency key');
    assert.ok(calls[0].signal, 'a timeout signal is attached');
    assert.equal(calls[0].body.reply_to, 'buyer@test.local');
    calls.length = 0;
    global.fetch = async (url, opts) => { calls.push(opts); return new Response('bad address', { status: 422 }); };
    await assert.rejects(fresh.send({ to: 'x@test.local', subject: 'Hi', html: '<p>Hi</p>' }), /Resend 422/);
    assert.equal(calls.length, 1, 'no retry on a 4xx');
  } finally {
    global.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
});

test('F282: a contact-form message to the owner replies to the customer', async () => {
  sent.length = 0;
  const r = await call('POST', '/api/contact', { body: { name: 'Huda', email: 'huda@test.local', topic: 'order', message: 'My parcel arrived damaged, please help.' } });
  assert.equal(r.status, 201);
  await tick();
  const mail = sent.find((m) => /Contact form/.test(m.subject));
  assert.ok(mail);
  assert.equal(mail.replyTo, 'huda@test.local');
});

test('F282/F525/F200: every email footer has a Contact us link and the company, in readable colours; the welcome says to ignore it if not you', () => {
  const email = require('../src/email');
  const { html } = email.welcomeVerify({ name: 'Dana', link: 'https://troveathome.com/api/auth/verify-email?token=x', lang: 'en' });
  assert.match(html, /href="https:\/\/troveathome\.com\/contact"[^>]*>Contact us</);
  assert.match(html, /Trove is a brand of Serein Consultancy LLC/);
  assert.match(html, /Didn&#39;t create a Trove account\?|Didn't create a Trove account\?/);
  assert.doesNotMatch(html, /#8b8380|#7b716d/i, 'no low-contrast greys');
  assert.match(html, /font-size:13px;line-height:1\.7;color:#646161/, 'footer at 13px in the brand muted');
  const ar = email.welcomeVerify({ name: 'Dana', link: 'https://troveathome.com/x', lang: 'ar' }).html;
  assert.match(ar, /\/ar\/contact"[^>]*>تواصل معنا</);
});

/* ---------------- moderation emails (F419) ---------------- */

test('F419: suspending a shop sends "paused" with the note; approving it again sends "back", not the welcome', async () => {
  const maker = makeUser('paused-maker@test.local', { role: 'seller' });
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,pickup_address,pickup_phone,agreement_accepted_at,agreement_version) VALUES (?,?,?,'approved','Al Quoz','+971500000009',datetime('now'),'v5')")
    .run(maker, 'Pause Studio', 'pause-studio').lastInsertRowid;
  sent.length = 0;
  let r = await call('PATCH', `/api/admin/shops/${shopId}`, { cookie: adminCookie, body: { status: 'suspended', note: 'Photos show items that are not handmade.' } });
  assert.equal(r.status, 200, r.text);
  await tick();
  let mail = sent.find((m) => m.to === 'paused-maker@test.local');
  assert.match(mail.subject, /Pause Studio is paused on Trove/);
  assert.match(mail.html, /not handmade/);
  sent.length = 0;
  r = await call('PATCH', `/api/admin/shops/${shopId}`, { cookie: adminCookie, body: { status: 'approved' } });
  assert.equal(r.status, 200, r.text);
  await tick();
  mail = sent.find((m) => m.to === 'paused-maker@test.local');
  assert.match(mail.subject, /Pause Studio is back on Trove/);
  assert.doesNotMatch(mail.subject, /Welcome to Trove/);
});

/* ---------------- SEO and content (F268, F265, F501, F516, F487, F317) ---------------- */

test('F268: variants with their own prices give an AggregateOffer over the in-stock combinations', async () => {
  const maker = makeUser('throws@test.local', { role: 'seller' });
  const shop = db.prepare("INSERT INTO shops (user_id,name,slug,status,agreement_accepted_at,agreement_version) VALUES (?,?,?,'approved',datetime('now'),'v5')").run(maker, 'Loom Room', 'loom-room').lastInsertRowid;
  const variants = JSON.stringify([
    { key: 'Size:Small', options: [{ name: 'Size', value: 'Small' }], stock: 0, priceCents: null },
    { key: 'Size:Large', options: [{ name: 'Size', value: 'Large' }], stock: 2, priceCents: 45000 },
    { key: 'Size:XL', options: [{ name: 'Size', value: 'XL' }], stock: 1, priceCents: 52000 },
  ]);
  const pid = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status,options,variants) VALUES (?,?,?,?,?,'live',?,?)")
    .run(shop, 'Wool Throw', 'Home & Living', 36000, 3, JSON.stringify([{ name: 'Size', values: ['Small', 'Large', 'XL'] }]), variants).lastInsertRowid;
  const page = await call('GET', `/pieces/${pid}-wool-throw`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  const prod = [...page.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .flatMap((m) => { const o = JSON.parse(m[1]); return o['@graph'] || [o]; })
    .find((n) => [].concat(n['@type']).includes('Product'));
  assert.equal(prod.offers['@type'], 'AggregateOffer');
  assert.equal(prod.offers.lowPrice, '450.00', 'the sold-out base-price size is not quoted');
  assert.equal(prod.offers.highPrice, '520.00');
  assert.equal(prod.offers.availability, 'https://schema.org/InStock');
});

test('F265/F501/F487/F516: help pages say what the site does', async () => {
  const faq = await call('GET', '/faq', { headers: { accept: 'text/html' } });
  assert.match(faq.text, /Forgot your password\?/);
  assert.match(faq.text, /href="\/login\?forgot=1"/);
  assert.doesNotMatch(faq.text, /reversed on a following payout/);
  assert.match(faq.text, /drops out of your pending total/);
  assert.match(faq.text, /Candles are welcome/);
  const returns = await call('GET', '/returns', { headers: { accept: 'text/html' } });
  assert.match(returns.text, /find the order/);
  assert.doesNotMatch(returns.text, /and open the order/);
  const ar = await call('GET', '/ar/faq', { headers: { accept: 'text/html' } });
  assert.match(ar.text, /login\?forgot=1/);
});

test('F317: the sell FAQ no longer says a maker can never owe anything; a saved override is rewritten', async () => {
  const content = await call('GET', '/api/content');
  const cost = content.data.sell.faq.items.find((i) => /cost/.test(i.q));
  assert.doesNotMatch(cost.a, /whole arrangement|you owe nothing/);
  assert.match(cost.a, /responsible for your pieces being your own work, safe and as described/);
  const mig = require('../src/migrations/026-E-sell-faq-copy');
  const old = JSON.stringify({ items: [{ q: 'What does it cost?', a: "Nothing to join. When one sells, Trove buys it from you at 60% of that price — photography, marketing, delivery and customer care all included — and that's the whole arrangement. If nothing sells, you owe nothing." }] });
  db.prepare("INSERT INTO site_content (section, value) VALUES ('sell.faq', ?) ON CONFLICT(section) DO UPDATE SET value=excluded.value").run(old);
  mig.up(db);
  const now = db.prepare("SELECT value FROM site_content WHERE section='sell.faq'").get().value;
  assert.doesNotMatch(now, /whole arrangement/);
  assert.match(now, /If nothing sells, you pay nothing/);
  db.prepare("DELETE FROM site_content WHERE section='sell.faq'").run();
});

/* ---------------- legal (F343, F345) ---------------- */

test('F343: Provider Agreement v4 says the mobile is released once the booking is secured (v3 untouched)', async () => {
  const r = await call('GET', '/api/legal/provider-agreement');
  assert.equal(r.data.version, 'v4');
  assert.match(r.data.markdown.replace(/\s+/g, ' '), /released to you once the booking is secured/);
  assert.match(r.data.markdown.replace(/\s+/g, ' '), /when the customer's card payment is received/);
  const legal = path.join(__dirname, '..', 'legal');
  assert.ok(fs.existsSync(path.join(legal, 'provider-agreement-v4-ar.md')), 'the Arabic twin exists');
  assert.match(fs.readFileSync(path.join(legal, 'provider-agreement-v3.md'), 'utf8'), /Confirming releases the customer's \*\*mobile number\*\*/, 'the accepted v3 stays as signed');
  const ar = await call('GET', '/api/legal/provider-agreement?lang=ar');
  assert.ok(ar.data.arabic, 'the Arabic convenience translation is served');
});

test('F345: every new order records the Terms of Sale version it was placed under', () => {
  const v = require('../src/config').BUYER_TERMS_VERSION;
  const id = db.prepare("INSERT INTO orders (public_id,email,subtotal_cents,total_cents) VALUES ('TRV-TERMS1','t@test.local',1000,1000)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT terms_version FROM orders WHERE id=?').get(id).terms_version, v);
  const kept = db.prepare("INSERT INTO orders (public_id,email,subtotal_cents,total_cents,terms_version) VALUES ('TRV-TERMS2','t@test.local',1000,1000,'v9')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT terms_version FROM orders WHERE id=?').get(kept).terms_version, 'v9', 'an explicit version is kept');
});

/* ---------------- fee figures in the copy (F319, F378, F502) ---------------- */

test('F319/F378/F502: change the fee settings and every page, the Arabic, Site content and server strings follow', async () => {
  const fees = require('../src/fees');
  const saved = { ...fees };
  const figures = require('../src/figures');
  assert.equal(figures.changed(), false, 'the shipped copy matches fees.js defaults');
  Object.assign(fees, { COMMISSION_PERCENT: 35, RETURN_WINDOW_DAYS: 20, DELIVERY_FEE_CENTS: 3500, FREE_DELIVERY_THRESHOLD_CENTS: 25000, COURIER_TRANSIT_MAX_DAYS: 5 });
  try {
    const html = (p) => call('GET', p, { headers: { accept: 'text/html' } }).then((r) => r.text);
    const sell = await html('/sell-on-trove');
    // (the sell page since 2026-10-12: the arrangement card and the pieces panel carry the share)
    assert.match(sell, /you keep 65% of the price you set/);
    assert.match(sell, /<span class="n">65%<\/span>/);
    assert.match(sell, /at 65% of that price/);
    assert.match(sell, /20-day return window/);
    assert.match(sell, /Delivery AED 35, free on orders over AED 250/);
    assert.match(sell, /<b>1–5 days<\/b>/);
    assert.doesNotMatch(sell, /You keep 60%|you keep 60%|\b15-day\b|Delivery AED 30\b|1–4 days/);
    assert.match(sell, /AED 200\+/, 'the price-filter label is not a fee');
    const apply = await html('/apply');
    assert.match(apply, /Keep 65% · we photograph, market and deliver/);
    assert.doesNotMatch(apply, /Keep 60%/);
    const login = await html('/login');
    assert.match(login, /You keep 65% of every sale/);
    const home = await html('/');
    assert.match(home, /20-day returns/);
    assert.match(home, /most 3–7 days/);
    // Arabic: the same figures, still translated.
    const arSell = await html('/ar/sell-on-trove');
    assert.match(arSell, /تحتفظ بـ 65% من السعر الذي تحدّده/);
    assert.doesNotMatch(arSell, /تحتفظ بـ 60%/);
    // Site content API, both languages.
    const api = await call('GET', '/api/content');
    assert.equal(api.data.sell.hero.facts[4], 'Paid every other Tuesday, after the 20-day return window');
    assert.match(api.data.sell.money.covers, /^Trove's 35% covers/);
    const apiAr = await call('GET', '/api/content', { headers: { 'x-trove-lang': 'ar' } });
    assert.match(apiAr.data.sell.hero.facts[4], /20/);
    assert.match(apiAr.data.sell.money.covers, /35%/);
    // Server strings (emails, help text) through i18n.t.
    const i18n = require('../src/i18n');
    assert.match(i18n.t('en', ' (a {fee} collection fee applies when you change your mind on an order of AED 200 and below, and is already deducted from that figure)', { fee: 'AED 35' }), /AED 250 and below/);
    // The signed legal documents never change by setting.
    const terms = await call('GET', '/api/legal/seller-agreement');
    assert.doesNotMatch(terms.data.markdown, /65%/);
  } finally {
    Object.assign(fees, saved);
  }
  assert.equal(figures.changed(), false);
  assert.match(await call('GET', '/sell-on-trove', { headers: { accept: 'text/html' } }).then((r) => r.text), /you keep 60% of the price you set/, 'back to the shipped copy');
});
