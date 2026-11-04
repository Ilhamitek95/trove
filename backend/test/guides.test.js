'use strict';
/** /guides (4 Nov 2026): English-only articles with their own addresses, structured data and sitemap entries. */
const { testEnv, startApp } = require('./helpers');
testEnv({ RATE_LIMIT_DISABLED: '1' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { GUIDES } = require('../src/pages/guides');
const { copyViolation } = require('../src/copy-rules');

let ctx, api;
before(async () => { ctx = await startApp(); api = ctx.api; });
after(async () => { await ctx.close(); });

test('every guide has a unique slug, a date, and copy that passes the guardrails', () => {
  const slugs = new Set();
  for (const g of GUIDES) {
    assert.match(g.slug, /^[a-z0-9-]+$/);
    assert.ok(!slugs.has(g.slug)); slugs.add(g.slug);
    assert.match(g.updated, /^\d{4}-\d{2}-\d{2}$/);
    const text = g.md(require('../src/pages/facts').facts());
    assert.equal(copyViolation(`${g.title} ${g.description} ${g.intro} ${text}`), null, g.slug);
    assert.ok(text.split(/\s+/).length > 400, `${g.slug} is thin`);
    assert.ok(g.description.length >= 80 && g.description.length <= 200, `${g.slug} description length`);
  }
});

test('the index and each guide render with title, description, canonical, Article JSON-LD and no Arabic twin', async () => {
  const idx = await api('GET', '/guides');
  assert.equal(idx.status, 200);
  assert.match(idx.data, /<title>Guides · Trove<\/title>/);
  assert.match(idx.data, /<link rel="canonical" href="[^"]*\/guides">/);
  assert.doesNotMatch(idx.data, /<link rel="alternate" hreflang="ar"/);
  for (const g of GUIDES) {
    assert.ok(idx.data.includes(`href="/guides/${g.slug}"`), `${g.slug} listed`);
    const r = await api('GET', `/guides/${g.slug}`);
    assert.equal(r.status, 200, g.slug);
    assert.ok(r.data.includes(`<title>${g.title.replace(/&/g, '&amp;')} · Trove</title>`), `${g.slug} title`);
    assert.match(r.data, /"@type":"Article"/);
    assert.match(r.data, /"@type":"BreadcrumbList"/);
    assert.equal((r.data.match(/<h1[\s>]/g) || []).length, 1, `${g.slug} one h1`);
    assert.doesNotMatch(r.data, /<link rel="alternate" hreflang="ar"/);
  }
  // /ar/guides is not a page; an unknown guide is a real 404.
  assert.equal((await api('GET', '/ar/guides')).status, 404);
  assert.equal((await api('GET', '/guides/not-a-guide')).status, 404);
});

test('guides are in the sitemap, llms.txt and the footer', async () => {
  const sm = (await api('GET', '/sitemap.xml')).data;
  assert.ok(sm.includes('<loc>') && sm.includes('/guides</loc>'));
  for (const g of GUIDES) assert.ok(sm.includes(`/guides/${g.slug}</loc>`), g.slug);
  assert.doesNotMatch(sm, /\/ar\/guides/);
  const llms = (await api('GET', '/llms.txt')).data;
  for (const g of GUIDES) assert.ok(llms.includes(`/guides/${g.slug}`), g.slug);
  const home = (await api('GET', '/')).data;
  assert.ok(home.includes('<a href="/guides">Guides</a>'));
});
