'use strict';
/**
 * Photos and videos on a service (owner, 28 Oct 2026; src/service-media.js):
 * photos on the disk like product photos, videos straight from the browser to
 * an R2 bucket (here a fake S3 server) through a signed PUT address, at most
 * 8 items and 2 videos, the first item the card's cover.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const NOT_AN_IMAGE = 'data:image/png;base64,' + Buffer.from('definitely not a png').toString('base64');

// A fake bucket: PUT stores the body + Content-Type, HEAD/DELETE as S3 does.
const objects = new Map();
const hits = [];
const s3 = http.createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/trove-media\//, ''));
  hits.push(`${req.method} ${key}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] }); return res.end(); }
    const o = objects.get(key);
    if (req.method === 'HEAD') {
      if (!o) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-type', o.type); res.setHeader('content-length', o.body.length); return res.end();
    }
    if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
    res.statusCode = 400; res.end();
  });
});

let ctx, db, cookie, otherCookie, providerId;
const MEDIA_ENV = (port) => ({
  MEDIA_S3_ENDPOINT: `http://127.0.0.1:${port}`, MEDIA_S3_BUCKET: 'trove-media',
  MEDIA_S3_KEY_ID: 'test-key', MEDIA_S3_SECRET: 'test-secret', MEDIA_PUBLIC_URL: 'https://media.example.test',
});
const videosOn = () => Object.assign(process.env, MEDIA_ENV(s3.address().port));
const videosOff = () => { for (const k of Object.keys(MEDIA_ENV(0))) delete process.env[k]; };

before(async () => {
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  const mk = (email, slug) => {
    const uid = db.prepare("INSERT INTO users (email,password_hash,name,role,email_verified_at) VALUES (?,?,?, 'buyer', datetime('now'))").run(email, pw, 'Provider').lastInsertRowid;
    return db.prepare("INSERT INTO service_providers (user_id,name,slug,status,categories) VALUES (?,?,?, 'approved', '[\"home-styling\"]')").run(uid, slug, slug).lastInsertRowid;
  };
  providerId = mk('pro@test.local', 'pro-studio');
  mk('other@test.local', 'other-studio');
  cookie = await ctx.loginAs('pro@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
});
after(async () => { videosOff(); await ctx.close(); s3.close(); });

const onDisk = (url) => path.join(process.env.UPLOADS_DIR, url.replace('/uploads/', ''));
const category = () => require('../src/service-taxonomy').SERVICE_CATEGORIES[0].slug;
const newService = (extra = {}, c = cookie) => ctx.api('POST', '/api/provider/services', { cookie: c,
  body: { title: 'Room styling', category: category(), priceCents: 50000, priceType: 'fixed', setting: 'home', ...extra } });

test('photos: saved with the service, public with a thumb, reordered and dropped on edit', async () => {
  const res = await newService({ media: [{ type: 'image', src: PNG }, { type: 'image', src: PNG }] });
  assert.equal(res.status, 201, res.text);
  const sv = res.data.service;
  assert.equal(sv.media.length, 2);
  for (const m of sv.media) { assert.equal(m.type, 'image'); assert.match(m.url, /^\/uploads\/services\//); assert.ok(fs.existsSync(onDisk(m.url))); }

  const pub = await ctx.api('GET', '/api/services/providers/pro-studio');
  const listed = pub.data.services.find((x) => x.id === sv.id);
  assert.deepEqual(listed.media.map((m) => m.url), sv.media.map((m) => m.url));
  assert.ok(listed.media.every((m) => m.thumb), 'every item has a thumb for the card');

  // Swap the order and drop the second photo: its file goes.
  const [a, b] = sv.media;
  const edit = await ctx.api('PATCH', `/api/provider/services/${sv.id}`, { cookie, body: { media: [{ type: 'image', src: b.url }] } });
  assert.equal(edit.status, 200, edit.text);
  assert.deepEqual(edit.data.service.media.map((m) => m.url), [b.url]);
  assert.ok(!fs.existsSync(onDisk(a.url)), 'the dropped photo is deleted');

  // Leaving media out of a save keeps it as it is.
  const keep = await ctx.api('PATCH', `/api/provider/services/${sv.id}`, { cookie, body: { title: 'Room styling, two hours' } });
  assert.deepEqual(keep.data.service.media.map((m) => m.url), [b.url]);
});

test('photos: limits, someone else’s file and a broken photo refuse the whole save', async () => {
  const nine = Array.from({ length: 9 }, () => ({ type: 'image', src: PNG }));
  assert.equal((await newService({ media: nine })).status, 400);

  const mine = (await newService({ media: [{ type: 'image', src: PNG }] })).data.service;
  const theirs = (await newService({}, otherCookie)).data.service;
  const steal = await ctx.api('PATCH', `/api/provider/services/${theirs.id}`, { cookie: otherCookie, body: { media: [{ type: 'image', src: mine.media[0].url }] } });
  assert.equal(steal.status, 400, 'a photo from another service is refused');

  const bad = await ctx.api('PATCH', `/api/provider/services/${mine.id}`, { cookie, body: { title: 'Changed', media: [{ type: 'image', src: NOT_AN_IMAGE }] } });
  assert.equal(bad.status, 400);
  const row = db.prepare('SELECT title, media FROM services WHERE id=?').get(mine.id);
  assert.equal(row.title, 'Room styling', 'nothing changed');
  assert.equal(JSON.parse(row.media).length, 1);
});

test('videos are offered only once video storage is configured', async () => {
  videosOff();
  const me = await ctx.api('GET', '/api/provider/me', { cookie });
  assert.equal(me.data.provider.media.video, false);
  assert.equal(me.data.provider.media.maxItems, 8);
  const r = await ctx.api('POST', '/api/provider/media/video', { cookie, body: { contentType: 'video/mp4', size: 1000 } });
  assert.equal(r.status, 503);
});

test('videos: signed upload, checked on save, public without the key, removed when dropped', async () => {
  videosOn();
  assert.equal((await ctx.api('GET', '/api/provider/me', { cookie })).data.provider.media.video, true);
  // Type and size are checked before an address is handed out.
  assert.equal((await ctx.api('POST', '/api/provider/media/video', { cookie, body: { contentType: 'text/html', size: 1000 } })).status, 400);
  assert.equal((await ctx.api('POST', '/api/provider/media/video', { cookie, body: { contentType: 'video/mp4', size: 51 * 1024 * 1024 } })).status, 400);

  const up = await ctx.api('POST', '/api/provider/media/video', { cookie, body: { contentType: 'video/mp4', size: 2048 } });
  assert.equal(up.status, 200, up.text);
  assert.match(up.data.key, new RegExp(`^services/${providerId}/`));
  const u = new URL(up.data.uploadUrl);
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host', 'the Content-Type is part of the signature');
  assert.match(u.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.equal(u.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(up.data.url, `https://media.example.test/${up.data.key}`);

  // Saving before the browser has sent the file: refused.
  const early = await newService({ media: [{ type: 'video', key: up.data.key, poster: PNG }] });
  assert.equal(early.status, 400);
  assert.match(early.data.error, /didn’t finish uploading/);

  await fetch(up.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: Buffer.alloc(2048) });
  // Another provider can't attach this upload.
  assert.equal((await newService({ media: [{ type: 'video', key: up.data.key, poster: PNG }] }, otherCookie)).status, 400);
  // A video without a cover frame is refused.
  assert.equal((await newService({ media: [{ type: 'video', key: up.data.key }] })).status, 400);

  const res = await newService({ media: [{ type: 'image', src: PNG }, { type: 'video', key: up.data.key, poster: PNG }] });
  assert.equal(res.status, 201, res.text);
  const sv = res.data.service;
  const v = sv.media[1];
  assert.equal(v.type, 'video');
  assert.equal(v.key, up.data.key, 'the dashboard gets the key back to keep it on the next save');
  assert.match(v.poster, /^\/uploads\/services\//);
  assert.ok(db.prepare('SELECT attached_at FROM service_media_uploads WHERE key=?').get(up.data.key).attached_at);

  const pub = (await ctx.api('GET', '/api/services/providers/pro-studio')).data.services.find((x) => x.id === sv.id);
  assert.equal(pub.media[1].url, up.data.url);
  assert.equal(pub.media[1].key, undefined, 'the public never sees the bucket key');
  assert.ok(pub.media[1].poster);

  // The service page draws the carousel, and the share image is the first photo.
  const page = await fetch(ctx.baseUrl + pub.path);
  const html = await page.text();
  assert.match(html, /class="svgal"/);
  assert.match(html, new RegExp(`<video src="${up.data.url.replace(/[.]/g, '\\.')}"`));
  const og = (/<meta property="og:image" content="([^"]*)"/.exec(html) || [])[1] || '';
  assert.match(og, /^https?:\/\/[^/]+\/uploads\/services\//, og);

  // Drop the video: its object and its cover frame go.
  const poster = v.poster;
  const edit = await ctx.api('PATCH', `/api/provider/services/${sv.id}`, { cookie, body: { media: [{ type: 'image', src: sv.media[0].url }] } });
  assert.equal(edit.status, 200, edit.text);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!objects.has(up.data.key), 'video deleted from the bucket');
  assert.ok(!fs.existsSync(onDisk(poster)), 'cover frame deleted');
});

test('videos: at most two, a file that is too big or not a video is thrown away', async () => {
  videosOn();
  const upload = async (type = 'video/mp4', bytes = 1024, storedType = type) => {
    const up = (await ctx.api('POST', '/api/provider/media/video', { cookie, body: { contentType: type, size: bytes } })).data;
    objects.set(up.key, { body: Buffer.alloc(bytes), type: storedType });
    return up.key;
  };
  const three = [await upload(), await upload(), await upload()].map((key) => ({ type: 'video', key, poster: PNG }));
  const r = await newService({ media: three });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Up to 2 videos/);

  const big = await upload('video/mp4', 1024);
  objects.get(big).body = Buffer.alloc(51 * 1024 * 1024); // the browser sent more than it said
  assert.equal((await newService({ media: [{ type: 'video', key: big, poster: PNG }] })).status, 400);
  assert.ok(!objects.has(big), 'the oversized object is deleted');

  const html = await upload('video/mp4', 1024, 'text/html');
  assert.equal((await newService({ media: [{ type: 'video', key: html, poster: PNG }] })).status, 400);
  assert.ok(!objects.has(html));
});

test('deleting a service removes its photos and videos; never-saved uploads are swept after a day', async () => {
  videosOn();
  const up = (await ctx.api('POST', '/api/provider/media/video', { cookie, body: { contentType: 'video/webm', size: 512 } })).data;
  objects.set(up.key, { body: Buffer.alloc(512), type: 'video/webm' });
  const sv = (await newService({ media: [{ type: 'video', key: up.key, poster: PNG }, { type: 'image', src: PNG }] })).data.service;
  const files = [sv.media[0].poster, sv.media[1].url];
  assert.equal((await ctx.api('DELETE', `/api/provider/services/${sv.id}`, { cookie })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!objects.has(up.key));
  for (const f of files) assert.ok(!fs.existsSync(onDisk(f)));

  const orphan = (await ctx.api('POST', '/api/provider/media/video', { cookie, body: { contentType: 'video/mp4', size: 512 } })).data;
  objects.set(orphan.key, { body: Buffer.alloc(512), type: 'video/mp4' });
  const media = require('../src/service-media');
  assert.equal(await media.sweepPending(), 0, 'a fresh upload is left alone');
  db.prepare("UPDATE service_media_uploads SET created_at = datetime('now','-2 days') WHERE key=?").run(orphan.key);
  assert.equal(await media.sweepPending(), 1);
  assert.ok(!objects.has(orphan.key));
});

test('the CSP lets the browser upload to and play from video storage once it is configured', () => {
  const media = require('../src/service-media');
  assert.equal(media.origins({}), null);
  const o = media.origins({ ...MEDIA_ENV(1234), MEDIA_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', MEDIA_PUBLIC_URL: 'https://pub-abc.r2.dev' });
  assert.deepEqual(o, { upload: 'https://acct.r2.cloudflarestorage.com', media: 'https://pub-abc.r2.dev' });
  const csp = require('../src/security').buildCsp({ ...MEDIA_ENV(1234), MEDIA_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', MEDIA_PUBLIC_URL: 'https://pub-abc.r2.dev' });
  assert.match(csp, /connect-src [^;]*https:\/\/acct\.r2\.cloudflarestorage\.com/);
  assert.match(csp, /media-src 'self' https:\/\/pub-abc\.r2\.dev/);
  assert.doesNotMatch(require('../src/security').buildCsp({}), /media-src/);
});
