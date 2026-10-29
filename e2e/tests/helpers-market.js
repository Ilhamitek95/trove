'use strict';
/**
 * Marketplace helpers for specs 01–03 (onboarding, shopping, orders).
 *
 *  - newActor(): a second/third browser "person" (buyer, maker, admin) with
 *    the same guard rails as the fixture page: config.js served blank (demo
 *    payments), outside hosts blocked, dialogs accepted, page JS errors
 *    collected and asserted on close(). Routing is on, so the browser HTTP
 *    cache is off — a reload always sees the server's current catalogue.
 *  - api(): an isolated API session (own cookie jar) for setup shortcuts and
 *    for checking server-side state the UI doesn't show.
 *  - makeMaker()/approve()/addProduct()/payoutSetup()/buyNow(): setup
 *    shortcuts used when a journey needs a shop or an order to exist but isn't
 *    ABOUT creating it (spec 01 drives those parts through the real UI).
 */
const { request } = require('@playwright/test');
const { expect, ACCOUNTS, uid, pngFile } = require('./fixtures');

const baseURLOf = (testInfo) => testInfo.project.use.baseURL;

async function newActor(browser, testInfo, { account, viewport } = {}) {
  const context = await browser.newContext({
    baseURL: baseURLOf(testInfo),
    viewport: viewport || { width: 1280, height: 860 },
    locale: 'en-GB',
    timezoneId: 'Asia/Dubai',
    acceptDownloads: true,
  });
  await context.route('**/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.TROVE_CONFIG = { API_URL: "", STRIPE_PUBLISHABLE_KEY: "" };',
  }));
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  const actor = { context, page, errors, promptAnswer: null };
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (actor.promptAnswer ?? (d.defaultValue() || 'ok')) : undefined).catch(() => {}));
  if (account) {
    const res = await page.request.post('/api/auth/login', { data: { email: account.email, password: account.password } });
    expect(res.status(), `login ${account.email}: ${await res.text()}`).toBe(200);
  }
  actor.close = async () => {
    await context.close();
    expect(errors, `uncaught JavaScript errors (${account ? account.email : 'guest'})`).toEqual([]);
  };
  return actor;
}

/** An API session with its own cookie jar. call() never throws on HTTP errors. */
async function api(testInfo, account) {
  const ctx = await request.newContext({ baseURL: baseURLOf(testInfo) });
  const call = async (method, url, data) => {
    const res = await ctx.fetch(url, { method, data });
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status(), data: body, headers: res.headers() };
  };
  if (account) {
    const r = await call('POST', '/api/auth/login', { email: account.email, password: account.password });
    expect(r.status, `api login ${account.email}: ${JSON.stringify(r.data)}`).toBe(200);
  }
  return { ctx, call, dispose: () => ctx.dispose() };
}

const pngDataUrl = () => 'data:image/png;base64,' + pngFile().buffer.toString('base64');

/** A maker application straight through the API (spec 01 covers the /apply UI). */
async function makeMaker(testInfo, { shopName, location = 'Dubai, UAE', licenseNumber = '' } = {}) {
  const tag = uid();
  const account = { email: `maker-${tag}@e2e.test`, password: 'maker-pass-123' };
  const s = await api(testInfo);
  const reg = await s.call('POST', '/api/auth/register', {
    role: 'seller', name: `Maker ${tag}`, email: account.email, password: account.password,
    shopName: shopName || `Atelier ${tag}`, location, about: 'Small-batch pieces made by hand for the e2e journeys.',
    category: 'Ceramics', plannedProducts: 'Cups and bowls', instagram: `@atelier${tag}`, phone: '+971 50 111 2233',
    licenseNumber,
  });
  expect(reg.status, JSON.stringify(reg.data)).toBe(201);
  const me = await s.call('GET', '/api/seller/me');
  return { ...account, name: `Maker ${tag}`, shop: me.data.shop, session: s, tag };
}

async function setShopStatus(testInfo, shopId, status) {
  const admin = await api(testInfo, ACCOUNTS.admin);
  const r = await admin.call('PATCH', `/api/admin/shops/${shopId}`, { status });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  await admin.dispose();
}

