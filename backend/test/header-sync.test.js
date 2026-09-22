'use strict';
/**
 * Header sync: the site header is one thing everywhere. The storefront
 * (docs/trove.html) owns it, and every other public page that carries the
 * header must be a copy: the same promo bar, the same links in the same
 * order, the same icon buttons, the same account menu and the same mobile
 * menu. Only the addresses may differ (the storefront's links are in-page
 * views, the other pages link into it), plus a "you are here" class.
 *
 * The Services Marketplace shipped with its own hand-built header and the
 * menu changed on every click between the two pages. This is the check
 * that keeps that from coming back.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { testEnv } = require('./helpers');
testEnv({});

const { DEFAULTS } = require('../src/content');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const store = read('trove.html');

// Pages that carry the storefront header (add a page here when it gets one).
const PAGES = ['trove-services.html'];

const block = (html, re, what, file) => {
  const m = html.match(re);
  assert.ok(m, `${file}: ${what} not found`);
  return m[0];
};
const PROMO = /<div class="promo">[\s\S]*?<\/div><\/div>/;
const HEADER = /<header class="top">[\s\S]*?<\/header>/;
const MNAV = /<aside class="mnav"[\s\S]*?<\/aside>/;

// Everything but the addresses: hrefs and inline handlers go, so do the
// "you are here" marker and whitespace differences.
const skeleton = (s) => s
  .replace(/\s(href|onclick|onkeydown)="[^"]*"/g, '')
  .replace(/ class="on"/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// Link texts, with inline handlers stripped first (an arrow function's `>` would otherwise end the tag early).
const labels = (s) => [...s.replace(/\s(onclick|onkeydown)="[^"]*"/g, '').matchAll(/<a\b[^>]*>([^<]+)</g)].map((m) => m[1].trim());

for (const file of PAGES) {
  const html = read(file);

  test(`${file}: promo bar, header and mobile menu match the storefront's`, () => {
    for (const [re, what] of [[PROMO, 'promo bar'], [HEADER, 'header'], [MNAV, 'mobile menu']]) {
      assert.equal(skeleton(block(html, re, what, file)), skeleton(block(store, re, what, 'trove.html')), `${file}: ${what} differs from the storefront`);
    }
  });

  test(`${file}: the same five links, in the same order, on desktop and in the mobile menu`, () => {
    const desktop = labels(block(html, /<nav class="links">[\s\S]*?<\/nav>/, 'desktop links', file));
    const mobile = labels(block(html, MNAV, 'mobile menu', file)).filter((l) => !/^(My account|Orders|Saved items)$/.test(l));
    const expected = ['Shop all', 'Trove Collection', 'Marketplace', 'Services Marketplace', 'Sell on Trove'];
    assert.deepEqual(desktop, expected);
    assert.deepEqual(mobile.map((l) => l.replace(/→$/, '').trim()), expected);
    assert.deepEqual(labels(block(store, /<nav class="links">[\s\S]*?<\/nav>/, 'desktop links', 'trove.html')), expected);
  });

  test(`${file}: every menu link is a real address, none calls the storefront's in-page router`, () => {
    const desktop = [...block(html, /<nav class="links">[\s\S]*?<\/nav>/, 'desktop links', file).matchAll(/<a\b[^>]*>/g)];
    const mobile = [...block(html, MNAV, 'mobile menu', file).matchAll(/<a\b[^>]*class="mn-link"[^>]*>/g)];
    assert.equal(desktop.length, 5);
    assert.equal(mobile.length, 5);
    for (const [tag] of [...desktop, ...mobile]) {
      const href = (tag.match(/href="([^"]*)"/) || [])[1];
      assert.ok(href && href !== '#', `${file}: a menu link has no real address: ${tag}`);
      assert.ok(!/go\(/.test(tag), `${file}: a menu link still calls the storefront's in-page router: ${tag}`);
    }
  });

  test(`${file}: the "you are here" marker sits on this page's own link only`, () => {
    const header = block(html, HEADER, 'header', file);
    const on = [...header.matchAll(/<a href="([^"]*)" class="on">/g)].map((m) => m[1]);
    assert.deepEqual(on, ['/services']);
  });

  test(`${file}: the promo bar carries the CMS default and is wired to it`, () => {
    const promo = block(html, PROMO, 'promo bar', file);
    assert.match(promo, /data-cms="site\.promo\.text"/);
    assert.ok(promo.includes(DEFAULTS['site.promo'].text.replace(/&/g, '&amp;')));
  });
}

test('the storefront answers the addresses the shared header uses', () => {
  // The other pages' header links land on these; the boot code must route them.
  for (const needle of ["q.get('view')", "q.get('q')", "q.get('cat')", "q.get('cart')", "location.hash==='#vendors'", "view==='shop'", "view==='sell'"]) {
    assert.ok(store.includes(needle), `trove.html boot no longer handles ${needle}`);
  }
  assert.match(store, /id="vendors"/);
  assert.match(store, /id="view-sell"/);
  assert.match(store, /id="view-shop"/);
});
