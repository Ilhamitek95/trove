'use strict';
/**
 * Third-review medium findings, group F1 (storefront, product page,
 * checkout, accessibility) — 2 Oct 2026:
 *
 *   F084 money in one format whatever the device language, fils as .50
 *   F085 checkout errors under the field + a live-region toast
 *   F137 saved addresses, 'Use a new address', 'Back to basket' and the
 *        guest link are reachable by keyboard
 *   F138 heading accent words meet 3:1
 *   F154 while the Collection is empty the hero's main button opens the Marketplace
 *   F155 the AED 30 delivery fee is stated on the product page and promo bar
 *   F157 iubenda's floating button never covers the sticky buy buttons
 *   F158 the free-delivery prompt matches the 'over AED 200' rule
 *   F164 the confirmation has its own address and shows the receipt
 *   F192 an address naming another emirate is refused, Emirate has no default
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '', PUBLIC_URL: 'https://troveathome.com' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const store = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8').replace(/\r\n/g, '\n');
const services = fs.readFileSync(path.join(DOCS, 'trove-services.html'), 'utf8').replace(/\r\n/g, '\n');

/** The source of a named top-level function in the storefront's inline script. */
function fnSrc(name) {
  const start = store.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start > -1, `function ${name} exists`);
  const rest = store.slice(start + 1);
  const end = rest.search(/\n(?:async )?function |\nconst |\nlet |\n\/\*/);
  return rest.slice(0, end === -1 ? undefined : end);
}
const constSrc = (name) => {
  const m = store.match(new RegExp(`\\nconst ${name}=[^\\n]*`));
  assert.ok(m, `const ${name} exists`);
  return m[0];
};

const ADDRESS = { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' };
let ctx; let db; let buyerCookie; let otherCookie; let mugId;
const checkout = (body, cookie) => ctx.api('POST', '/api/checkout', { cookie, body: { items: [{ productId: mugId, qty: 1 }], address: ADDRESS, phone: '0501234567', email: 'guest@test.local', ...body } });

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal Rashid','buyer')").run(pw);
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('other@test.local',?, 'Other','buyer')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  const shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  mugId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shopId, 'Mug', 'Ceramics', 6450, 50).lastInsertRowid;
  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

/* ---------------- F084 money format ---------------- */
test('F084: prices are AED with Western digits, thousands commas and .50 for fils, whatever the device language', () => {
  const sb = { troveIso: (s) => s };
  // aed() is the shared formatter from docs/api.js (troveMoney)
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'api.js'), 'utf8');
  const body = api.match(/window\.troveMoney = function \(n, opts\) \{([\s\S]*?)\r?\n  \};/)[1];
  sb.troveMoney = new Function('window', `return function (n, opts) {${body}\n};`)(sb);
  vm.runInNewContext(`${fnSrc('aedNum')}\n${fnSrc('aed')}\n${fnSrc('plusAed')}\nthis.aed=aed;this.plusAed=plusAed;`, sb);
  // force a foreign default locale: the format must not follow it
  const orig = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (loc, o) { return orig.call(this, loc || 'ar-EG', o); };
  try {
    assert.equal(sb.aed(64), 'AED 64');
    assert.equal(sb.aed(64.5), 'AED 64.50');
    assert.equal(sb.aed(155.5), 'AED 155.50');
    assert.equal(sb.aed(1234.5), 'AED 1,234.50');
    assert.equal(sb.aed(0.1 + 0.2), 'AED 0.30');
    assert.equal(sb.plusAed(15), '+AED 15');
    assert.equal(sb.plusAed(2.5), '+AED 2.50');
  } finally { Number.prototype.toLocaleString = orig; }
  assert.doesNotMatch(store, /'AED '\+[a-zA-Z.]+\.toLocaleString\(\)/, 'no device-locale price left');
});

/* ---------------- F158 free-delivery prompt ---------------- */
test('F158: the basket prompt says MORE than the gap, matching free delivery only over AED 200', () => {
  const sb = { FEES: { serviceFeeCents: 0, deliveryFeeCents: 3000, freeDeliveryThresholdCents: 20000 } };
  vm.runInNewContext(`${fnSrc('feeBreakdown')}\nthis.fb=feeBreakdown;`, sb);
  const at192 = sb.fb(192);
  assert.equal(at192.delivery, 30);
  assert.equal(at192.remaining, 8);
  const at200 = sb.fb(200);
  assert.equal(at200.delivery, 30, 'exactly AED 200 still pays delivery');
  assert.equal(at200.remaining, 0);
  assert.equal(sb.fb(200.5).delivery, 0);
  assert.ok(store.includes("_t('Add more than {amount} for free delivery — it starts on orders over {threshold}.'"), 'the prompt says more than');
  assert.ok(!store.includes("'Add {amount} more for free delivery.'"), 'the old promise is gone');
  // and the server agrees: exactly the threshold pays delivery
  const fees = require('../src/fees');
  assert.equal(fees.deliveryFor(20000), 3000);
  assert.equal(fees.deliveryFor(20001), 0);
});

