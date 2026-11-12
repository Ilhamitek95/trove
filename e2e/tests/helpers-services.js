'use strict';
/**
 * Shared helpers for specs 04–07 (services, admin/CMS, accounts/security, phone).
 *
 *  - `actor(account?)` fixture: a SECOND (third, …) browser, each in its own
 *    context with its own cookies and HTTP cache, set up exactly like the
 *    harness `page` (config.js → demo-payments, outside hosts blocked, dialogs
 *    accepted, uncaught page errors fail the test). Multi-person journeys
 *    (customer + provider + admin) use one actor per person, so no one ever
 *    sees another person's session or a cached copy of their pages.
 *  - `apiAs(account?)` fixture: a bare API session for setup shortcuts.
 *  - makeProvider / makeSeller: fresh applicants built through the public API.
 */
const base = require('./fixtures');
const { expect, uid, ACCOUNTS } = base;

const CONTEXT_KEYS = ['viewport', 'userAgent', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'locale', 'timezoneId', 'baseURL'];

async function prepareContext(context) {
  await context.route('**/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.TROVE_CONFIG = { API_URL: "", STRIPE_PUBLISHABLE_KEY: "" };',
  }));
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
}

/** JSON call on an APIRequestContext (or page.request). Returns { status, data, text }. */
async function j(ctx, method, url, data) {
  const res = await ctx.fetch(url, { method, data });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  return { status: res.status(), data: body, text };
}

const test = base.test.extend({
  actor: async ({ browser }, use, testInfo) => {
    const made = [];
    const opts = {};
    for (const k of CONTEXT_KEYS) if (testInfo.project.use[k] !== undefined) opts[k] = testInfo.project.use[k];
    await use(async (account) => {
      const context = await browser.newContext(opts);
      await prepareContext(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (d.defaultValue() || 'ok') : undefined).catch(() => {}));
      made.push({ context, errors });
      if (account) {
        const r = await page.request.post('/api/auth/login', { data: { email: account.email, password: account.password } });
        expect(r.status(), `login ${account.email}`).toBe(200);
      }
      return page;
    });
    const errs = made.flatMap((m) => m.errors);
    for (const m of made) await m.context.close().catch(() => {});
    if (errs.length) {
      await testInfo.attach('actor-page-errors', { body: errs.join('\n'), contentType: 'text/plain' });
      expect(errs, 'uncaught JavaScript errors on an actor page').toEqual([]);
    }
  },
  // Worker-scoped so beforeAll hooks can build their fixtures through it too.
  apiAs: [async ({ playwright }, use, workerInfo) => {
    const made = [];
    const baseURL = workerInfo.project.use.baseURL;
    await use(async (account) => {
      const ctx = await playwright.request.newContext({ baseURL });
      made.push(ctx);
      if (account) {
        const r = await ctx.post('/api/auth/login', { data: { email: account.email, password: account.password } });
        expect(r.status(), `login ${account.email}`).toBe(200);
      }
      return ctx;
    });
    for (const c of made) await c.dispose().catch(() => {});
  }, { scope: 'worker' }],
});

/** Open a signed-in dashboard and wait until its boot has finished (the boot
 *  ends by switching to its first view, so clicking earlier can be undone). */
async function openDashboard(page, path) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

/**
 * A brand-new service provider, applied through POST /api/services/apply
 * (exactly what /apply sends), optionally approved by the admin and given
 * listings. Returns { email, password, name, providerName, slug, id, services[] }.
 */
