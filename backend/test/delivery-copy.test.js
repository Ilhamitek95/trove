'use strict';
/**
 * Copy and legal for per-piece delivery times (owner, 2026-09-30): the site
 * no longer promises 3–6 days for everything — most pieces still arrive in
 * 3–6 days, made-to-order pieces show their own time — stored CMS overrides
 * are rewritten (migration 021), and the Buyer Terms moved to v2 for exactly
 * the delivery clause. The seller agreement states no pack time, so it stays.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
let ctx, db;
before(async () => { ctx = await startApp(); db = ctx.db; });
after(async () => { await ctx.close(); });

test('site copy no longer promises 3–6 days for everything', async () => {
  const content = require('../src/content');
  const marquee = JSON.stringify(content.DEFAULTS ? content.DEFAULTS['home.marquee'] : fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8'));
  assert.doesNotMatch(marquee, /3–6 day delivery/);
  assert.match(marquee, /Delivery time shown/);
  const store = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8');
  assert.doesNotMatch(store, />3–6 day delivery</);
  assert.doesNotMatch(store, /<b>3–6 days<\/b><span>to the buyer's door/, 'the sell band figure is honest too');
  for (const p of ['/returns', '/about', '/faq']) {
    const res = await ctx.api('GET', p, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(res.text, /Delivery usually takes|Delivery takes \*?\*?3–6|Usually 3–6 days/, `${p} makes no blanket promise`);
  }
  const ret = (await ctx.api('GET', '/returns', { headers: { accept: 'text/html' } })).text;
  assert.match(ret, /Delivery time is shown on every piece/);
  assert.match(ret, /Most pieces arrive in 3–6 days/);
  const llms = (await ctx.api('GET', '/llms.txt')).text;
  assert.match(llms, /Delivery time is shown on every piece/);
  assert.doesNotMatch(llms, /Usually 3–6 days/);
  // Stored CMS overrides with the old marquee are rewritten (migration 021).
  db.prepare("INSERT OR REPLACE INTO site_content (section, value) VALUES ('home.marquee', ?)")
    .run(JSON.stringify({ items: [{ head: 'Handpicked', sub: 'x' }, { head: '3–6 day delivery', sub: 'Dubai & Abu Dhabi' }] }));
  require('../src/migrations/021-delivery-time-copy').up(db);
  const v = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='home.marquee'").get().value);
  assert.deepEqual(v.items[1], { head: 'Delivery time shown', sub: 'On every piece, most 3–6 days' });
  assert.equal(v.items[0].head, 'Handpicked', 'anything else is left alone');
  // The buyer terms moved to v2 for exactly this clause; the seller agreement states no pack time.
  const legal = (await ctx.api('GET', '/api/legal/terms')).data;
  assert.equal(legal.version, 'v2');
  assert.match(legal.markdown, /the time its maker states they need to make\s+or finish and pack it, plus \*\*1–4 days\*\* with our courier/);
  assert.doesNotMatch(legal.markdown, /Delivery usually takes \*\*3–6 days\*\*/);
  const sellerAgreement = fs.readFileSync(path.join(__dirname, '..', 'legal', 'seller-agreement-v4.md'), 'utf8');
  assert.doesNotMatch(sellerAgreement, /\b\d+\s*(?:working\s+)?(?:days?|hours?)\b[^.]*\bpack/i, 'no fixed pack time to contradict');
  assert.equal(require('../src/config').AGREEMENT_VERSION, 'v4');
});
