'use strict';
// Go-live traffic hygiene: compression, cache headers, rate limits, search
// engine files and the nightly backup.
const { testEnv, startApp } = require('./helpers');
testEnv({ CLIENT_URL: 'https://troveathome.com', BACKUP_KEEP: '2' });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let app;
test.before(async () => { app = await startApp(); require('../src/seed'); });
test.after(async () => { await app.close(); });

async function head(pathname, headers = {}) {
  const res = await fetch(app.baseUrl + pathname, { headers, redirect: 'manual' });
  await res.arrayBuffer();
  return res;
}

test('storefront HTML is compressed and always revalidated; assets cache for a week', async () => {
  const html = await head('/', { 'accept-encoding': 'gzip, br' });
  assert.equal(html.status, 200);
  assert.ok(['gzip', 'br'].includes(html.headers.get('content-encoding')), 'HTML should be compressed');
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  assert.equal(html.headers.get('x-powered-by'), null);

  const icon = await head('/favicon.svg');
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('cache-control'), /public, max-age=604800/);
});

test('public catalogue JSON carries a short public cache; searches and signed-in paths do not', async () => {
  const list = await app.api('GET', '/api/products');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=150');
  const shops = await app.api('GET', '/api/shops');
  assert.equal(shops.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=150');
  const content = await app.api('GET', '/api/content');
  assert.equal(content.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=1500');

  const search = await app.api('GET', '/api/products?q=mug');
  assert.equal(search.status, 200);
  assert.notEqual(search.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=150');

  const mine = await app.api('GET', '/api/services/my-bookings');
  assert.equal(mine.status, 401);
  assert.ok(!/public/.test(mine.headers.get('cache-control') || ''), 'signed-in path must never be public-cached');
});

test('sign-in attempts are rate limited per IP with a 429 and Retry-After', async () => {
  let last;
  for (let i = 0; i < 31; i++) {
    last = await app.api('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'wrong' } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.match(last.data.error, /Too many sign-in attempts/);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
  // GETs on the auth router are not counted.
  const me = await app.api('GET', '/api/auth/me');
  assert.notEqual(me.status, 429);
  // Another client (a different forwarded address) has its own bucket.
  const other = await fetch(app.baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
  });
  await other.arrayBuffer();
  assert.notEqual(other.status, 429);
  assert.equal(other.headers.get('ratelimit-remaining'), '29');
});

test('rate-limit key is the first forwarded address, or CF-Connecting-IP when present', () => {
  const { clientKey } = require('../src/traffic');
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '198.51.100.7, 172.16.0.2' }, ip: '172.16.0.2' }), '198.51.100.7');
  assert.equal(clientKey({ headers: { 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': '10.1.1.1' }, ip: '10.1.1.1' }), '198.51.100.8');
  assert.equal(clientKey({ headers: {}, ip: '127.0.0.1' }), '127.0.0.1');
});

test('robots.txt allows the storefront, blocks private surfaces, points at the sitemap', async () => {
  const res = await app.api('GET', '/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(res.text, /^User-agent: \*\nAllow: \/\n/);
  for (const p of ['/api/', '/admin', '/account', '/sell', '/provider', '/login']) assert.match(res.text, new RegExp(`Disallow: ${p.replace('/', '\\/')}`));
  assert.match(res.text, /Sitemap: https:\/\/troveathome\.com\/sitemap\.xml/);
  assert.doesNotMatch(res.text, /noindex/i);
});

test('sitemap.xml lists the public pages, approved shops, live pieces and approved providers', async () => {
  const res = await app.api('GET', '/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /xml/);
  assert.match(res.text, /<loc>https:\/\/troveathome\.com\/<\/loc>/);
  assert.match(res.text, /<loc>https:\/\/troveathome\.com\/services<\/loc>/);
  const db = app.db;
  const shop = db.prepare("SELECT slug FROM shops WHERE status='approved' LIMIT 1").get();
  assert.ok(shop, 'seed has an approved shop');
  assert.match(res.text, new RegExp(`<loc>https://troveathome\\.com/\\?shop=${shop.slug}</loc>`));
  const live = db.prepare(`SELECT p.id FROM products p JOIN shops s ON s.id = p.shop_id
    WHERE p.status='live' AND s.status='approved' ORDER BY p.id LIMIT 1`).get();
  assert.match(res.text, new RegExp(`<loc>https://troveathome\\.com/\\?p=${live.id}</loc>`));
  const hidden = db.prepare("SELECT id FROM products WHERE status!='live' LIMIT 1").get();
  if (hidden) assert.doesNotMatch(res.text, new RegExp(`\\?p=${hidden.id}</loc>`));
  assert.doesNotMatch(res.text, /\/admin|\/account|\/sell</);
});

test('public pages carry no noindex; admin and 404 keep theirs', async () => {
  for (const p of ['/', '/services', '/apply', '/login']) {
    const res = await app.api('GET', p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('x-robots-tag'), null, p);
    assert.doesNotMatch(res.text, /<meta name="robots" content="noindex">/, p);
  }
  const admin = await app.api('GET', '/admin');
  assert.match(admin.text, /<meta name="robots" content="noindex">/);
  const missing = await app.api('GET', '/definitely-not-a-page');
  assert.equal(missing.status, 404);
});

test('backup writes a consistent copy and prunes to BACKUP_KEEP', () => {
  const backup = require('../src/backup');
  const a = backup.run(new Date('2026-09-15T00:01:00Z'));
  assert.ok(fs.existsSync(a.file));
  const Database = require('better-sqlite3');
  const copy = new Database(a.file, { readonly: true });
  const users = copy.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  copy.close();
  assert.equal(users, app.db.prepare('SELECT COUNT(*) AS c FROM users').get().c);

  backup.run(new Date('2026-09-16T00:01:00Z'));
  const c = backup.run(new Date('2026-09-17T00:01:00Z'));
  assert.equal(c.kept, 2);
  assert.deepEqual(c.removed, [path.basename(a.file)]);
  assert.ok(!fs.existsSync(a.file));
  assert.equal(backup.backupsDir(), path.join(path.dirname(process.env.DB_PATH), 'backups'));
});
