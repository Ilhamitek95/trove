'use strict';
/**
 * Response hardening: security headers on pages and API, the canonical-host
 * redirect (env-driven, never for the health check, webhooks or localhost),
 * and an error handler that never shows internals on a 5xx.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const http = require('http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

/** Raw request so the Host header can be set (fetch won't). */
function raw(method, path, host, body) {
  const { port } = new URL(ctx.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('every page and API response carries the security headers', async () => {
  for (const path of ['/', '/admin', '/api/health', '/api/config']) {
    const r = await ctx.api('GET', path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
  }
  assert.equal((await ctx.api('GET', '/')).headers.get('strict-transport-security'), null, 'no HSTS outside production');
});

test('the CSP still allows everything checkout, sign-in and the pages load', async () => {
  const csp = (await ctx.api('GET', '/')).headers.get('content-security-policy');
  const dir = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '');
  assert.match(dir('script-src'), /'unsafe-inline'/, 'inline scripts and onclick handlers');
  assert.match(dir('script-src'), /https:\/\/js\.stripe\.com/);
  assert.match(dir('script-src'), /https:\/\/accounts\.google\.com/);
  assert.match(dir('style-src'), /'unsafe-inline'/);
  assert.match(dir('style-src'), /https:\/\/fonts\.googleapis\.com/);
  assert.match(dir('font-src'), /https:\/\/fonts\.gstatic\.com/);
  assert.match(dir('img-src'), /data:/);
  assert.match(dir('img-src'), /blob:/);
  assert.match(dir('img-src'), /https:/, 'Unsplash stock and Google avatars');
  assert.match(dir('connect-src'), /https:\/\/api\.stripe\.com/);
  assert.match(dir('connect-src'), /https:\/\/accounts\.google\.com/);
  for (const f of ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://*.stripe.network', 'https://accounts.google.com']) {
    assert.ok(dir('frame-src').includes(f), `frame-src ${f}`);
  }
  assert.doesNotMatch(csp, /unsafe-eval/);

  // Every external script/stylesheet the pages reference is covered.
  const fs = require('fs');
  const path = require('path');
  const docs = path.join(__dirname, '..', '..', 'docs');
  const hosts = new Set();
  for (const f of fs.readdirSync(docs).filter((n) => /\.(html|js)$/.test(n))) {
    const text = fs.readFileSync(path.join(docs, f), 'utf8');
    for (const m of text.matchAll(/<script[^>]+src=["'](https:\/\/[^/"']+)/g)) hosts.add(m[1]);
    for (const m of text.matchAll(/\.src\s*=\s*['"](https:\/\/[^/"']+)/g)) hosts.add(m[1]);
  }
  for (const h of hosts) assert.ok(dir('script-src').includes(h), `script host ${h} allowed`);
});

test('HSTS is sent in production', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.CANONICAL_HOST = 'off';
  try {
    const r = await ctx.api('GET', '/api/health');
    assert.match(r.headers.get('strict-transport-security') || '', /max-age=\d+/);
  } finally { process.env.NODE_ENV = prev; delete process.env.CANONICAL_HOST; }
});

test('any other host 301s to the canonical address, keeping path and query', async () => {
  process.env.CANONICAL_HOST = 'troveathome.com';
  try {
    let r = await raw('GET', '/services?audience=home', 'trove-vu4z.onrender.com');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, 'https://troveathome.com/services?audience=home');
    r = await raw('HEAD', '/', 'trove-vu4z.onrender.com');
    assert.equal(r.status, 301);
    // Never: the health check, webhooks (POST), the canonical host, localhost.
    r = await raw('GET', '/api/health', 'trove-vu4z.onrender.com');
    assert.equal(r.status, 200);
    r = await raw('POST', '/api/delivery/webhook', 'trove-vu4z.onrender.com', JSON.stringify({ ref: 'nope', event: 'x' }));
    assert.notEqual(r.status, 301);
    r = await raw('GET', '/api/config', 'troveathome.com');
    assert.equal(r.status, 200);
    r = await raw('GET', '/api/config', 'localhost:4242');
    assert.equal(r.status, 200);
  } finally { delete process.env.CANONICAL_HOST; }
  // Unset outside production: nothing is redirected (local dev, tests).
  const r = await raw('GET', '/api/config', 'trove-vu4z.onrender.com');
  assert.equal(r.status, 200);
});

test('a 5xx answers generically; a deliberate 4xx keeps its message', async () => {
  // An unknown Origin makes the CORS layer throw a plain Error → 500.
  const res = await fetch(ctx.baseUrl + '/api/config', { headers: { origin: 'https://evil.example' } });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.match(body.error, /Something went wrong on our side/);
  assert.doesNotMatch(body.error, /evil|Origin/);

  const bad = await ctx.api('POST', '/api/auth/login', { raw: '{not json' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error && !/Something went wrong on our side/.test(bad.data.error));
});
