'use strict';
/**
 * Google Tag Manager + the GA4 dataLayer (src/gtm.js, docs/api.js troveTrack):
 *
 *   - every page the site serves carries the tag block exactly once, in the
 *     <head> right after the viewport meta, with the Consent Mode default set
 *     BEFORE gtm.js loads, and no <noscript> iframe (it cannot respect consent)
 *   - /admin and private links (a booking / reset token or a Stripe client
 *     secret in the address) are never tagged, and pages opened from a
 *     private link pass on only the origin as the referrer
 *   - the CSP lets gtm.js and GA4's collect calls through
 *   - troveTrack: GA4's ecommerce-null rule, never throws, waits for Tag
 *     Manager when it is there, blanks anything shaped like an email
 *   - the storefront, sign-in and apply pages push the GA4 events, and the
 *     pushes name pieces and money only — never a person
 *   - the sign-up endpoints say whether they opened a new account, so the
 *     pages can tell a sign_up from a login
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });
delete process.env.GOOGLE_CLIENT_ID; // a test below switches Google sign-in on with a stub

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8').replace(/\r\n/g, '\n');
let ctx; let gtm; let seo;
before(async () => {
  ctx = await startApp();
  require('../src/seed');
  gtm = require('../src/gtm');
  seo = require('../src/seo');
});
after(async () => { await ctx.close(); });

const get = (p) => ctx.api('GET', p, { headers: { accept: 'text/html' } });
const LOADER = "j.src='https://www.googletagmanager.com/gtm.js?id='";
const CONSENT = 'gtag("consent","default"';

/** Everything the tag block must be on a tagged page. */
function assertTagged(html, where) {
  html = html.replace(/\r\n/g, '\n');
  assert.equal((html.match(/gtm:begin/g) || []).length, 1, `${where}: exactly one tag block`);
  assert.ok(html.includes(gtm.SNIPPET), `${where}: the block is the canonical one, unedited`);
  assert.ok(html.includes(gtm.GTM_ID), `${where}: the container id`);
  const consent = html.indexOf(CONSENT), loader = html.indexOf(LOADER), head = html.indexOf('</head>');
  assert.ok(consent > -1 && loader > -1, `${where}: consent default and loader present`);
  assert.ok(consent < loader, `${where}: the consent default is set before gtm.js loads`);
  assert.ok(loader < head, `${where}: in the <head>`);
  assert.match(html, /<meta name="viewport"[^>]*>\n {2}<!-- gtm:begin/, `${where}: straight after the viewport meta`);
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(noComments, /googletagmanager\.com\/ns\.html/, `${where}: no <noscript> iframe`);
  assert.doesNotMatch(noComments, /<noscript>[^]*?googletagmanager[^]*?<\/noscript>/, `${where}: no <noscript> iframe`);
}
function assertUntagged(html, where) {
  assert.doesNotMatch(html, /gtm:begin|googletagmanager|GTM-5F87RHVM/, `${where}: no Tag Manager`);
}

/* ---------------- the pages ---------------- */

test('every page the site serves carries the tag block once, consent first, in the head', async () => {
  const pages = new Set(seo.sitemapEntries().map((u) => u.loc));       // every public address
  for (const p of ['/login', '/apply', '/404.html']) pages.add(p); // sign-in, the application form + the static 404
  assert.ok([...pages].some((p) => p.startsWith('/pieces/')), 'a piece page is in the list');
  assert.ok([...pages].some((p) => /^\/services\/[a-z0-9-]+$/.test(p)), 'a provider page is in the list');
  assert.ok(['/about', '/contact', '/faq', '/returns', '/terms', '/privacy'].every((p) => pages.has(p)), 'the server-rendered pages are in the list');
  for (const p of pages) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type') || '', /text\/html/, p);
    assertTagged(r.text, p);
  }
  const miss = await get('/definitely-not-a-page');
  assert.equal(miss.status, 404);
  assertTagged(miss.text, 'the 404 page');
});

test('every page file in docs/ carries the same block — except the admin panel and the redirect stub', () => {
  const EXCLUDED = {
    // The admin panel (every customer's details, the only place a seller
    // IBAN decrypts) and the signed-in dashboards that show buyers' names,
    // addresses and phones: a container change (Custom HTML, session replay)
    // would record them. Owner decision 2026-10-02 for the dashboards.
    ...Object.fromEntries(gtm.UNTAGGED_FILES.map((f) => [f, true])),
    // Never served by the app (it 301s /index.html); a tag on a redirect stub
    // records a bogus page view and drops the referrer.
    'index.html': true,
  };
  const files = fs.readdirSync(DOCS).filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 10);
  for (const f of files) {
    if (EXCLUDED[f]) assertUntagged(read(f), f);
    else assertTagged(read(f), f);
  }
});

