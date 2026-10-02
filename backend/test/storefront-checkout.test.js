'use strict';
/**
 * Storefront checkout + privacy behaviours that live in docs/trove.html's
 * inline script, run for real in a small sandbox:
 *
 *   - every way into checkout (startCheckout, and routeTo restoring the
 *     checkout history entry on reload / Back / Forward) prepares the same
 *     guest state: no made-up addresses or cards on a real host, an empty
 *     address list for a guest, and an account offer that is unticked by
 *     default and can never block the order while hidden
 *   - the phone menu's search stops the Enter key's default action, so the
 *     menu does not reopen over the results
 *   - the shop-analytics visitor id is stored and sent only with
 *     measurement consent, and is removed once consent is refused
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const store = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8');
const services = fs.readFileSync(path.join(DOCS, 'trove-services.html'), 'utf8');

/** The source of a named top-level function in the storefront's inline script. */
function fnSrc(name) {
  const start = store.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start > -1, `function ${name} exists`);
  const rest = store.slice(start + 1);
  const end = rest.search(/\n(?:async )?function |\nconst |\nlet |\n\/\*/);
  return rest.slice(0, end === -1 ? undefined : end);
}

/** A tiny DOM: elements by id with style, checked, value. */
function sandbox({ LIVE, ME, IS_LOCAL, consent = false }) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: { display: '' }, checked: false, value: '', textContent: '' });
  el('coAcctChk').checked = true; // as if a previous visit had ticked it
  const store_ = new Map();
  const sb = {
    LIVE, ME, IS_LOCAL, els,
    $: el,
    SAVED_ADDR: [], coAddr: -1, coNewAddr: true,
    window: {},
    localStorage: {
      getItem: (k) => (store_.has(k) ? store_.get(k) : null),
      setItem: (k, v) => store_.set(k, String(v)),
      removeItem: (k) => store_.delete(k),
    },
    storage: store_,
  };
  sb.window.troveAnalyticsConsent = () => consent;
  sb.troveAnalyticsConsent = sb.window.troveAnalyticsConsent;
  vm.createContext(sb);
  const demo = store.match(/const DEMO_ADDR=\[[\s\S]*?\];/)[0];
  vm.runInContext(`${demo}\n${fnSrc('coAcctError')}\n${fnSrc('toggleCoAcct')}\n${fnSrc('prepCheckout')}\n${fnSrc('visitorId')}`, sb);
  return sb;
}

test('no made-up address or card is ever shown on a real host', () => {
  assert.doesNotMatch(store, /let SAVED_ADDR=\[\s*\{/, 'SAVED_ADDR starts empty');
  assert.doesNotMatch(store, /SAVED_CARDS/, 'the old demo card list is gone');
  assert.match(store, /\}else if\(LIVE\)\{\s*\/\/ Never a pretend card on a real host/);
  // Live guest, reloaded into checkout with stale demo data in memory.
  const sb = sandbox({ LIVE: true, ME: null, IS_LOCAL: false });
  sb.SAVED_ADDR = [{ label: 'Home', name: 'Layla Hassan', line: 'x', city: 'Dubai' }]; sb.coAddr = 0; sb.coNewAddr = false;
  vm.runInContext('prepCheckout()', sb);
  assert.equal(vm.runInContext('SAVED_ADDR.length', sb), 0);
  assert.equal(vm.runInContext('coNewAddr', sb), true);
  assert.equal(vm.runInContext('coAddr', sb), -1);
  // Outage / not live on a real host: still nothing made up.
  const off = sandbox({ LIVE: false, ME: null, IS_LOCAL: false });
  vm.runInContext('prepCheckout()', off);
  assert.equal(vm.runInContext('SAVED_ADDR.length', off), 0);
  // A developer's own machine without a backend keeps the demo addresses.
  const dev = sandbox({ LIVE: false, ME: null, IS_LOCAL: true });
  vm.runInContext('prepCheckout()', dev);
  assert.equal(vm.runInContext('SAVED_ADDR.length', dev), 2);
  assert.equal(vm.runInContext('coAddr', dev), 0);
});

test('a signed-in buyer keeps their own saved addresses', () => {
  const sb = sandbox({ LIVE: true, ME: { name: 'Amal', email: 'a@x' }, IS_LOCAL: false });
  vm.runInContext("SAVED_ADDR=[{label:'Home',name:'Amal',line:'Villa 1',city:'Dubai'}];coAddr=0;coNewAddr=false;prepCheckout()", sb);
  assert.equal(vm.runInContext('SAVED_ADDR.length', sb), 1);
  assert.equal(vm.runInContext('coAddr', sb), 0);
  assert.equal(sb.els.coAcctBox.style.display, 'none', 'no account offer for a signed-in buyer');
  assert.equal(sb.els.coAcctChk.checked, false, 'a hidden offer is never ticked');
});

test('the guest account offer is opt-in: unticked by default, password field hidden until ticked', () => {
  assert.match(store, /<input type="checkbox" id="coAcctChk" onchange="toggleCoAcct\(\)">/);
  assert.doesNotMatch(store, /id="coAcctChk" checked/);
  assert.match(store, /id="coAcctPassWrap" style="[^"]*display:none/);
  const sb = sandbox({ LIVE: true, ME: null, IS_LOCAL: false });
  vm.runInContext('prepCheckout()', sb);
  assert.equal(sb.els.coAcctBox.style.display, 'block', 'offered to a live guest');
  assert.equal(sb.els.coAcctPassWrap.style.display, sb.els.coAcctChk.checked ? 'block' : 'none');
});

test('every way into checkout prepares it the same way, and a hidden offer cannot block Place order', () => {
  assert.match(fnSrc('startCheckout'), /prepCheckout\(\);/);
  assert.match(store, /if\(st&&st\.v==='checkout'&&cart\.length\)\{prepCheckout\(\);renderCheckout\(\);showView\('checkout'\)/);
  assert.match(fnSrc('ensureGuestAccount'), /if\(ME\|\|!LIVE\|\|\$\('coAcctBox'\)\.style\.display==='none'\|\|!\$\('coAcctChk'\)\.checked\)return true;/);
});

test('phone menu search: Enter stops its default action before the menu closes', () => {
  for (const [f, html] of [['trove.html', store], ['trove-services.html', services]]) {
    const input = html.match(/<input id="mSearchInput"[^>]*>/)[0];
    assert.match(input, /if\(event\.key==='Enter'\)\{event\.preventDefault\(\);const q=this\.value;closeSheets\(\);runSearch\(q\)\}/, f);
    assert.match(input, /enterkeyhint="search"/, f);
  }
});

test('the shop-analytics visitor id needs measurement consent', () => {
  const no = sandbox({ LIVE: true, ME: null, IS_LOCAL: false, consent: false });
  no.storage.set('trove.vid.v1', 'abcdefgh12345678'); // left from before consent was withdrawn
  assert.equal(vm.runInContext('visitorId()', no), '');
  assert.equal(no.storage.has('trove.vid.v1'), false, 'removed once consent is refused');
  const yes = sandbox({ LIVE: true, ME: null, IS_LOCAL: false, consent: true });
  const v = vm.runInContext('visitorId()', yes);
  assert.match(v, /^[a-z0-9]{8,40}$/);
  assert.equal(vm.runInContext('visitorId()', yes), v, 'stable once consented');
});