async function addProduct(maker, body) {
  const r = await maker.session.call('POST', '/api/seller/products', { status: 'live', category: 'Ceramics', stock: 10, ...body });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.product;
}

/** Payout setup with Emirates ID photos + home address (consignment sellers without a licence). */
async function payoutSetup(maker, overrides = {}) {
  const r = await maker.session.call('POST', '/api/seller/payout-setup', {
    emiratesIdLast4: '4821', emiratesIdExpiry: '2031-06-30', accountName: maker.name, bankName: 'Emirates NBD',
    iban: 'AE070331234567890123456', acceptAgreement: true, eidFront: pngDataUrl(), eidBack: pngDataUrl(),
    address: 'Villa 12, Street 4, Al Barsha, Dubai', ...overrides,
  });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.shop;
}

async function makeBuyer(testInfo, { name } = {}) {
  const tag = uid();
  const account = { email: `buyer-${tag}@e2e.test`, password: 'buyer-pass-123' };
  const s = await api(testInfo);
  const r = await s.call('POST', '/api/auth/register', { role: 'buyer', name: name || `Buyer ${tag}`, email: account.email, password: account.password });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return { ...account, name: name || `Buyer ${tag}`, session: s, tag };
}

const DUBAI = { name: 'Test Buyer', line: 'Apt 801, Marina Heights', city: 'Dubai Marina, Dubai', emirate: 'Dubai', country: 'United Arab Emirates' };

/** Checkout + demo payment through the API as the given session. Returns the public order id. */
async function buyNow(session, items, { address = DUBAI, phone = '050 123 4567', email } = {}) {
  const r = await session.call('POST', '/api/checkout', { items, address, phone, email });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  const done = await session.call('POST', '/api/checkout/demo-complete', { orderId: r.data.orderId });
  expect(done.status, JSON.stringify(done.data)).toBe(200);
  return r.data.orderId;
}

/** The seller-side shipment for one order (the maker's own session). */
async function shipmentFor(maker, publicId) {
  const r = await maker.session.call('GET', '/api/seller/orders');
  expect(r.status).toBe(200);
  const sh = r.data.orders.find((o) => o.order && o.order.publicId === publicId);
  expect(sh, `shipment for ${publicId}`).toBeTruthy();
  return sh;
}

/** YYYY-MM-DD, `days` from today (UTC, matching SQLite's date('now')). */
const isoDay = (days = 0) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** /sell, waiting for boot to finish (it ends on go('overview'), which would
 *  otherwise yank the page back if a tab were clicked mid-boot). */
async function gotoSell(page) {
  await page.goto('/sell');
  await expect(page.locator('#pageSub')).not.toHaveText('Welcome back');
  await expect(page.locator('#pageTitle')).toHaveText('Overview');
}

/** /account (optionally a section), waiting for boot to render that section. */
async function gotoAccount(page, section, email) {
  // A unique query forces a real load: goto() to the SAME url + #hash is only
  // a same-document hash change and would leave stale data on screen.
  await page.goto(`/account?v=${Date.now()}#${section}`);
  const titles = { orders: 'Your orders', addresses: 'Addresses' };
  await expect(page.locator('#uEmail')).toHaveText(email);
  await expect(page.locator('#pageTitle')).toHaveText(titles[section]);
}

/** The storefront, waiting until the live catalogue has rendered. */
async function gotoStore(page, path = '/') {
  await page.goto(path);
  await expect(page.locator('#trendingGrid .card').first()).toBeAttached();
}

/** Open a /sell view from the sidebar and wait for its title. */
async function sellerTab(page, view, title) {
  await page.locator(`.side .mitem[data-v="${view}"]`).click();
  await expect(page.locator('#pageTitle')).toHaveText(title);
}

/** Open an /admin view from the sidebar. */
async function adminTab(page, view, title) {
  await page.locator(`.side .mitem[data-v="${view}"]`).click();
  await expect(page.locator('#pageTitle')).toHaveText(title);
}

module.exports = {
  newActor, api, makeMaker, setShopStatus, addProduct, payoutSetup, makeBuyer, buyNow, shipmentFor,
  pngDataUrl, isoDay, sellerTab, adminTab, gotoSell, gotoAccount, gotoStore, DUBAI, baseURLOf,
};