test('/admin is never tagged', async () => {
  const r = await get('/admin');
  assert.equal(r.status, 200);
  assertUntagged(r.text, '/admin');
});

test('the dashboards that show customers’ personal details are never tagged (seller, provider, account)', async () => {
  for (const f of ['trove-admin.html', 'trove-seller.html', 'trove-provider.html', 'trove-account.html'])
    assert.ok(gtm.UNTAGGED_FILES.includes(f), f);
  for (const p of ['/sell', '/provider', '/account', '/account?verified=1']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assertUntagged(r.text, p);
    assert.doesNotMatch(r.text, /embeds\.iubenda\.com/, `${p}: no third-party script at all`);
  }
  // Belt and braces: a block pasted back into a dashboard file is still stripped on the way out.
  const res = { set() {} };
  const tagged = `<head>
${gtm.SNIPPET}
</head>`;
  for (const p of ['/sell', '/provider', '/account', '/admin', '/Account/']) assertUntagged(gtm.forAddress({ path: p, query: {} }, res, tagged), p);
  for (const p of ['/', '/shop', '/accounts-help', '/seller-stories', '/apply']) assert.ok(gtm.forAddress({ path: p, query: {} }, res, tagged).includes('gtm:begin'), p);
});

test('cookie banner: opt-in for every visitor, no US opt-out model, no marketing purpose, no floating button', () => {
  const s = gtm.SNIPPET;
  const cfgAt = s.indexOf('_iub.csConfiguration='), embedAt = s.indexOf('embeds.iubenda.com/widgets/');
  assert.ok(cfgAt > -1 && embedAt > -1 && cfgAt < embedAt, 'the settings are declared before the iubenda embed loads');
  assert.ok(s.indexOf('gtag("consent","default"') < cfgAt, 'Consent Mode defaults still come first');
  const cfgSrc = s.slice(cfgAt).match(/_iub\.csConfiguration=(\{[^}]*\})/)[1];
  const cfg = vm.runInNewContext(`(${cfgSrc})`);
  // The site settings set usprApplies:true for everyone, and the US opt-out
  // model treats a visitor as consenting until they opt out: the second page
  // fired GA with analytics + ads granted. GDPR-style opt-in everywhere instead.
  assert.equal(cfg.enableGdpr, true);
  assert.equal(cfg.gdprAppliesGlobally, true);
  assert.equal(cfg.gdprApplies, true);
  for (const k of ['enableUspr', 'usprApplies', 'showBannerForUS', 'enableFadp', 'fadpApplies', 'enableLgpd', 'lgpdApplies'])
    assert.equal(cfg[k], false, k);
  // Purposes: 1 necessary, 2 functionality, 3 experience, 4 measurement — no
  // 5 (marketing / personalised ads): Trove runs no advertising cookies.
  assert.deepEqual(String(cfg.purposes).split(',').map(Number), [1, 2, 3, 4]);
  // The footer's Cookie settings link reopens the panel; no extra tab stops before Skip to content.
  assert.equal(cfg.floatingPreferencesButtonDisplay, false);
});

