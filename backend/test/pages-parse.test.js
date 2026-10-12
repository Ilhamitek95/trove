'use strict';
/**
 * Every page's own JavaScript still parses (F373). The pages in docs/ carry
 * hundreds of KB of inline script: a stray bracket or an unclosed template
 * literal blanks the whole storefront, seller dashboard or admin panel, and
 * nothing else in the suite would notice before it went live. This compiles
 * (never runs) every inline <script> block of every docs/*.html — JSON-LD
 * and other data blocks excepted — and every docs/*.js file.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const JS_TYPES = /^(text\/javascript|application\/javascript|module)?$/i;

/** [{ code, line }] — the inline script blocks a browser would run. */
function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
    if (!JS_TYPES.test(type)) continue; // application/ld+json and other data blocks
    out.push({ code: m[2], line: html.slice(0, m.index).split('\n').length, module: /^module$/i.test(type) });
  }
  return out;
}

/** Compile as a classic browser script; throws a SyntaxError naming the line. */
function compiles(code, filename, lineOffset = 0) {
  new vm.Script(code, { filename, lineOffset });
}

const pages = fs.readdirSync(DOCS).filter((f) => f.endsWith('.html'));
const scripts = fs.readdirSync(DOCS).filter((f) => f.endsWith('.js'));

test('there are pages and scripts to check', () => {
  assert.ok(pages.includes('trove.html') && pages.includes('trove-seller.html') && pages.includes('trove-admin.html'));
  assert.ok(scripts.includes('api.js'));
});

for (const file of pages) {
  test(`${file}: every inline script parses`, () => {
    const html = fs.readFileSync(path.join(DOCS, file), 'utf8');
    for (const s of inlineScripts(html)) {
      if (s.module) continue; // none today; vm.Script cannot compile module syntax
      assert.doesNotThrow(() => compiles(s.code, `docs/${file}`, s.line - 1), (e) => `${file} (script starting line ${s.line}): ${e && e.message}`);
    }
  });
}

for (const file of scripts) {
  test(`${file} parses`, () => {
    const code = fs.readFileSync(path.join(DOCS, file), 'utf8');
    assert.doesNotThrow(() => compiles(code, `docs/${file}`));
  });
}

test('a broken script is caught (the check itself works)', () => {
  assert.throws(() => compiles('function f(){ return `unclosed ${1} ', 'x.js'), SyntaxError);
  const found = inlineScripts('<script type="application/ld+json">{"a":1}</script><script>var ok=1;</script><script src="/x.js"></script>');
  assert.equal(found.length, 1);
});
