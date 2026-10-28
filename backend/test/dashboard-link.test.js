'use strict';
/**
 * The way back to a dashboard (owner feedback 2026-10-28): a provider who
 * clicked the logo on /provider landed on the storefront with only buyer
 * links, and the account menu's 'Sell on Trove ↗' sent them to the apply
 * form, so the only way back was to sign out and in again.
 *
 * Signed in with a shop or services, every menu that a signed-in person
 * sees outside the dashboards (storefront, Services pages, the
 * server-rendered info pages, My account) now leads back to it:
 *   - docs/api.js troveDashboard(session) picks the dashboard;
 *   - docs/site-chrome.js troveShowDashboard(session) rewrites the account
 *     menu's Sell link and adds the same link to the mobile menu;
 *   - trove-account.html adds it to its sidebar.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const i18n = require('../src/i18n');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');

function apiSandbox(lang) {
  const sb = { console, setTimeout, clearTimeout, Promise, Intl, localStorage: { setItem() {} } };
  if (lang === 'ar') Object.assign(sb, { TROVE_LANG: 'ar', TROVE_I18N: i18n.dict('ar', []) });
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('api.js'), sb);
  return sb;
}

test('troveDashboard: shop → /sell, services only → /provider, buyer or signed out → none', () => {
  const en = apiSandbox('en');
  const user = { id: 1, name: 'A', email: 'a@x' };
  assert.equal(en.troveDashboard(null), null);
  assert.equal(en.troveDashboard({ user: null, shop: null, provider: null }), null);
  assert.equal(en.troveDashboard({ user, shop: null, provider: null }), null, 'a buyer keeps Sell on Trove');
  assert.deepEqual({ ...en.troveDashboard({ user, shop: null, provider: { id: 2, status: 'approved' } }) },
    { href: '/provider', label: 'Your provider dashboard' });
  assert.deepEqual({ ...en.troveDashboard({ user, shop: { id: 3 }, provider: { id: 2 } }) },
    { href: '/sell', label: 'Your shop dashboard' }, 'shop + services → /sell, which carries the Services tab');
  assert.deepEqual({ ...en.troveDashboard({ user, shop: { id: 3, isHouse: true }, provider: null }) },
    { href: '/sell', label: 'Your shop dashboard' }, 'the admin runs the Trove Collection at /sell');

  const ar = apiSandbox('ar');
  assert.deepEqual({ ...ar.troveDashboard({ user, shop: null, provider: { id: 2 } }) },
    { href: '/ar/provider', label: 'لوحة تحكم مقدّم الخدمة' });
  assert.deepEqual({ ...ar.troveDashboard({ user, shop: { id: 3 }, provider: null }) },
    { href: '/ar/sell', label: 'لوحة تحكم متجرك' });
});

test('every signed-in menu outside the dashboards shows the way back', () => {
  const chrome = read('site-chrome.js');
  // Defined before the own-chrome pages return, so the storefront and Services page get it too.
  const def = chrome.indexOf('window.troveShowDashboard = function');
  assert.ok(def > 0 && def < chrome.indexOf('if (ownChrome) return;'), 'troveShowDashboard is shared with own-chrome pages');
  assert.match(chrome, /#acctMenu a\.sell/, 'it rewrites the account menu\'s Sell link');
  assert.match(chrome, /#mnav \.mn-foot/, 'and adds the link to the mobile menu');
  assert.match(chrome, /async function renderAuth\(\)[\s\S]*?window\.troveShowDashboard\(me\);/, 'server-rendered pages call it');

  assert.match(read('trove.html'), /async function loadAuth\(\)[\s\S]*?troveShowDashboard\(session\);[\s\S]*?\n}/, 'storefront calls it');
  assert.match(read('trove-services.html'), /function renderAuth\(\)\{[\s\S]*?troveShowDashboard\(ME\);[\s\S]*?\n}/, 'Services pages call it');
  assert.match(read('trove-account.html'), /const dash=troveDashboard\(session\);[\s\S]*?\$\('signOutLink'\)\.before\(a\)/, 'My account sidebar gets it');

  // The menus being rewritten carry the hooks the helper looks for.
  for (const f of ['trove.html', 'trove-services.html']) {
    const html = read(f);
    assert.match(html, /<div class="acct-menu" id="acctMenu"[\s\S]*?<a class="sell" href="\/sell">/, `${f}: account menu has a.sell`);
    assert.match(html, /<aside[^>]*id="mnav"[\s\S]*?<div class="mn-foot">[\s\S]*?class="mn-lang"/, `${f}: mobile menu has .mn-foot + .mn-lang`);
  }
});
