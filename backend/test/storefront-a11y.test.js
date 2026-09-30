'use strict';
/**
 * Storefront accessibility basics that a template edit could quietly undo:
 * the signed-out session check answers 200 (a 401 is logged as a console
 * error on every page), the basket and the menus are labelled dialogs with
 * named close buttons, form fields have labels, and small text keeps AA
 * contrast.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testEnv, startApp } = require('./helpers');
testEnv({});

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const store = read('trove.html');
const services = read('trove-services.html');

let app;
before(async () => { app = await startApp(); });
after(async () => { if (app) await app.close(); });

test('GET /api/auth/session: 200 {user:null} signed out, the /me shape signed in', async () => {
  const out = await app.api('GET', '/api/auth/session');
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { user: null, shop: null, provider: null, impersonating: false });
  assert.match(out.headers.get('cache-control') || '', /no-store/);
  const reg = await app.api('POST', '/api/auth/register', { body: { role: 'buyer', name: 'Rana', email: 'rana-a11y@test.local', password: 'longenough1' } });
  assert.equal(reg.status, 201, reg.text);
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  const inn = await app.api('GET', '/api/auth/session', { cookie });
  const me = await app.api('GET', '/api/auth/me', { cookie });
  assert.equal(inn.status, 200);
  assert.equal(inn.data.user.email, 'rana-a11y@test.local');
  assert.deepEqual(inn.data, me.data);
  // /me itself still answers 401 signed out (the dashboards rely on it)
  assert.equal((await app.api('GET', '/api/auth/me')).status, 401);
});

test('the shared client asks the non-throwing session endpoint', () => {
  const api = read('api.js');
  assert.match(api, /api\('\/api\/auth\/session'\)/);
});

test('the basket drawer and mobile menu are labelled modal dialogs with named close buttons', () => {
  assert.match(store, /<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"/);
  assert.match(store, /id="drawerTitle">Your basket</);
  assert.match(store, /aria-label="Close basket" onclick="closeCart\(\)"/);
  for (const [f, html] of [['trove.html', store], ['trove-services.html', services]]) {
    assert.match(html, /<aside class="mnav" id="mnav" role="dialog" aria-modal="true" aria-label="Menu"/, f);
    assert.match(html, /aria-label="Close menu"/, f);
    assert.match(html, /menu-btn"[^>]*aria-controls="mnav" aria-expanded="false"/, f);
    assert.match(html, /<script src="\/site-chrome\.js" data-own-chrome><\/script>/, f);
    assert.match(html, /TroveDialog\.open\(\$\('mnav'\)/, f);
  }
  assert.match(services, /id="svModal" role="dialog" aria-modal="true" aria-labelledby="svTitle"/);
  const chrome = read('site-chrome.js');
  for (const needle of ["e.key === 'Escape'", "e.key !== 'Tab'", 'opener.focus']) assert.ok(chrome.includes(needle), needle);
});

test('search boxes, filters and sort are labelled; no bare <label> without a field', () => {
  for (const [f, html] of [['trove.html', store], ['trove-services.html', services]]) {
    assert.match(html, /id="searchInput" placeholder="Search Trove" aria-label="Search Trove"/, f);
    assert.match(html, /id="mSearchInput" placeholder="Search Trove" aria-label="Search Trove"/, f);
    for (const m of html.matchAll(/<label>[^<]*<\/label>\s*<(input|select|textarea)\b/g)) assert.fail(`${f}: label not tied to its field: ${m[0]}`);
  }
  assert.match(store, /id="sortSel" aria-label="Sort pieces"/);
  assert.match(store, /id="fltShop" class="fshop" aria-label="Shop"/);
});

test('muted text and small labels keep 4.5:1 on Cream; a visible focus ring exists', () => {
  const lum = (hex) => {
    const c = hex.match(/\w\w/g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [f, html] of [['trove.html', store], ['trove-services.html', services]]) {
    const muted = (html.match(/--muted:(#[0-9A-Fa-f]{6})/) || [])[1];
    assert.ok(muted, `${f}: --muted is a solid colour`);
    assert.ok(ratio(muted, '#FDF7F5') >= 4.5, `${f}: --muted on Cream`);
    assert.ok(ratio(muted, '#F2E9E4') >= 4.5, `${f}: --muted on the rose tint`);
    const eyebrow = (html.match(/--eyebrow:(#[0-9A-Fa-f]{6})/) || [])[1];
    assert.ok(eyebrow && ratio(eyebrow, '#DBC7BD') >= 4.5 && ratio(eyebrow, '#CAD5CC') >= 4.5, `${f}: eyebrow on Clay Beige and Sage`);
    assert.match(html, /:focus-visible\{outline:2px solid var\(--char\)/, f);
  }
  // one eyebrow style: 12px and the eyebrow colour
  assert.match(store, /\.eyebrow\{font-family:'Quicksand';font-weight:700;font-size:12px;[^}]*color:var\(--eyebrow\)\}/);
  assert.doesNotMatch(store, /\.(house|sell) \.eyebrow\{/);
});

test('visible copy says basket, never cart', () => {
  const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  for (const [f, html] of [['trove.html', store], ['trove-services.html', services]]) {
    assert.doesNotMatch(visible(html), /\bcart\b/i, f);
  }
  assert.doesNotMatch(store, /added to your Trove|Your Trove is empty/);
});