test('private links never meet Tag Manager, and pass on only the origin', async () => {
  const piece = [...seo.sitemapEntries().map((u) => u.loc)].find((p) => p.startsWith('/pieces/'));
  const PRIVATE = [
    '/reset?token=abc123def456',
    '/login?token=abc123def456',
    '/services/booking/SRV-ABC123?t=0123456789abcdef',
    `/services/pay/SRV-ABC123-${'a'.repeat(32)}`,
    '/?payment_intent=pi_123&payment_intent_client_secret=pi_123_secret_456&redirect_status=succeeded',
    `${piece}?payment_intent=pi_123&payment_intent_client_secret=pi_123_secret_456`,
    '/no-such-page?token=abc',
  ];
  for (const p of PRIVATE) {
    const r = await get(p);
    assert.ok([200, 404].includes(r.status), `${p} → ${r.status}`);
    assertUntagged(r.text, p);
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin', `${p}: the next page's referrer is the origin only`);
  }
  // the pages still work: the booking page is the Services page, the reset page the sign-in page
  assert.match((await get('/services/booking/SRV-ABC123?t=x')).text, /id="bkview"/);
  assert.match((await get('/reset?token=x')).text, /id="submitBtn"/);
  // and an ordinary address keeps the site-wide policy
  for (const p of ['/', '/login', '/services', piece]) {
    const r = await get(p);
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', p);
  }
  assert.equal(gtm.isPrivateAddress({ path: '/Reset', query: {} }), true, 'case-insensitive');
  assert.equal(gtm.isPrivateAddress({ path: '/services/makers-guild', query: {} }), false);
  assert.equal(gtm.isPrivateAddress({ path: '/shop', query: { q: 'mug' } }), false);
});

test('the CSP lets gtm.js and the GA4 collect calls through, still without eval', async () => {
  const csp = (await get('/')).headers.get('content-security-policy');
  const dir = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '').split(/\s+/);
  assert.ok(dir('script-src').includes('https://www.googletagmanager.com'));
  for (const h of ['https://www.googletagmanager.com', 'https://*.googletagmanager.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com']) {
    assert.ok(dir('connect-src').includes(h), `connect-src ${h}`);
  }
  assert.ok(dir('img-src').includes('https:'), 'GA4 image fallbacks');
  assert.doesNotMatch(csp, /unsafe-eval/);
});

/* ---------------- troveTrack (docs/api.js) ---------------- */

function loadApiJs(extra = {}) {
  const sandbox = { setTimeout, clearTimeout, Promise, console, ...extra };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(DOCS, 'api.js'), 'utf8'), sandbox);
  return sandbox;
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('troveTrack: ecommerce events clear the last ecommerce object first; others push as they are', async () => {
  const w = loadApiJs();
  assert.equal(typeof w.troveTrack, 'function');
  await w.troveTrack('view_item', { ecommerce: { currency: 'AED', value: 64, items: [{ item_id: '1', item_name: 'Mug', price: 64, quantity: 1 }] } });
  await w.troveTrack('login', { method: 'email' });
  assert.deepEqual(plain(w.dataLayer), [
    { ecommerce: null },
    { event: 'view_item', ecommerce: { currency: 'AED', value: 64, items: [{ item_id: '1', item_name: 'Mug', price: 64, quantity: 1 }] } },
    { event: 'login', method: 'email' },
  ]);
});

test('troveTrack: blanks anything shaped like an email, and never throws', async () => {
  const w = loadApiJs();
  await w.troveTrack('add_to_cart', { ecommerce: { items: [{ item_name: 'Write to me at maker@example.com', price: 10 }] } });
  assert.equal(w.dataLayer[1].ecommerce.items[0].item_name, 'Write to me at [redacted]');
  w.dataLayer = { push() { throw new Error('blocked'); } };
  await w.troveTrack('purchase', { ecommerce: { transaction_id: 'TRV-ABCD12' } }); // resolves, no throw
});

test('troveTrack: waits for Tag Manager when it is there (eventCallback), never longer than its timeout', async () => {
  const w = loadApiJs({ google_tag_manager: {} });
  let settled = false;
  const p = w.troveTrack('sign_up', { method: 'google' }).then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'waits for Tag Manager');
  const msg = w.dataLayer[0];
  assert.equal(typeof msg.eventCallback, 'function');
  assert.equal(msg.eventTimeout, 1000);
  msg.eventCallback('GTM-5F87RHVM');
  await p;
  assert.equal(settled, true);
});

/* ---------------- the events on the pages ---------------- */

/** The source of a named function in a page's inline script. */
function fnBody(src, name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start > -1, `function ${name} exists`);
  const next = src.slice(start + 1).search(/\n(?:async )?function |\nconst |\nlet /);
  return src.slice(start, next === -1 ? undefined : start + 1 + next);
}
/** Each troveTrack(...) / gaEcommerce(...) / gaAuth(...) call, parentheses balanced. */
function calls(src, fn) {
  const out = [];
  const re = new RegExp(`\\b${fn}\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + fn.length;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}
const PERSONAL = /\b(email|phone|mobile|address|iban|password|user|ME|who|note|name)\b/;
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");

test('the storefront pushes view_item, add_to_cart, begin_checkout and purchase in GA4 shape', () => {
  const src = read('trove.html');
  assert.match(fnBody(src, 'openPDP'), /gaEcommerce\('view_item',\[gaItem\(p,1\)\]\)/);
  assert.match(fnBody(src, 'addToCart'), /gaEcommerce\('add_to_cart',\[gaItem\(p,1,opts,extras\)\]\)/);
  const add = fnBody(src, 'addToCart');
  assert.ok(add.indexOf("gaEcommerce('add_to_cart'") > add.indexOf('cart.push('), 'only once the piece is really in the basket');
  const start = fnBody(src, 'startCheckout');
  assert.ok(start.indexOf("gaEcommerce('begin_checkout',gaCartItems())") > start.indexOf("toast('Your basket is empty')"), 'not for an empty basket');
  const conf = fnBody(src, 'showConfirmation');
  assert.ok(conf.indexOf('gaPurchase(orderId)') > -1 && conf.indexOf('gaPurchase(orderId)') < conf.indexOf('cart=[]'), 'purchase reads the basket before it is emptied');
  // purchase: the public order number, the charged total incl. delivery, the delivery fee, once per order
  const purchase = fnBody(src, 'gaPurchase');
  assert.match(purchase, /transaction_id:String\(orderId\)/);
  assert.match(purchase, /shipping/);
  assert.match(purchase, /lastOrder\.amountCents\/100/, 'the server total, fils → AED');
  assert.match(purchase, /sessionStorage\.getItem\(key\)\)return;sessionStorage\.setItem\(key/, 'once per order');
  for (const where of [fnBody(src, 'placeOrder')]) assert.equal((where.match(/amountCents:Number\(/g) || []).length, 2, 'both payment paths hand over the total');
  // ecommerce envelope + item shape
  assert.match(fnBody(src, 'gaEcommerce'), /if\(!LIVE/, 'demo mode never reports');
  assert.match(fnBody(src, 'gaEcommerce'), /ecommerce:\{currency:'AED',value:/);
  const item = fnBody(src, 'gaItem').match(/return \{([^}]*)\}/)[1];
  assert.deepEqual([...item.matchAll(/(\w+):/g)].map((m) => m[1]), ['item_id', 'item_name', 'item_brand', 'item_category', 'price', 'quantity']);
});

test('sign_up and login are pushed with the method only', () => {
  const login = read('trove-login.html');
  assert.match(fnBody(login, 'signIn'), /r&&r\.created\?\['sign_up','email'\]:\['login','email'\]/);
  assert.match(fnBody(login, 'signIn'), /\['login',phoneMode\?'phone':'email'\]/);
  assert.match(fnBody(login, 'onGoogleCredential'), /gaAuth\(r&&r\.created\?'sign_up':'login','google'\)/);
  assert.match(fnBody(login, 'gaAuth'), /troveTrack\(event,\{method\}\)/);
  const store = read('trove.html');
  for (const fn of ['ensureGuestAccount', 'confCreateAccount']) assert.match(fnBody(store, fn), /reg\.created&&window\.troveTrack\)troveTrack\('sign_up',\{method:'email'\}\)/, fn);
  assert.match(fnBody(read('trove-apply.html'), 'submitApp'), /troveTrack\('sign_up',\{method:'email'\}\)/);
});

test('no push ever carries personal data, and every page that pushes loads troveTrack', () => {
  for (const f of fs.readdirSync(DOCS).filter((n) => /\.html$/.test(n))) {
    const src = read(f);
    const pushes = [...calls(src, 'troveTrack'), ...calls(src, 'gaEcommerce'), ...calls(src, 'gaAuth')]
      .filter((c) => !/^\w+\((event|name),/.test(c)); // the helpers' own forwarding lines
    if (!pushes.length) continue;
    assert.match(src, /<script src="\/?api\.js"><\/script>/, `${f} loads api.js (troveTrack)`);
    for (const c of pushes) assert.doesNotMatch(code(c), PERSONAL, `${f}: ${c}`);
  }
  const store = read('trove.html');
  for (const fn of ['gaPurchase', 'gaEcommerce', 'gaCartItems']) assert.doesNotMatch(code(fnBody(store, fn)), PERSONAL, fn);
});

/* ---------------- sign-up vs log-in ---------------- */

test('the sign-up endpoints say whether they opened a new account', async (t) => {
  // a new buyer
  let r = await ctx.api('POST', '/api/auth/register', { body: { role: 'buyer', name: 'Gia Buyer', email: 'gia@test.local', password: 'testpass123' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.created, true);
  // the same person applies to sell with their password: the account already existed
  r = await ctx.api('POST', '/api/auth/register', { body: {
    role: 'seller', name: 'Gia Buyer', email: 'gia@test.local', password: 'testpass123', shopName: 'Gia Makes',
    location: 'Al Quoz, Dubai', about: 'Small-batch ceramics from a studio in Al Quoz, glazed by hand.', instagram: '@giamakes', phone: '+971501234569',
  } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.created, false);
  // a new services applicant
  r = await ctx.api('POST', '/api/services/apply', { body: {
    name: 'Sami Provider', email: 'sami@test.local', password: 'testpass123', providerName: 'Sami Sessions', categories: ['workshops'],
    location: 'Dubai, UAE', about: 'Calligraphy workshops at your place, for groups of up to eight.', experience: '3+ years',
    instagram: '@samisessions', links: '', phone: '+971 50 111 2299', agreeSub: true, agreeTerms: true,
  } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.created, true);
  // Google: the first sign-in opens the account, the next one is a log-in
  const google = require('../src/google-auth');
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  const realVerify = google.verifyIdToken;
  google.verifyIdToken = async (cred) => (cred === 'good-token' ? { email: 'gtm-googler@example.com', name: 'Googler' } : null);
  t.after(() => { google.verifyIdToken = realVerify; delete process.env.GOOGLE_CLIENT_ID; });
  r = await ctx.api('POST', '/api/auth/google', { body: { credential: 'good-token' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.created, true);
  r = await ctx.api('POST', '/api/auth/google', { body: { credential: 'good-token' } });
  assert.equal(r.data.created, false);
});
