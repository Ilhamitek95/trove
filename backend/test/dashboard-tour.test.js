'use strict';
/**
 * The guided dashboard tour (docs/tour.js, live 2026-10-27):
 *   - both dashboards load it and have a Take the tour button on Overview;
 *   - it opens by itself once for an approved maker or provider, never in
 *     the admin's shop view or for the Trove Collection;
 *   - POST /api/auth/tour-seen remembers that on the account (migration 030),
 *     and the session reports it;
 *   - every button name it puts in bold is still a real button.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const tourBlock = (html) => html.slice(html.indexOf('function startTour(){'), html.indexOf('],{onEnd:'));
const bold = (src) => [...src.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);

let ctx, db, api, makerCookie, adminCookie, shopId;
before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async () => ({ id: 'test' });
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('owner@test.local',?,'Owner','admin')").run(pw);
  const maker = db.prepare("INSERT INTO users (email,password_hash,name,role,email_verified_at) VALUES ('mara@test.local',?,'Mara','seller',datetime('now'))").run(pw).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,'Kiln & Clay','kiln-clay','approved')").run(maker).lastInsertRowid;
  makerCookie = await ctx.loginAs('mara@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('owner@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

test('tour.js parses and exposes TroveTour without needing anything else on the page', () => {
  const vm = require('node:vm');
  const sandbox = { window: {}, document: {} };
  vm.runInNewContext(read('tour.js'), sandbox);
  assert.equal(typeof sandbox.window.TroveTour.start, 'function');
  assert.equal(typeof sandbox.window.TroveTour.end, 'function');
  assert.equal(sandbox.window.TroveTour.active, false);
});

for (const [file, url, dash, auto, sources] of [
  ['trove-seller.html', '/sell', 'sell',
    "SHOP.status==='approved'&&!SHOP.house&&!session.impersonating&&!(ME.toursSeen&&ME.toursSeen.sell)",
    ['trove-seller.html', 'provider-panel.js']],
  ['trove-provider.html', '/provider', 'provider',
    "ProviderPanel.provider.status==='approved'&&!me.impersonating&&!(me.user.toursSeen&&me.user.toursSeen.provider)",
    ['provider-panel.js', 'trove-provider.html']],
]) {
  test(`${file}: Take the tour button, opens once by itself, ?tour=1, and names real buttons`, () => {
    const html = read(file);
    assert.ok(html.includes('<script src="/tour.js"></script>'), 'tour script');
    assert.ok(/id="tourBtn" onclick="startTour\(\)"/.test(html), 'Take the tour button');
    assert.ok(html.includes("_t('Take the tour')"), 'button words in the dictionaries');
    assert.ok(html.includes("get('tour')==='1'"), 'still opens from ?tour=1');
    assert.ok(html.includes(`history.replaceState(null,'',troveUrl('${url}'))`), 'tidies the address');
    assert.ok(html.includes(auto), 'opens by itself only for an approved account that has not seen it, never in shop view');
    assert.ok(html.includes(`'/api/auth/tour-seen',{method:'POST',body:{dashboard:'${dash}'}}`), 'remembers it on the account');
    const labels = bold(tourBlock(html));
    assert.ok(labels.length >= 3, 'bold button names in the steps');
    const rest = sources.map(read).join('\n').replace(tourBlock(html), '');
    for (const l of labels) assert.ok(rest.includes(l), `${file}: "${l}" is a button in the dashboard`);
  });
}

test('the session says which tours have opened; tour-seen sets it once; shop view never does', async () => {
  const seen = async (cookie) => (await api('GET', '/api/auth/session', { cookie })).data.user.toursSeen;
  assert.deepEqual(await seen(makerCookie), { sell: false, provider: false });

  assert.equal((await api('POST', '/api/auth/tour-seen', { body: { dashboard: 'sell' } })).status, 401, 'signed in only');
  assert.equal((await api('POST', '/api/auth/tour-seen', { cookie: makerCookie, body: { dashboard: 'admin' } })).status, 400);

  // The admin looking at the maker's dashboard: nothing is recorded for the maker.
  const imp = await api('POST', `/api/admin/impersonate/${shopId}`, { cookie: adminCookie });
  assert.equal(imp.status, 200);
  const viewCookie = (imp.headers.get('set-cookie') || '').split(';')[0] || adminCookie;
  const r = await api('POST', '/api/auth/tour-seen', { cookie: viewCookie, body: { dashboard: 'sell' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.skipped, true);
  assert.equal(db.prepare("SELECT tour_sell_at FROM users WHERE email='mara@test.local'").get().tour_sell_at, null);

  assert.equal((await api('POST', '/api/auth/tour-seen', { cookie: makerCookie, body: { dashboard: 'sell' } })).status, 200);
  const first = db.prepare("SELECT tour_sell_at FROM users WHERE email='mara@test.local'").get().tour_sell_at;
  assert.ok(first);
  db.prepare("UPDATE users SET tour_sell_at='2026-10-27 08:00:00' WHERE email='mara@test.local'").run();
  await api('POST', '/api/auth/tour-seen', { cookie: makerCookie, body: { dashboard: 'sell' } });
  assert.equal(db.prepare("SELECT tour_sell_at FROM users WHERE email='mara@test.local'").get().tour_sell_at, '2026-10-27 08:00:00', 'only the first time counts');
  assert.deepEqual(await seen(makerCookie), { sell: true, provider: false });

  await api('POST', '/api/auth/tour-seen', { cookie: makerCookie, body: { dashboard: 'provider' } });
  assert.deepEqual(await seen(makerCookie), { sell: true, provider: true });
});