async function makeProvider(apiAs, { approve = true, services = [], categories = ['workshops'], location = 'Dubai, UAE' } = {}) {
  const id = uid();
  const p = {
    email: `prov-${id}@e2e.test`, password: 'provider-pass-1',
    name: `Rana ${id}`, providerName: `E2E Studio ${id}`,
  };
  const api = await apiAs();
  const r = await j(api, 'POST', '/api/services/apply', {
    name: p.name, email: p.email, password: p.password, providerName: p.providerName,
    categories, location, about: 'Hand-building workshops at your place, for groups of up to eight people.',
    experience: '3+ years', instagram: '@e2e' + id, links: '', phone: '+971 50 111 2233',
    plannedServices: 'Workshops', agreeSub: true, agreeTerms: true,
  });
  expect(r.status, r.text).toBe(201);
  const me = await j(api, 'GET', '/api/auth/me');
  p.slug = me.data.provider.slug;
  p.id = me.data.provider.id;
  p.userId = me.data.user.id;
  p.services = [];
  for (const s of services) {
    const sv = await j(api, 'POST', '/api/provider/services', {
      category: categories[0], priceType: 'fixed', setting: 'home', description: 'All materials included.', duration: '2 hours', ...s,
    });
    expect(sv.status, sv.text).toBe(201);
    p.services.push(sv.data.service);
  }
  if (approve) {
    const admin = await apiAs(ACCOUNTS.admin);
    const a = await j(admin, 'PATCH', `/api/admin/providers/${p.id}`, { status: 'approved' });
    expect(a.status, a.text).toBe(200);
  }
  return p;
}

/**
 * A brand-new maker shop, applied through POST /api/auth/register (what the
 * Pieces door of /apply sends), optionally approved. Returns
 * { email, password, name, shopName, slug, shopId }.
 */
async function makeSeller(apiAs, { approve = true } = {}) {
  const id = uid();
  const s = { email: `maker-${id}@e2e.test`, password: 'maker-pass-12', name: `Salma ${id}`, shopName: `E2E Pottery ${id}` };
  const api = await apiAs();
  const r = await j(api, 'POST', '/api/auth/register', {
    role: 'seller', name: s.name, email: s.email, password: s.password, shopName: s.shopName,
    category: 'Ceramics', location: 'Dubai, UAE', about: 'Hand-built stoneware from a small studio in Al Quoz.',
    experience: '3+ years', maker: 'I make everything myself', plannedProducts: 'Mugs, bowls',
    channels: 'Instagram / WhatsApp', capacity: '10–30', instagram: '@e2epottery' + id, links: '', phone: '+971 50 222 3344',
  });
  expect(r.status, r.text).toBe(201);
  const me = await j(api, 'GET', '/api/auth/me');
  s.slug = me.data.shop.slug;
  s.shopId = me.data.shop.id;
  if (approve) {
    const admin = await apiAs(ACCOUNTS.admin);
    const a = await j(admin, 'PATCH', `/api/admin/shops/${s.shopId}`, { status: 'approved' });
    expect(a.status, a.text).toBe(200);
  }
  return s;
}

/** A plain buyer account (optionally with a sign-in mobile). */
async function makeBuyer(apiAs, { mobile } = {}) {
  const id = uid();
  const b = { email: `buyer-${id}@e2e.test`, password: 'buyer-pass-123', name: `Huda ${id}` };
  const api = await apiAs();
  const r = await j(api, 'POST', '/api/auth/register', { email: b.email, password: b.password, name: b.name, ...(mobile ? { mobile } : {}) });
  expect(r.status, r.text).toBe(201);
  b.id = r.data.user.id;
  return b;
}

/** A random, well-formed UAE mobile in local spelling (05X XXX XXXX). */
function randomMobile() {
  const d = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  return `05${d[0]} ${d.slice(1, 4)} ${d.slice(4)}`;
}
/** The canonical +9715… form the server stores. */
const canonicalMobile = (m) => '+971' + m.replace(/\D/g, '').replace(/^0/, '');

/** The page has no horizontal overflow (nothing wider than the viewport). */
async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - window.innerWidth;
    let culprit = null;
    if (over > 0) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 && r.width > 0 && getComputedStyle(el).visibility !== 'hidden') {
          culprit = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').split(' ').join('.')} right=${Math.round(r.right)}`;
          break;
        }
      }
    }
    return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, over, culprit };
  });
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UAE_PHONE_RE = /(\+971|\b971|\b05\d)[\s-]?\d/;

module.exports = {
  test, expect, j, prepareContext, makeProvider, makeSeller, makeBuyer, openDashboard,
  randomMobile, canonicalMobile, horizontalOverflow, EMAIL_RE, UAE_PHONE_RE,
};
