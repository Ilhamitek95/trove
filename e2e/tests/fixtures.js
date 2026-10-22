'use strict';
/**
 * Shared fixtures for every journey.
 *
 *  - config.js is served with a blank Stripe publishable key, so the storefront
 *    runs its demo-payments checkout (orders are placed for real, no card form).
 *    The card step itself is covered by the backend suite (webhook.test.js).
 *  - Outside hosts (fonts, stock photos, Stripe.js, Google sign-in) are blocked:
 *    the journeys only ever talk to the local server.
 *  - confirm()/prompt() dialogs are accepted, so buttons that ask "are you sure?"
 *    carry on the way a person clicking OK would.
 *  - Any uncaught JavaScript error on a page fails the test that caused it.
 */
const base = require('@playwright/test');
const { expect } = base;

const ACCOUNTS = {
  admin: { email: 'admin@e2e.test', password: 'e2e-admin-pass' },   // bootstrapped by start-server.js
  buyer: { email: 'layla@email.com', password: 'demo1234' },        // seeded demo buyer
  seller: { email: 'mara@kilnandclay.com', password: 'demo1234' },  // seeded Kiln & Clay (+ services)
};

const test = base.test.extend({
  context: async ({ context }, use) => {
    await context.route('**/config.js', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.TROVE_CONFIG = { API_URL: "", STRIPE_PUBLISHABLE_KEY: "" };',
    }));
    await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
    await use(context);
  },
  page: async ({ page }, use, testInfo) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (d.defaultValue() || 'ok') : undefined).catch(() => {}));
    await use(page);
    if (errors.length) {
      await testInfo.attach('page-errors', { body: errors.join('\n'), contentType: 'text/plain' });
      expect(errors, 'uncaught JavaScript errors on the page').toEqual([]);
    }
  },
});

/** Short unique suffix so parallel journeys never collide on emails, shop names or slugs. */
const uid = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);

/** Sign in through the API; the session cookie lands in the page's browser context. */
async function apiLogin(page, { email, password }) {
  const res = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(200);
  return res.json();
}

async function apiLogout(page) {
  await page.request.post('/api/auth/logout');
}

/** JSON call through the page's context (shares its cookies). Returns { status, data }. */
async function call(page, method, url, data) {
  const res = await page.request.fetch(url, { method, data });
  let body = null;
  try { body = await res.json(); } catch (_) { body = await res.text(); }
  return { status: res.status(), data: body };
}

/** A real 64×64 PNG (flat clay colour) for photo, licence and Emirates ID uploads. */
function pngFile(name = 'photo.png') {
  const zlib = require('zlib');
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set([0xdb, 0xc7, 0xbd], y * (w * 3 + 1) + 1 + x * 3);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return { name, mimeType: 'image/png', buffer };
}

/** The mock courier's hand-crank: confirm delivery of a shipment as if the courier had. */
async function mockDeliver(page, body) {
  return call(page, 'POST', '/api/delivery/mock/deliver', body);
}

module.exports = { test, expect, ACCOUNTS, uid, apiLogin, apiLogout, call, pngFile, mockDeliver };
