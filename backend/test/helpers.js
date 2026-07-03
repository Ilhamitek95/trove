'use strict';
/**
 * Test bootstrap. node --test runs each test file in its own process, so
 * calling testEnv() at the very top of a file — BEFORE the first require of
 * anything under src/ — gives that file a private temp database and the
 * in-process Stripe mock. db.js caches its connection on first require.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

function testEnv(extra = {}) {
  process.env.NODE_ENV = 'test';
  process.env.STRIPE_MOCK = '1';
  process.env.CRON_DISABLED = '1';
  process.env.SESSION_SECRET = 'test-secret';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-test-'));
  process.env.DB_PATH = path.join(dir, 'trove.db');
  process.env.UPLOADS_DIR = path.join(dir, 'uploads');
  process.env.PRIVATE_DIR = path.join(dir, 'private');
  Object.assign(process.env, extra);
}

/** Boot the app on an ephemeral port. Returns { baseUrl, db, stripeMock, close, api, loginAs, postWebhook }. */
async function startApp() {
  const { createApp } = require('../src/app');
  const db = require('../src/db');
  const stripeMock = require('../src/stripe-mock');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function api(method, pathname, { body, cookie, raw } = {}) {
    const res = await fetch(baseUrl + pathname, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
      redirect: 'manual',
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text, headers: res.headers };
  }

  /** Log in and return the session cookie string to pass as { cookie }. */
  async function loginAs(email, password) {
    const res = await api('POST', '/api/auth/login', { body: { email, password } });
    if (res.status !== 200) throw new Error(`loginAs(${email}) failed: ${res.status} ${res.text}`);
    const setCookie = res.headers.get('set-cookie') || '';
    return setCookie.split(';')[0];
  }

  /** POST a fake Stripe event (the mock's constructEvent just parses JSON). */
  const postWebhook = (event) => api('POST', '/api/stripe/webhook', { raw: JSON.stringify(event) });

  const close = () => new Promise((resolve) => server.close(resolve));
  return { baseUrl, db, stripeMock, app, close, api, loginAs, postWebhook };
}

module.exports = { testEnv, startApp };