/* ---------------- F155 delivery fee before the basket ---------------- */
test('F155: the product page and promo bar state the AED 30 delivery fee', async () => {
  const sb = { FEES: { deliveryFeeCents: 3000, freeDeliveryThresholdCents: 20000 }, aed: (n) => `AED ${n}`, _t: (k, v) => k.replace(/\{(\w+)\}/g, (m, x) => v[x]) };
  vm.runInNewContext(`${fnSrc('pdpDeliveryLine')}\nthis.line=pdpDeliveryLine;`, sb);
  assert.equal(sb.line({ price: 64 }), 'Delivery AED 30 · free on orders over AED 200');
  assert.equal(sb.line({ price: 200 }), 'Delivery AED 30 · free on orders over AED 200');
  assert.equal(sb.line({ price: 250 }), 'Free delivery on orders over AED 200');
  const pdp = (await ctx.api('GET', require('../src/seo').pieceUrl({ id: mugId, name: 'Mug' }), { headers: { accept: 'text/html' } })).text;
  assert.match(pdp, /<span id="pdpFreeLine">Delivery AED 30 · free on orders over AED 200<\/span>/, 'server-rendered too');
  const content = require('../src/content');
  assert.match(content.DEFAULTS['site.promo'].text, /Delivery AED 30, free on orders over AED 200/);
  for (const html of [store, services]) assert.ok(html.includes('Delivery AED 30, free on orders over AED 200</div>'), 'static promo bars');
  // a saved promo still carrying the old default is rewritten; any other wording is left alone
  const mig = require('../src/migrations/024-F1-delivery-fee-copy');
  db.prepare("INSERT OR REPLACE INTO site_content (section, value) VALUES ('site.promo', ?)").run(JSON.stringify({ text: 'Delivering across Dubai & Abu Dhabi · Free delivery on orders over AED 200' }));
  mig.up(db);
  assert.match(JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='site.promo'").get().value).text, /Delivery AED 30/);
  db.prepare("UPDATE site_content SET value=? WHERE section='site.promo'").run(JSON.stringify({ text: 'Eid slots open' }));
  mig.up(db);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='site.promo'").get().value).text, 'Eid slots open');
  db.prepare("DELETE FROM site_content WHERE section='site.promo'").run();
});

/* ---------------- F085 checkout errors ---------------- */
test('F085: the toast is a live region; checkout problems sit under their field, which takes the focus', () => {
  assert.match(store, /<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true">/);
  const po = fnSrc('placeOrder');
  assert.doesNotMatch(po, /window\.scrollTo\(0,0\)/, 'no jump to the top');
  for (const id of ['coEmail', 'coPhone', 'coNewName', 'coNewLine', 'coNewEmirate']) assert.match(po, new RegExp(`coInvalid\\('${id}'`), id);
  // run coFieldErr/coInvalid against a tiny DOM
  const els = {};
  const mk = (id) => {
    const el = { id, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      focused: false, focus() { this.focused = true; }, scrollIntoView() {}, closest() { return box; } };
    els[id] = el; return el;
  };
  const box = { appendChild(e) { els[e.id] = e; e.remove = () => { delete els[e.id]; }; } };
  mk('coPhone');
  let toasted = '';
  const sb = { $: (id) => els[id], REDUCED: true, toast: (m) => { toasted = m; },
    document: { addEventListener() {}, getElementById: (id) => els[id] || null, createElement: () => ({ id: '', className: '', textContent: '' }), querySelectorAll: () => Object.values(els).filter((e) => e.className === 'co-ferr') } };
  vm.runInNewContext(`${fnSrc('coFieldErr')}\n${fnSrc('coClearErrs')}\n${fnSrc('coInvalid')}\nthis.inv=coInvalid;this.clear=coClearErrs;`, sb);
  sb.inv('coPhone', 'Add a UAE mobile so the driver can reach you');
  assert.equal(els.coPhone.attrs['aria-invalid'], 'true');
  assert.equal(els.coPhone.attrs['aria-describedby'], 'coPhoneErr');
  assert.equal(els.coPhoneErr.textContent, 'Add a UAE mobile so the driver can reach you');
  assert.ok(els.coPhone.focused, 'the field takes the focus');
  assert.equal(toasted, 'Add a UAE mobile so the driver can reach you', 'the toast is the second cue');
  sb.clear();
  assert.equal(els.coPhone.attrs['aria-invalid'], undefined);
  assert.equal(els.coPhoneErr, undefined);
});

/* ---------------- F137 keyboard ---------------- */
test('F137: every checkout choice is a real button or link a keyboard can reach', () => {
  const rc = fnSrc('renderCheckout');
  assert.doesNotMatch(rc, /<div class="saved-opt/, 'no div pretending to be a choice');
  assert.match(rc, /<button type="button" class="saved-opt \$\{on\?'on':''\}" aria-pressed="\$\{on\}"/);
  assert.match(rc, /<button type="button" class="saved-opt \$\{coNewAddr\?'on':''\}" aria-pressed="\$\{coNewAddr\}" onclick="newAddr\(\)">/);
  assert.match(store, /<button type="button" class="co-back" onclick="openCart\(\)">← Back to basket<\/button>/);
  assert.match(store, /<a href="#" onclick="guestInstead\(\);return false">check out as a guest<\/a>/);
  assert.doesNotMatch(store, /<a onclick=/, 'no link without an address');
  assert.match(store, /\.saved-opt\{display:flex;width:100%;text-align:start;font-family:inherit;color:inherit;background:none;/, 'the buttons keep the look');
});

/* ---------------- F138 contrast ---------------- */
test('F138: accent words in headings meet 3:1 on Cream, Clay Beige and Sage', () => {
  const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const ink = store.match(/--coral-text:(#[0-9A-Fa-f]{6})/)[1];
  assert.notEqual(ink.toUpperCase(), '#A85138', 'not the banned rust');
  for (const bg of ['#FDF7F5', '#DBC7BD', '#CAD5CC', '#FFFCFA']) assert.ok(ratio(ink, bg) >= 3, `${ink} on ${bg}: ${ratio(ink, bg).toFixed(2)}`);
  for (const [name, html] of [['trove.html', store], ['trove-services.html', services], ['404.html', fs.readFileSync(path.join(DOCS, '404.html'), 'utf8')]]) {
    assert.doesNotMatch(html, /(h[1-3]|hero-t|\[data-vh\])[^{}]*\b(em|span)\{[^}]*color:var\(--coral\)/, `${name}: no heading accent in plain Orange`);
  }
  assert.doesNotMatch(store, /<em style="font-style:normal;color:var\(--coral\)">/);
});

/* ---------------- F154 hero while the Collection is empty ---------------- */
test('F154: the hero button follows the Collection: Marketplace while it is empty, the Collection once it has pieces', () => {
  assert.match(store, /<a class="btn btn-dark soon-only" id="heroMarketBtn" href="\/shop">Shop the Marketplace<\/a>/);
  assert.match(store, /<button class="btn btn-dark live-only" id="heroShopBtn"/);
  assert.match(store, /\.hero \.soon-only\{display:none\}/);
  assert.match(store, /html\.house-soon \.hero \.live-only\{display:none\}/);
  assert.match(store, /html\.house-soon \.hero \.btn\.soon-only\{display:inline-flex\}/);
  assert.match(store, /<a class="hero-tag" href="\/shop\/trove-collection"/, 'the Collection is never hidden');
});

/* ---------------- F157 cookie button ---------------- */
test('F157: the floating cookie button never covers the sticky buy buttons', () => {
  for (const html of [store, services]) assert.match(html, /\.iubenda-tp-btn\{display:none!important\}/);
  assert.match(require('../src/gtm').SNIPPET, /floatingPreferencesButtonDisplay:false/);
  assert.match(store, /Cookie settings/, 'the footer link stays');
});

/* ---------------- F192 service area ---------------- */
test('F192: an address naming another emirate is refused even with Dubai chosen; Emirate has no default', async () => {
  const sa = require('../src/service-area');
  for (const a of [
    { ...ADDRESS, city: 'Al Nahda, Sharjah, Dubai' },
    { ...ADDRESS, line: 'Villa 3, Al Rashidiya, Ajman' },
    { ...ADDRESS, city: 'Ras Al Khaimah, Dubai' },
    { ...ADDRESS, city: 'Umm Al Quwain' },
    { ...ADDRESS, city: 'الشارقة، دبي' },
  ]) {
    assert.equal(sa.isDeliverable(a), false, JSON.stringify(a));
    const res = await checkout({ address: a });
    assert.equal(res.status, 400, JSON.stringify(a));
    assert.match(res.data.error, /Dubai and Abu Dhabi only/);
  }
  for (const a of [ADDRESS, { ...ADDRESS, city: 'Ras Al Khor, Dubai' }, { ...ADDRESS, city: 'Al Nahda 2, Dubai' }, { ...ADDRESS, city: 'Khalifa City, Abu Dhabi', emirate: 'Abu Dhabi' }]) {
    assert.equal(sa.isDeliverable(a), true, JSON.stringify(a));
  }
  // saved account addresses follow the same rule
  const saved = await ctx.api('POST', '/api/account/addresses', { cookie: buyerCookie, body: { name: 'A', line: 'Flat 2', city: 'Al Majaz, Sharjah, Dubai' } });
  assert.equal(saved.status, 400);
  // the page uses the same list as the server
  const client = constSrc('OTHER_EMIRATES').match(/=(\/.*\/i);/)[1];
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'service-area.js'), 'utf8').match(/const OTHER_EMIRATES = (\/.*\/i);/)[1];
  assert.equal(client, serverSrc, 'client and server emirate lists match');
  const rc = fnSrc('renderCheckout');
  assert.match(rc, /<select id="coNewEmirate" required><option value="" selected disabled>\$\{_t\('Choose emirate…'\)\}<\/option>/);
  assert.doesNotMatch(fnSrc('checkoutPayload'), /\|\|'Dubai'/, 'no silent Dubai default');
});

/* ---------------- F164 the order's own page ---------------- */
test('F164: /order/<id>/thanks is a private page; the receipt answers only the order\'s own buyer', async () => {
  const placed = await checkout({});
  assert.equal(placed.status, 200, placed.text);
  const id = placed.data.orderId;
  assert.match(placed.data.receiptKey, /^[A-Za-z0-9_-]{32}$/);
  // demo completion so the order is paid
  const setCookie = placed.headers.get('set-cookie');
  const guestCookie = setCookie ? setCookie.split(';')[0] : '';
  assert.equal((await ctx.api('POST', '/api/checkout/demo-complete', { cookie: guestCookie, body: { orderId: id } })).status, 200);

  const page = await ctx.api('GET', `/order/${id}/thanks`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag') || '', /noindex/);
  assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(page.text, /<link rel="canonical"/);
  assert.doesNotMatch(page.text, /gtm:begin/, 'never tagged: it shows an address and a mobile');
  assert.match(page.text, /<div class="view active" id="view-confirm">/);
  assert.ok(!page.text.includes('Harbour Views'), 'nothing about the order in the HTML itself');
  assert.equal((await ctx.api('GET', `/ar/order/${id}/thanks`, { headers: { accept: 'text/html' } })).status, 200, 'Arabic twin');

  const url = `/api/checkout/receipt/${id}`;
  // the key, the placing session, nobody else
  const byKey = await ctx.api('GET', url, { headers: { 'x-receipt-key': placed.data.receiptKey } });
  assert.equal(byKey.status, 200);
  const r = byKey.data.receipt;
  assert.equal(r.id, id);
  assert.equal(r.subtotal, 64.5);
  assert.equal(r.delivery, 30);
  assert.equal(r.total, 94.5);
  assert.equal(r.items[0].name, 'Mug');
  assert.equal(r.items[0].shop.name, 'Test Pots');
  assert.equal(r.address.line, 'Apt 4, Harbour Views');
  assert.equal(r.phone, '+971501234567');
  assert.equal(byKey.headers.get('cache-control'), 'private, no-store');
  assert.equal((await ctx.api('GET', url, { cookie: guestCookie })).status, 200, 'the session that placed it');
  assert.equal((await ctx.api('GET', url)).status, 404, 'no key');
  assert.equal((await ctx.api('GET', url, { headers: { 'x-receipt-key': 'x'.repeat(32) } })).status, 404, 'a wrong key');
  assert.equal((await ctx.api('GET', url, { cookie: otherCookie })).status, 404, 'another buyer');
  assert.equal((await ctx.api('GET', '/api/checkout/receipt/TRV-NOPE1', { headers: { 'x-receipt-key': placed.data.receiptKey } })).status, 404, 'a key opens only its own order');

  // a signed-in buyer's own order needs no key
  const mine = await checkout({}, buyerCookie);
  assert.equal((await ctx.api('GET', `/api/checkout/receipt/${mine.data.orderId}`, { cookie: buyerCookie })).status, 200);
  assert.equal((await ctx.api('GET', `/api/checkout/receipt/${mine.data.orderId}`, { cookie: otherCookie })).status, 404);

  // the page goes there after paying, keeps the key on the device, and reopens it
  assert.match(fnSrc('showConfirmation'), /setAddress\('\/order\/'\+encodeURIComponent\(orderId\)\+'\/thanks'/);
  assert.match(store, /if\(\(m=path\.match\(\/\^\\\/order\\\/\(\[A-Za-z0-9-\]\+\)\\\/thanks\\\/\?\$\/\)\)\)\{showOrderPage\(m\[1\]\)/);
  assert.doesNotMatch(fnSrc('showConfirmation'), /receiptKey|\?t=/, 'the key never goes in the address');
  const robots = (await ctx.api('GET', '/robots.txt')).text;
  assert.match(robots, /Disallow: \/order\//);
  assert.match(robots, /Disallow: \/ar\/order\//);
});
