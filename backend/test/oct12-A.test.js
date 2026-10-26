'use strict';
/**
 * Low + nit fix round, group A (buyer storefront) — 12 Oct 2026.
 * The storefront's behaviours that live in docs/trove.html's inline script are
 * run for real in small sandboxes; the server parts through the app.
 *
 *   F210 the payment form checks the server's total against the button's
 *   F217 a redirect-type payment returns to the order page and finishes there
 *   F283 standards mode (<!doctype html>) without a layout shift
 *   F286 Place order locks at the first tap
 *   F287 the cookie banner never hides the basket's total or Checkout
 *   F288 autofill hints; the new-address form survives a look at a saved one
 *   F290 reloads and Back/Forward don't log a search again
 *   F356 a long shelf draws 48 pieces at a time
 *   F357 a lighter catalogue for the storefront (?view=list), opt-in
 *   F359 the fonts come from Trove's own /fonts
 *   F369 the hero slideshow can be paused; keyboard focus holds it
 *   F388 returning buyers can sign in from checkout
 *   F389 the nav's 'Marketplace' is 'Makers'
 *   F390 the no-results hint words are real shelves
 *   F394 'View basket' on the added-to-basket toast
 *   F395/F513 the empty Collection shelf: no '0 pieces', the filter shows it
 *   F423 sold-out cards say so
 *   F424 an early tap is kept, not lost
 *   F426 the 404 page has the site header; /makers and /pieces redirect
 *   F430 the card form follows the server's own answer
 *   F434 an app hand-off link adds to the basket, never swaps it
 *   F473 price bands are half-open
 *   F474 the makers loop stops off the homepage
 *   F476 'Seller fees' opens the fees question
 *   F477 no unused helper, no demo cards off a developer's machine
 *   F507 no separate health check before the catalogue
 *   F510 one delivery line when every parcel arrives together
 *   F512 a personalised piece's returns line
 *   F515 44px menu footer links
 *   F523 a dropped basket line is named
 *   F524 the empty basket offers somewhere to go
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '', PUBLIC_URL: 'https://troveathome.com' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8').replace(/\r\n/g, '\n');
const store = read('trove.html');
const services = read('trove-services.html');

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
const run = (code, ctx) => { vm.createContext(ctx); vm.runInContext(code, ctx); return ctx; };
const t = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null ? v[k] : m));
const tn = (n, one, other, v) => t(n === 1 ? one : other, { n, ...(v || {}) });

let ctx; let db; let shopId; let mugId; let soldId;
before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(hashPassword('testpass123')).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  const long = 'A hand-thrown stoneware mug with a reactive glaze. '.repeat(12).trim();
  mugId = db.prepare("INSERT INTO products (shop_id,name,description,category,price_cents,stock,status) VALUES (?,?,?,?,?,?,'live')").run(shopId, 'Mug', long, 'Ceramics', 6450, 5).lastInsertRowid;
  soldId = db.prepare("INSERT INTO products (shop_id,name,description,category,price_cents,stock,status) VALUES (?,?,?,?,?,?,'live')").run(shopId, 'Gone Bowl', 'Short words.', 'Ceramics', 9000, 0).lastInsertRowid;
});
after(async () => { await ctx.close(); });
const get = (p) => ctx.api('GET', p, { headers: { accept: 'text/html' } });

/* ---------------- F283 standards mode ---------------- */
test('F283: the storefront is served in standards mode, with the inline-box fixes that keep its layout', async () => {
  assert.ok(store.startsWith('<!doctype html>\n'), 'doctype first');
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /^<!doctype html>\n<!-- Trove/);
  assert.match(res.text, /<html lang="en"[^>]*>/, 'the server still finds the html tag');
  // the shifts standards mode brought (inline boxes taking their parent's line box), each closed
  assert.match(store, /\.eyebrow\{[^}]*display:block;/);
  assert.match(store, /\.marquee \.mk \.tx span\{display:block;/);
  assert.match(store, /\.perso-in\{display:block;/);
  assert.match(store, /\.co-back\{[^}]*display:flex;width:fit-content;/);
  // (the old sell page's .h-lane went with its hand-off timeline on 2026-10-12; the new page's small spans are blocks too)
  assert.match(store, /\.sp-seg \.sub\{display:block;/);
  assert.match(store, /\.acc-body \.link-more\{display:block;width:fit-content;line-height:1\.4\}/);
  assert.match(store, /#vRevHead,#pdpRevHead\{display:flex;flex-wrap:wrap;align-items:baseline;/);
  assert.match(read('404.html'), /^<!doctype html>/);
});

/* ---------------- F290 search log ---------------- */
test('F290: a typed or tapped search is logged; a reload or Back/Forward of the same address is not', () => {
  const calls = [];
  const sb = run(`let ROUTING=false;\n${fnSrc('runSearch')}`, {
    state: { q: '' }, LIVE: true, syncFilterUI() {}, renderShop() {}, showView() {}, jumpTop() {}, shelfAddress() {},
    filteredProducts: () => [1, 2], TroveAPI: { api: (p, o) => { calls.push([p, o.body.q]); return Promise.resolve(); } },
  });
  vm.runInContext("runSearch('vase')", sb);
  assert.deepEqual(calls, [['/api/search-log', 'vase']], 'typed');
  vm.runInContext("ROUTING=true;runSearch('vase')", sb);
  assert.equal(calls.length, 1, 'rebuilt from the address: not counted again');
  vm.runInContext("runSearch('jug',{typed:true})", sb);
  assert.deepEqual(calls[1], ['/api/search-log', 'jug'], 'a header search from another page (/?q=) still counts');
  assert.match(store, /runSearch\(search,\{typed:true\}\)/);
});

/* ---------------- F473 price bands ---------------- */
test('F473: a piece at exactly AED 80 or 200 sits in one price band only', () => {
  const sb = run(fnSrc('matchesFilters'), { state: { q: '', cat: 'all', houseOnly: false, shop: 'all', sale: false, min: 0, max: 9999 }, VENDORS: { s: { name: 'S' } }, _t: (x) => x });
  const inBand = (price, min, max) => { sb.state.min = min; sb.state.max = max; return vm.runInContext(`matchesFilters({price:${price},vendor:'s',cat:'Ceramics',name:'x'})`, sb); };
  assert.equal(inBand(80, 0, 80), false, 'Under AED 80 leaves out 80');
  assert.equal(inBand(79.5, 0, 80), true);
  assert.equal(inBand(80, 80, 200), true);
  assert.equal(inBand(200, 80, 200), false);
  assert.equal(inBand(200, 200, 9999), true);
  assert.equal(inBand(12000, 200, 9999), true, '"200+" has no ceiling');
  assert.equal(inBand(12000, 0, 9999), true, '"Any price" has no ceiling');
});

/* ---------------- F474 makers loop ---------------- */
test('F474: the makers carousel asks for frames only on the homepage with a moving row', () => {
  let asked = 0;
  const sb = run(`${fnSrc('startMakers')}\n${fnSrc('tickMakers')}`, {
    MK: { track: { style: {} }, setW: 900, static: false, raf: 0, lastT: 0, off: 0, vx: 0, speed: 10, dragging: false, hovering: false, resumeAt: 0 },
    state: { view: 'home' }, requestAnimationFrame: () => { asked += 1; return asked; },
  });
  vm.runInContext('startMakers()', sb);
  assert.equal(asked, 1);
  vm.runInContext('startMakers()', sb);
  assert.equal(asked, 1, 'never two loops');
  vm.runInContext('tickMakers(16)', sb);
  assert.equal(asked, 2, 'on the homepage it keeps going');
  sb.state.view = 'checkout';
  vm.runInContext('tickMakers(32)', sb);
  assert.equal(asked, 2, 'off the homepage it stops');
  assert.equal(sb.MK.raf, 0);
  sb.state.view = 'home'; sb.MK.static = true;
  vm.runInContext('startMakers()', sb);
  assert.equal(asked, 2, 'a row that fits never animates');
  assert.match(fnSrc('showView'), /if\(v==='home'\)startMakers\(\);/);
});

/* ---------------- F476 / F389 / F515 shared chrome ---------------- */
test('F476 + F389 + F515: Seller fees opens the fees question; the nav says Makers; menu footer links are 44px', async () => {
  for (const [f, html] of [['trove.html', store], ['trove-services.html', services]]) {
    assert.match(html, /<li><a href="\/faq#what-does-it-cost-to-sell">Seller fees<\/a><\/li><li><a href="\/faq#makers">Seller handbook<\/a><\/li>/, f);
    assert.match(html, /<a href="\/#vendors">Makers<\/a>/, f);
    assert.match(html, /<a class="mn-link" href="\/#vendors">Makers<span>→<\/span><\/a>/, f);
    assert.doesNotMatch(html, />Marketplace</, `${f}: no bare 'Marketplace' link left`);
    assert.match(html, /\.mn-foot a\{display:flex;align-items:center;gap:11px;min-height:44px\}/, f);
  }
  const faq = await get('/faq');
  assert.match(faq.text, /<h3 id="what-does-it-cost-to-sell">/);
  const faqAr = await get('/ar/faq');
  assert.match(faqAr.text, /id="what-does-it-cost-to-sell"/, 'the Arabic Help centre keeps the anchor');
});

/* ---------------- F423 sold out ---------------- */
test('F423: a sold-out piece says so on its card and carries a label, not Add to basket', async () => {
  const html = (await get('/shop')).text.replace(/<script[\s\S]*?<\/script>/g, ' ');
  const card = (name) => {
    const at = html.indexOf(`>${name}</a></h3>`);
    assert.ok(at > -1, `${name} card`);
    return html.slice(html.lastIndexOf('<article class="card">', at), html.indexOf('</article>', at));
  };
  const gone = card('Gone Bowl');
  assert.match(gone, /<span class="sale">Sold out<\/span>/);
  assert.match(gone, /<span class="add add-row disp">Sold out<\/span>/);
  assert.doesNotMatch(gone, /addToCart/);
  assert.match(card('Mug'), /window\.addToCart\?addToCart\(\d+,this\):0/, 'in stock: the button, safe before the script loads (F424)');
  // the page's own card does the same
  const sb = run(`${fnSrc('soldOutP')}`, {});
  assert.equal(vm.runInContext('soldOutP({stock:0})', sb), true);
  assert.equal(vm.runInContext('soldOutP({stock:2})', sb), false);
  assert.equal(vm.runInContext("soldOutP({stock:3,options:[{name:'G',values:['a']}],variants:[{stock:0}]})", sb), true);
  assert.equal(vm.runInContext("soldOutP({stock:3,options:[{name:'G',values:['a']}],variants:[{stock:1}]})", sb), false);
  assert.match(fnSrc('productCard'), /gone\?`<span class="\$\{cls\} disp">\$\{_t\('Sold out'\)\}<\/span>`/);
});

/* ---------------- F424 early taps ---------------- */
test('F424: a tap before the catalogue has loaded is kept and replayed, never an error', () => {
  const toasts = [];
  const sb = run(`let BOOTED=false, EARLY_TAP=null;\n${fnSrc('addToCart')}\n${fnSrc('replayEarlyTap')}\n${fnSrc('pdpEarlyTap')}`, {
    toast: (m) => toasts.push(m), _t: t, PRODUCTS: [], state: { view: 'home' },
  });
  vm.runInContext('addToCart(7,null)', sb);
  assert.deepEqual(toasts, ['Just a moment…']);
  assert.equal(vm.runInContext('EARLY_TAP.id', sb), 7);
  // ready: an unknown piece is said plainly instead of throwing
  vm.runInContext('BOOTED=true;addToCart(99,null)', sb);
  assert.equal(toasts[1], 'This piece is no longer available');
  // replay hands the kept tap to the real add
  const replayed = [];
  vm.runInContext('EARLY_TAP={id:7};', sb);
  sb.PRODUCTS = [{ id: 7 }];
  sb.addToCart = (...a) => replayed.push(a);
  vm.runInContext(`${fnSrc('replayEarlyTap')}\nreplayEarlyTap()`, sb);
  assert.equal(replayed[0][0], 7);
  assert.match(store, /<button class="btn btn-dark" id="pdpAdd" onclick="window\.pdpEarlyTap\?pdpEarlyTap\(\):0">/);
  assert.match(store, /<div class="nojs-note">Trove needs JavaScript/);
  assert.match(store, /\.js \.nojs-note\{display:none\}/);
  assert.match(fnSrc('boot'), /BOOTED=true;[\s\S]*replayEarlyTap\(\);\n\}/);
});

/* ---------------- F426 the 404 page ---------------- */
test('F426: a missing piece or maker gets the 404 page with the site header, search, basket and footer', async () => {
  for (const p of ['/pieces/99999-nope', '/makers/no-such-maker', '/definitely-not-a-page']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
    assert.match(r.text, /<header class="top">/, `${p}: the header`);
    assert.match(r.text, /id="searchInput"/, `${p}: search`);
    assert.match(r.text, /aria-label="Basket"/, `${p}: the basket`);
    assert.match(r.text, /<footer class="site">/, `${p}: the footer`);
    assert.match(r.text, /<script src="\/site-chrome\.js(\?v=[a-f0-9]+)?"><\/script>/, `${p}: the header's handlers`);
    assert.match(r.text, /<main class="card" id="main">/);
    assert.match(r.text, /This page has <em>wandered off<\/em>/);
    assert.doesNotMatch(r.text, /site-chrome:/, 'every marker filled');
    assert.equal((r.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
  }
  const ar = await get('/ar/pieces/99999-nope');
  assert.equal(ar.status, 404);
  assert.match(ar.text, /<html lang="ar" dir="rtl"/);
  assert.match(ar.text, /<header class="top">/);
  // the trimmed addresses
  assert.equal((await get('/makers')).headers.get('location'), '/#vendors');
  assert.equal((await get('/pieces')).headers.get('location'), '/shop');
  assert.equal((await get('/makers')).status, 301);
  // an API miss is still JSON
  const api = await ctx.api('GET', '/api/nothing-here');
  assert.equal(api.status, 404);
  assert.doesNotMatch(api.text, /<html/);
});

/* ---------------- F430 card payments ---------------- */
test('F430: /api/config says whether the server can take a card and may hand the publishable key', async () => {
  let cfg = (await ctx.api('GET', '/api/config')).data;
  assert.equal(cfg.cardPayments, false, 'no Stripe secret here');
  assert.equal(cfg.demoPayments, true, 'away from production a recorded no-charge order is offered');
  assert.equal(cfg.stripePublishableKey, null, 'no key in the environment: the page keeps config.js');
  process.env.STRIPE_MOCK = '1';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_abc123';
  try {
    cfg = (await ctx.api('GET', '/api/config')).data;
    assert.equal(cfg.cardPayments, true);
    assert.equal(cfg.demoPayments, false);
    assert.equal(cfg.stripePublishableKey, 'pk_test_abc123');
    process.env.STRIPE_PUBLISHABLE_KEY = 'sk_live_secret';
    assert.equal((await ctx.api('GET', '/api/config')).data.stripePublishableKey, null, 'never anything but a publishable key');
  } finally { process.env.STRIPE_MOCK = ''; delete process.env.STRIPE_PUBLISHABLE_KEY; }
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.equal((await ctx.api('GET', '/api/config')).data.demoPayments, false, 'never on the live site'); }
  finally { process.env.NODE_ENV = prev; }
  // the page: the card form needs the server's yes; no demo order where the server offers none
  assert.match(store, /const paymentsLive = \(\) => LIVE && TroveAPI\.paymentsEnabled && FEES\.cardPayments!==false;/);
  assert.match(store, /const demoPayments = \(\) => LIVE && !paymentsLive\(\) && FEES\.demoPayments===true;/);
  assert.match(fnSrc('placeOrder'), /if\(!demoPayments\(\)\)\{toast\(_t\('Card payments are paused/);
  assert.match(read('config.js'), /STRIPE_PUBLISHABLE_KEY: "pk_live_/, 'the live key stays as the fallback');
  assert.match(read('api.js'), /window\.TroveAPI\.stripeKey = key;/);
});

/* ---------------- F434 app hand-off ---------------- */
test('F434: an app hand-off link adds pieces to the basket and opens it; it never swaps the basket or opens checkout', () => {
  const calls = [];
  const sb = run(`${constSrc('APP_RET_KEY')}\n${constSrc('APP_RETURN')}\n${constSrc('optLabel')}\n${constSrc('sameLine')}\n${fnSrc('takeAppBasket')}`, {
    location: { search: '?basket=' + encodeURIComponent(JSON.stringify([{ pid: 2, qty: 3 }, { pid: 1, qty: 1 }])) + '&ret=trove://order/', pathname: '/' },
    URLSearchParams, history: { replaceState() {} }, trovePath: (p) => p, sessionStorage: { setItem() {}, removeItem() {} },
    cleanLines: (l) => l.map((c) => ({ pid: c.pid, qty: c.qty, note: '', opts: [], extras: [] })),
    cart: [{ pid: 1, qty: 2, note: '', opts: [], extras: [] }, { pid: 5, qty: 1, note: '', opts: [], extras: [] }],
    updateCartCount() {}, renderCart() {}, openCart: () => calls.push('openCart'), startCheckout: () => calls.push('startCheckout'),
    toast: (m) => calls.push(m), _t: t, _tn: tn,
  });
  assert.equal(vm.runInContext('takeAppBasket()', sb), true);
  const cart = vm.runInContext('cart', sb);
  assert.deepEqual(Array.from(cart, (c) => [c.pid, c.qty]), [[1, 2], [5, 1], [2, 3]], 'kept, merged (larger quantity), added');
  assert.ok(calls.includes('openCart'));
  assert.ok(!calls.includes('startCheckout'), 'never straight into checkout');
  assert.ok(calls.includes('Your pieces from the Trove app were added to your basket'));
});

/* ---------------- F286 Place order lock ---------------- */
test('F286: Place order locks at the first tap; a second tap while the first is working does nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const log = [];
  const sb = run(`let PLACING=false;\n${fnSrc('placeOrder')}`, {
    LIVE: false, IS_LOCAL: true, coNewAddr: true, lastOrder: null,
    ensureGuestAccount: async () => { log.push('account'); await gate; return true; },
    paymentsLive: () => false, demoPayments: () => false, coPlacing: (b) => log.push(b ? 'lock' : 'unlock'),
    $: () => ({ value: 'a@b.co' }), coName: () => 'Amal', showConfirmation: () => log.push('confirmed'), toast() {},
  });
  const first = vm.runInContext('placeOrder()', sb);
  const second = vm.runInContext('placeOrder()', sb);
  await second;
  assert.deepEqual(log, ['lock', 'account'], 'the second tap did nothing');
  release();
  await first;
  assert.deepEqual(log, ['lock', 'account', 'confirmed', 'unlock']);
  // every way out unlocks: an early return too
  log.length = 0;
  sb.ensureGuestAccount = async () => false;
  await vm.runInContext('placeOrder()', sb);
  assert.deepEqual(log, ['lock', 'unlock']);
  assert.match(store, /<button class="co-place" onclick="placeOrder\(\)"><span class="cp-idle">Place order · <span id="coPlaceTot"><\/span><\/span><span class="cp-busy" hidden>Placing your order…<\/span><\/button>/);
});

/* ---------------- F210 charged total ---------------- */
test('F210: when the server will charge a different total from the one on the button, the page catches up first', async () => {
  const moved = [];
  const els = { payStatus: { textContent: '' }, coEmail: { value: 'a@b.co' } };
  const sb = run(`let payIntent=null, stripeJs=null, stripeElements=null, payElement=null, coShownFils=22500;\n${fnSrc('doMountPayment')}`, {
    $: (id) => els[id], _t: t, loadStripeJs: async () => {}, intentPayload: () => ({}), window: { Stripe: () => ({ elements: () => ({ create: () => ({ mount() {}, unmount() {} }) }) }) },
    TroveAPI: { stripeKey: 'pk_test_x', api: async () => ({ orderId: 'TRV-1', clientSecret: 'pi_1_secret_x', amount: 23000 }) },
    pricesMoved: async (c) => { moved.push(c); return true; },
  });
  await vm.runInContext('doMountPayment()', sb);
  assert.deepEqual(moved, [23000], 'the different figure is caught');
  vm.runInContext('payIntent=null; coShownFils=23000;', sb);
  await vm.runInContext('doMountPayment()', sb);
  assert.deepEqual(moved, [23000], 'the same figure goes straight through');
  assert.match(fnSrc('renderCoSummary'), /coShownFils=Math\.round\(fb\.total\*100\);/);
  assert.match(fnSrc('pricesMoved'), /await fetchCatalog\(\);/);
  assert.match(fnSrc('pricesMoved'), /Prices were updated — please check your total before you pay\./);
});

/* ---------------- F217 redirect-type payments ---------------- */
test('F217: a payment that leaves the site comes back to the order page and finishes there', async () => {
  assert.match(fnSrc('placeOrder'), /return_url:location\.origin\+troveUrl\('\/order\/'\+encodeURIComponent\(id\)\+'\/thanks'\)/);
  assert.match(fnSrc('placeOrder'), /saveReceiptKey\(id,payIntent\.receiptKey\);[\s\S]*sessionStorage\.setItem\(PENDING_KEY[\s\S]*confirmPayment/, 'kept before paying');
  const mk = (status, pending = { orderId: 'TRV-AB12', amountCents: 9450, email: 'a@b.co', name: 'Amal' }) => {
    const log = [];
    const store_ = new Map(pending ? [['trove.pendingOrder', JSON.stringify(pending)]] : []);
    const sb = run(`let stripeJs=null, ROUTING=false, lastOrder=null;\n${constSrc('PENDING_KEY')}\n${fnSrc('takeStripeReturn')}`, {
      location: { search: '?payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_z&redirect_status=' + (status === 'succeeded' ? 'succeeded' : 'failed'), pathname: '/order/TRV-AB12/thanks' },
      URLSearchParams, trovePath: (p) => p, history: { replaceState: (s, x, u) => log.push('url:' + u) },
      loadStripeJs: async () => {}, window: { Stripe: () => ({ retrievePaymentIntent: async () => ({ paymentIntent: { status } }) }) }, TroveAPI: { stripeKey: 'pk' },
      sessionStorage: { getItem: (k) => store_.get(k) || null, removeItem: (k) => store_.delete(k) },
      cart: [{ pid: 1, qty: 1 }], showConfirmation: (id) => log.push('confirm:' + id), showOrderPage: (id) => log.push('page:' + id),
      go: (v) => log.push('go:' + v), openCart: () => log.push('cart'), toast: (m) => log.push('toast:' + m), _t: t,
    });
    return { sb, log, store_ };
  };
  const ok = mk('succeeded');
  assert.equal(await vm.runInContext('takeStripeReturn()', ok.sb), true);
  assert.deepEqual(ok.log.slice(0, 2), ['url:/order/TRV-AB12/thanks', 'confirm:TRV-AB12'], 'the secret leaves the address first; then the confirmation');
  assert.equal(ok.store_.size, 0, 'the pending note is gone');
  const processing = mk('processing');
  await vm.runInContext('takeStripeReturn()', processing.sb);
  assert.ok(processing.log.includes('confirm:TRV-AB12'));
  const failed = mk('requires_payment_method');
  await vm.runInContext('takeStripeReturn()', failed.sb);
  assert.ok(failed.log.includes('go:home') && failed.log.includes('cart'), 'not paid: back to the basket');
  assert.ok(failed.log.some((l) => /didn’t go through, so nothing was charged/.test(l)));
  const otherDevice = mk('succeeded', null);
  await vm.runInContext('takeStripeReturn()', otherDevice.sb);
  assert.ok(otherDevice.log.includes('page:TRV-AB12'), 'no note on this device: the order page asks the server');
  // an ordinary visit to the order page is left to the router
  const plain = mk('succeeded');
  plain.sb.location.search = '';
  assert.equal(await vm.runInContext('takeStripeReturn()', plain.sb), false);
  assert.match(fnSrc('boot'), /if\(await takeStripeReturn\(\)\)/);
});

/* ---------------- F288 address form ---------------- */
test('F288: the new-address form has autofill names and is built once, then shown or hidden', () => {
  const rc = fnSrc('renderCheckout');
  assert.match(rc, /if\(!\$\('coNewLine'\)\)\$\('coAddrForm'\)\.innerHTML=/);
  assert.match(rc, /\$\('coAddrForm'\)\.hidden=!coNewAddr;/);
  for (const ac of ['shipping name', 'shipping street-address', 'shipping address-level2', 'shipping address-level1']) assert.ok(rc.includes(`autocomplete="${ac}"`), ac);
  assert.match(fnSrc('coName'), /checkoutPayload\(\)\.address/, 'the delivery name comes from the address in use, not a hidden field');
});

/* ---------------- F356 long shelves ---------------- */
test('F356: the shop draws 48 pieces, then Show more pieces adds the next batch', () => {
  assert.match(store, /const SHOP_PAGE=48;/);
  assert.match(fnSrc('renderShop'), /list\.slice\(0,shopShown\)\.map\(productCard\)/);
  assert.match(fnSrc('renderShop'), /shopShown=SHOP_PAGE;/, 'every filter starts from the first batch');
  assert.match(fnSrc('showMorePieces'), /insertAdjacentHTML\('beforeend'/);
  assert.match(store, /<div class="shop-more" id="shopMore" hidden><span class="sm-n" id="shopMoreN"><\/span><button type="button" class="btn btn-ghost" onclick="showMorePieces\(\)">Show more pieces<\/button><\/div>/);
  const els = { shopMore: { hidden: true }, shopMoreN: { textContent: '' } };
  const sb = run(`let shopShown=48;\n${fnSrc('shopMore')}`, { $: (id) => els[id], _t: t });
  vm.runInContext('shopMore(120)', sb);
  assert.equal(els.shopMore.hidden, false);
  assert.equal(els.shopMoreN.textContent, 'Showing 48 of 120 pieces');
  vm.runInContext('shopMore(30)', sb);
  assert.equal(els.shopMore.hidden, true);
});

/* ---------------- F357 lighter catalogue ---------------- */
test('F357: /api/products?view=list leaves out the full description; the plain feed is unchanged for the app', async () => {
  const full = (await ctx.api('GET', '/api/products')).data.products.find((p) => p.id === mugId);
  assert.ok(full.description.length > 300, 'the app still gets the whole description');
  assert.ok('estimate' in full);
  assert.equal(full.stockImage, undefined, 'the interim stock photos are gone');
  const lite = (await ctx.api('GET', '/api/products?view=list')).data.products.find((p) => p.id === mugId);
  assert.equal(lite.description, undefined);
  assert.equal(lite.estimate, undefined);
  assert.ok(lite.summary.length <= 240 && lite.summary.endsWith('…'), 'a short summary, cut at a word');
  assert.ok(full.description.startsWith(lite.summary.slice(0, -1)));
  for (const k of ['id', 'name', 'price', 'category', 'tags', 'options', 'variants', 'extras', 'stock', 'leadDays', 'shop', 'images', 'thumbs']) assert.ok(k in lite, k);
  const short = (await ctx.api('GET', '/api/products?view=list')).data.products.find((p) => p.id === soldId);
  assert.equal(short.summary, 'Short words.', 'a short description is its own summary');
  // the page asks for the list and fetches the full text with the piece
  assert.match(fnSrc('fetchCatalog'), /TroveAPI\.api\('\/api\/products\?view=list'\)/);
  assert.match(fnSrc('pdpDescription'), /TroveAPI\.api\('\/api\/products\/'\+p\.id\)/);
  assert.equal((await ctx.api('GET', `/api/products/${mugId}`)).data.product.description, full.description);
});

/* ---------------- F507 no health gate ---------------- */
test('F507: the catalogue is fetched straight away, without a health check first', () => {
  assert.doesNotMatch(fnSrc('fetchCatalog'), /health\(\)/);
});

/* ---------------- F359 fonts ---------------- */
test('F359: the brand fonts are served from /fonts, preloaded, with no Google Fonts stylesheet in the way', async () => {
  assert.doesNotMatch(store, /fonts\.googleapis\.com/);
  for (const f of ['cormorant-latin', 'cormorant-latin-ext', 'quicksand-latin', 'quicksand-latin-ext']) {
    const buf = fs.readFileSync(path.join(DOCS, 'fonts', `${f}.woff2`));
    assert.equal(buf.slice(0, 4).toString('latin1'), 'wOF2', `${f} is a woff2 file`);
    assert.ok(store.includes(`src:url(/fonts/${f}.woff2) format('woff2')`), `${f} has its @font-face`);
  }
  assert.match(store, /<link rel="preload" href="\/fonts\/quicksand-latin\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.match(store, /font-family:'Cormorant';font-style:normal;font-weight:400 600;/, 'upright only');
  const r = await ctx.api('GET', '/fonts/quicksand-latin.woff2');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') || '', /max-age=\d{5,}/, 'cached long');
});

/* ---------------- F369 hero pause ---------------- */
test('F369: the hero slideshow has a pause button, and keyboard focus inside it holds it still', () => {
  let timers = 0;
  const btn = { classList: { on: false, toggle(c, v) { this.on = v; } }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const sb = run(`${fnSrc('hcPlay')}\n${fnSrc('hcStop')}\n${fnSrc('hcSettle')}\n${fnSrc('hcHold')}\n${fnSrc('hcUserPause')}`, {
    HC: { n: 4, timer: 0, dur: 4600, paused: false, held: false, stopped: false }, REDUCED: false,
    setInterval: () => { timers += 1; return timers; }, clearInterval() {}, document: { hidden: false }, state: { view: 'home' },
    $: (id) => (id === 'hsPlay' ? btn : { classList: { toggle() {} } }), hcDots() {}, hcStep() {}, _t: t,
  });
  vm.runInContext('hcPlay()', sb);
  assert.equal(timers, 1, 'plays');
  vm.runInContext('hcUserPause()', sb);
  assert.equal(sb.HC.stopped, true);
  assert.equal(btn.attrs['aria-label'], 'Play the slideshow');
  vm.runInContext('hcPlay()', sb);
  assert.equal(timers, 1, 'stays stopped until play is pressed');
  vm.runInContext('hcUserPause()', sb);
  assert.equal(timers, 2, 'plays again');
  vm.runInContext('hcHold(true)', sb);
  vm.runInContext('hcPlay()', sb);
  assert.equal(timers, 2, 'keyboard focus holds it');
  assert.match(store, /<button class="hs-btn hs-pp" id="hsPlay" aria-label="Pause the slideshow" onclick="hcUserPause\(\)">/);
  assert.match(store, /\.hs-btn\.hs-pp\{display:grid;/, 'on phones too');
  assert.match(fnSrc('hcBind'), /stage\.addEventListener\('focusin'/);
});

/* ---------------- F388 sign in from checkout ---------------- */
test('F388: a returning buyer can sign in from checkout, and the duplicate-account message links there', async () => {
  assert.match(store, /<p class="co-signin" id="coSignIn" hidden data-i18n>Already have an account\? <a href="\/login\?next=%2F%3Fcart%3D1">Sign in<\/a> and come straight back to your basket\.<\/p>/);
  assert.match(fnSrc('prepCheckout'), /\$\('coSignIn'\)\.hidden=!guest;/);
  const err = { textContent: '', innerHTML: '', style: {} };
  const els = { coAcctBox: { style: { display: 'block' } }, coAcctChk: { checked: true }, coEmail: { value: 'back@test.local' }, coAcctPw: { value: 'longenough1' }, coAcctErr: err };
  const sb = run(`${constSrc('SIGN_IN_BACK')}\n${fnSrc('coAcctError')}\n${fnSrc('ensureGuestAccount')}`, {
    ME: null, LIVE: true, $: (id) => els[id], _t: t, esc: (s) => s, troveUrl: (u) => u, coName: () => 'Back',
    TroveAPI: { api: async () => { const e = new Error('dup'); e.status = 409; throw e; } },
  });
  assert.equal(await vm.runInContext('ensureGuestAccount()', sb), false);
  assert.match(err.innerHTML, /<a href="\/login\?next=%2F%3Fcart%3D1">sign in<\/a>/);
  assert.equal(err.style.display, 'block');
});

/* ---------------- F390 hint words ---------------- */
test('F390: the no-results hint words are the fullest real shelves, never fixed words', () => {
  assert.doesNotMatch(store, /“linen”, “brass”/);
  const sb = run(fnSrc('hintCategories'), { PRODUCTS: [{ cat: 'Ceramics' }, { cat: 'Ceramics' }, { cat: 'Stationery' }, { cat: 'Jewellery' }, { cat: 'Jewellery' }, { cat: 'Jewellery' }] });
  assert.deepEqual([...vm.runInContext('hintCategories(2)', sb)], ['Jewellery', 'Ceramics']);
  assert.equal(run(fnSrc('hintCategories'), { PRODUCTS: [] }).hintCategories(3).length, 0);
});

/* ---------------- F394 / F510 toasts ---------------- */
test('F394 + F510: the added-to-basket toast carries View basket; with the basket open a toast sits at the top', () => {
  assert.match(fnSrc('addToCart'), /toast\(_t\('\{piece\} added to your basket',\{piece:p\.name\}\),4500,\{label:_t\('View basket'\),fn:openCart\}\)/);
  const el = (id) => ({ id, hidden: true, textContent: '', onclick: null, classList: { set: new Set(), add(...c) { c.forEach((x) => this.set.add(x)); }, remove(...c) { c.forEach((x) => this.set.delete(x)); }, toggle(c, v) { if (v) this.set.add(c); else this.set.delete(c); } } });
  const els = { toast: el('toast'), toastAct: el('toastAct'), toastMsg: el('toastMsg') };
  const sb = run(`let toastT;\n${fnSrc('toast')}\n${fnSrc('hideToast')}`, { $: (id) => els[id], setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext('toast("Mug added to your basket",4500,{label:"View basket",fn:()=>{opened++}})', Object.assign(sb, { opened: 0 }));
  assert.equal(els.toastAct.hidden, false);
  assert.equal(els.toastAct.textContent, 'View basket');
  assert.ok(els.toast.classList.set.has('has-act'));
  vm.runInContext('$("toastAct").onclick()', sb);
  assert.equal(sb.opened, 1, 'the action ran');
  assert.equal(els.toastAct.hidden, true, 'tapping it closes the toast');
  vm.runInContext('toast("Plain")', sb);
  assert.equal(els.toastAct.hidden, true, 'a plain toast has no button');
  assert.match(store, /\.toast\.show\.has-act\{pointer-events:auto\}/);
  assert.match(store, /\.drawer\.open~\.toast\{top:calc\(20px \+ env\(safe-area-inset-top\)\);bottom:auto\}/);
  assert.match(fnSrc('openCart'), /hideToast\(\)/);
});

/* ---------------- F395 / F513 the empty Collection shelf ---------------- */
test('F395 + F513: an empty shelf hides its count and sort; on the Collection shelf the filter shows it is on', () => {
  assert.match(store, /\.sortbar\.empty \.n,\.sortbar\.empty select\{display:none\}/);
  assert.match(store, /\.browse-layout:has\(#shopGrid>\.noresult:first-child\) \.sortbar \.n/, 'the server-drawn first paint too');
  assert.match(fnSrc('renderShop'), /\.sortbar'\)\.classList\.toggle\('empty',!list\.length\)/);
  const els = { fltHouse: { checked: false, disabled: false }, fltShop: { value: '' }, fltSale: { checked: false } };
  const sb = run(fnSrc('syncFilterUI'), { $: (id) => els[id], state: { cat: 'House', houseOnly: false, shop: 'all', sale: false, min: 0, max: 9999 }, document: { querySelectorAll: () => [] } });
  vm.runInContext('syncFilterUI()', sb);
  assert.deepEqual([els.fltHouse.checked, els.fltHouse.disabled], [true, true]);
  sb.state.cat = 'all';
  vm.runInContext('syncFilterUI()', sb);
  assert.deepEqual([els.fltHouse.checked, els.fltHouse.disabled], [false, false]);
});

/* ---------------- F523 / F524 basket ---------------- */
test('F523 + F524: a dropped basket line is named; the empty basket offers somewhere to go', () => {
  const toasts = [];
  const sb = run(fnSrc('droppedLineToast'), {
    PRODUCTS: [{ id: 3, name: 'Reeded Mug' }], optVal: (p, n, v) => v, openPDP() {},
    toast: (m, ms, act) => toasts.push([m, act && act.label]), _t: t, _tn: tn,
  });
  vm.runInContext("droppedLineToast({pid:3,opts:[{name:'Glaze',value:'Ash grey'}]})", sb);
  assert.deepEqual(toasts[0], ['“Reeded Mug (Ash grey)” is no longer available as you chose it', 'Choose again']);
  vm.runInContext("droppedLineToast({pid:9,opts:[],n:'Old Vase'})", sb);
  assert.deepEqual(toasts[1], ['“Old Vase” is no longer available', undefined], 'gone from the catalogue: named from the basket line');
  vm.runInContext("droppedLineToast({pid:9,opts:[]})", sb);
  assert.equal(toasts[2][0], 'One piece from your basket is no longer available');
  assert.match(fnSrc('addToCart'), /cart\.push\(\{pid:id,qty:1,note,opts,extras,n:p\.name\}\)/);
  const rc = fnSrc('renderCart');
  assert.match(rc, /<a class="btn btn-dark" href="\/shop">\$\{_t\('Shop all'\)\}<\/a><a class="btn btn-ghost" href="\/shop\/trove-collection">\$\{_t\('Trove Collection'\)\}<\/a>/);
  assert.doesNotMatch(rc, /<div class="ci"><div class="n">\$\{esc\(p\.name\)\}<\/div><div class="v">\$\{esc\(V\.name\)\}<\/div>/, 'no maker name under every line (F510)');
});

/* ---------------- F510 delivery step ---------------- */
test('F510: one delivery line when every parcel arrives in the same window', () => {
  const rc = fnSrc('renderCheckout');
  assert.match(rc, /const oneWindow=shopIds\.length>1&&shopIds\.every\(v=>coEst\.perShop\[v\]\.label===coEst\.est\.label\);/);
  assert.match(rc, /_tn\(shopIds\.length,'\{n\} parcel, tracked together','\{n\} parcels, tracked together'\)/);
  assert.match(rc, /<details class="co-dl-shops"><summary>\$\{_t\('See each shop'\)\}<\/summary>/);
});

/* ---------------- F512 returns line ---------------- */
test('F512: a personalised piece shows its own returns line', () => {
  assert.match(store, /<span id="pdpReturnLine">15-day returns, collection free if a piece is faulty<\/span>/);
  assert.match(fnSrc('openPDP'), /\$\('pdpReturnLine'\)\.textContent=p\.perso\?_t\('Made for you: returns only if it arrives faulty, damaged or wrong'\):_t\('15-day returns, collection free if a piece is faulty'\);/);
});

/* ---------------- F477 leftovers ---------------- */
test('F477: no unused helper; demo cards only on a developer\'s own machine', () => {
  assert.doesNotMatch(store, /const jsq=/);
  assert.match(fnSrc('renderCheckout'), /\$\('coPaySaved'\)\.innerHTML=!IS_LOCAL\?'':DEMO_CARDS\.map\(/);
});

/* ---------------- F287 cookie banner ---------------- */
test('F287: the basket, menu, filter sheet, buy bar and toast sit above the cookie banner while it shows', () => {
  for (const re of [
    /\.drawer\{position:fixed;top:0;right:0;bottom:var\(--cmp-h,0px\);/,
    /\.mnav\{position:fixed;top:0;left:0;bottom:var\(--cmp-h,0px\);/,
    /\.filters\{position:fixed;left:0;right:0;bottom:var\(--cmp-h,0px\);[^}]*max-height:min\(80vh,calc\(100vh - var\(--cmp-h,0px\) - 24px\)\);/,
    /\.pdp-bar\{display:flex;position:fixed;left:0;right:0;bottom:var\(--cmp-h,0px\);/,
    /\.toast\{position:fixed;bottom:calc\(24px \+ env\(safe-area-inset-bottom\) \+ var\(--cmp-h,0px\)\);/,
  ]) assert.match(store, re);
  assert.match(store, /\(function watchCookieBanner\(\)\{/);
  assert.match(store, /document\.getElementById\('troveCmp'\)/);
  assert.match(store, /root\.style\.setProperty\('--cmp-h',h\+'px'\);/);
});
