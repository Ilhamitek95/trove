'use strict';
/**
 * The guided dashboard tour (docs/tour.js, 2026-10-27): both dashboards load
 * it, it starts only from ?tour=1 while the owner checks it, and every button
 * name it puts in bold is still a real button in that dashboard.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const tourBlock = (html) => html.slice(html.indexOf('function startTour(){'), html.indexOf('],{onEnd:'));
const bold = (src) => [...src.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);

test('tour.js parses and exposes TroveTour without needing anything else on the page', () => {
  const vm = require('node:vm');
  const src = read('tour.js');
  const sandbox = { window: {}, document: {} };
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.window.TroveTour.start, 'function');
  assert.equal(typeof sandbox.window.TroveTour.end, 'function');
  assert.equal(sandbox.window.TroveTour.active, false);
});

for (const [file, url, sources] of [
  ['trove-seller.html', '/sell', ['trove-seller.html', 'provider-panel.js']],
  ['trove-provider.html', '/provider', ['provider-panel.js', 'trove-provider.html']],
]) {
  test(`${file}: loads the tour, starts it only from ?tour=1, and names real buttons`, () => {
    const html = read(file);
    assert.ok(html.includes('<script src="/tour.js"></script>'), 'tour script');
    assert.ok(html.includes("get('tour')==='1'"), 'started from ?tour=1');
    assert.ok(html.includes(`history.replaceState(null,'',troveUrl('${url}'))`), 'tidies the address');
    const calls = html.match(/(?<!function )startTour\(\)/g) || [];
    assert.equal(calls.length, 1, 'no other way to start it yet (the owner is checking it first)');
    const block = tourBlock(html);
    const labels = bold(block);
    assert.ok(labels.length >= 3, 'bold button names in the steps');
    const dash = sources.map(read).join('\n').replace(tourBlock(html), '');
    for (const l of labels) assert.ok(dash.includes(l), `${file}: "${l}" is a button in the dashboard`);
  });
}
