'use strict';
/**
 * The anonymous booking endpoint emails and notifies a provider, so it is
 * limited per address: 10 requests an hour. The limiter sits in front of the
 * route in app.js, so it counts every request, valid or not.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx;
before(async () => { ctx = await startApp(); });
after(async () => { await ctx.close(); });

async function book(ip) {
  const res = await fetch(`${ctx.baseUrl}/api/services/999999/book`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{}',
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

test('anonymous booking requests: 10 an hour per address', async () => {
  const ip = '192.0.2.44';
  for (let i = 0; i < 10; i++) {
    const r = await book(ip);
    assert.notEqual(r.status, 429, `request ${i + 1}`);
    assert.equal(r.headers.get('ratelimit-limit'), '10');
  }
  const over = await book(ip);
  assert.equal(over.status, 429);
  assert.match(over.data.error, /Too many booking requests/);
  assert.ok(Number(over.headers.get('retry-after')) > 3000, 'the window is an hour');
  assert.notEqual((await book('192.0.2.45')).status, 429, 'another address is unaffected');
});
