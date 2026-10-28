'use strict';
/**
 * A provider's profile photo and page background (owner, 28 Oct 2026):
 * POST /api/provider/me/image { kind, image | null }, shown on the directory
 * card, the provider page (server-drawn) and as the page's share image.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let ctx, db, cookie;
before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role,email_verified_at) VALUES ('pic@test.local',?, 'Pic','buyer', datetime('now'))").run(hashPassword('testpass123')).lastInsertRowid;
  const pid = db.prepare("INSERT INTO service_providers (user_id,name,slug,status,categories) VALUES (?, 'Lens Studio', 'lens-studio', 'approved', '[]')").run(uid).lastInsertRowid;
  const cat = require('../src/service-taxonomy').SERVICE_CATEGORIES[0].slug;
  db.prepare("INSERT INTO services (provider_id,title,category,price_cents) VALUES (?, 'Home portraits', ?, 40000)").run(pid, cat);
  cookie = await ctx.loginAs('pic@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

const onDisk = (url) => path.join(process.env.UPLOADS_DIR, url.replace('/uploads/', ''));
const setImage = (kind, image) => ctx.api('POST', '/api/provider/me/image', { cookie, body: { kind, image } });

test('profile photo and background image: set, shown publicly, replaced and removed', async () => {
  assert.equal((await setImage('banner', PNG)).status, 400, 'only avatar or cover');
  assert.equal((await setImage('avatar', 'data:image/png;base64,bm9wZQ==')).status, 400, 'not an image');

  const a = await setImage('avatar', PNG);
  assert.equal(a.status, 200, a.text);
  const avatar = a.data.provider.avatar;
  assert.match(avatar, /^\/uploads\/providers\/avatar-/);
  const cover = (await setImage('cover', PNG)).data.provider.cover;
  assert.match(cover, /^\/uploads\/providers\/cover-/);

  const card = (await ctx.api('GET', '/api/services/providers')).data.providers.find((p) => p.slug === 'lens-studio');
  assert.equal(card.avatar, avatar);
  assert.equal(card.cover, cover);
  assert.ok(card.avatarThumb && card.coverThumb);

  // The server-drawn page shows both and shares the background image.
  const html = await (await fetch(ctx.baseUrl + '/services/lens-studio')).text();
  const tag = (id) => (new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`).exec(html) || [''])[0];
  assert.match(tag('pvHero'), /class="pv-hero ph-img"/);
  assert.match(tag('pvHero'), /style="background-image:url\(&quot;\/uploads\/providers\/cover-/);
  assert.match(tag('pvAv'), /class="pv-av ph-img"/);
  assert.match(tag('pvAv'), /style="background-image:url\(&quot;\/uploads\/providers\/avatar-/);
  assert.match(tag('pvAv'), /role="img" aria-label="Profile photo of Lens Studio"/);
  assert.match(html, /id="pvAv"[^>]*><\/div>/, 'no initial over the photo');
  const og = (/<meta property="og:image" content="([^"]*)"/.exec(html) || [])[1] || '';
  assert.match(og, /\/uploads\/providers\/cover-/);
  const dir = await (await fetch(ctx.baseUrl + '/services')).text();
  assert.match(dir, /class="cover ph-img" style="background-image:url\(&quot;\/uploads\/providers\/cover-/);

  // Replacing removes the old file; null goes back to the colour tile.
  await new Promise((r) => setTimeout(r, 5));
  const again = (await setImage('avatar', PNG)).data.provider.avatar;
  assert.notEqual(again, avatar);
  assert.ok(!fs.existsSync(onDisk(avatar)), 'old photo deleted');
  const off = await setImage('avatar', null);
  assert.equal(off.data.provider.avatar, '');
  assert.ok(!fs.existsSync(onDisk(again)));
  const plain = await (await fetch(ctx.baseUrl + '/services/lens-studio')).text();
  assert.match(plain, /<div class="pv-av" id="pvAv" style="background:#[0-9A-Fa-f]{3,6}">L<\/div>/, 'initial on the colour tile again');
});
