'use strict';
/**
 * The interface dictionaries (docs/i18n/<lang>/<bundle>.json, keyed by the
 * English text):
 *   - every bundle exists in both languages with exactly the same keys;
 *   - every Arabic entry is filled in, keeps the {placeholders} of its
 *     English source and contains no italics markup;
 *   - every string the pages wrap in _t()/_tn() — and the server wraps in
 *     i18n.t()/i18n.tn() — is in the dictionaries the page loads, so no
 *     English is left behind on an Arabic page.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const I18N = path.join(ROOT, 'docs', 'i18n');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const bundles = (lang) => fs.readdirSync(path.join(I18N, lang)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const load = (lang, name) => read(path.join(I18N, lang, `${name}.json`));
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const forms = (v) => (v && typeof v === 'object' ? Object.values(v) : [v]);

test('every bundle exists in English and Arabic with the same keys', () => {
  assert.deepEqual(bundles('en'), bundles('ar'));
  assert.ok(bundles('ar').includes('common'));
  for (const b of bundles('ar')) {
    const en = load('en', b);
    const ar = load('ar', b);
    const missingAr = Object.keys(en).filter((k) => !(k in ar));
    const missingEn = Object.keys(ar).filter((k) => !(k in en));
    assert.deepEqual(missingAr, [], `${b}: keys in en/ but not in ar/`);
    assert.deepEqual(missingEn, [], `${b}: keys in ar/ but not in en/ (run node scripts/i18n-sync.js)`);
  }
});

test('every Arabic entry is filled in and keeps its placeholders', () => {
  const PLURAL = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
  for (const b of bundles('ar')) {
    const en = load('en', b);
    const ar = load('ar', b);
    for (const [k, v] of Object.entries(ar)) {
      if (v && typeof v === 'object') {
        assert.ok(v.other, `${b}: plural "${k}" has no 'other' form`);
        for (const f of Object.keys(v)) assert.ok(PLURAL.has(f), `${b}: plural "${k}" has an unknown form '${f}'`);
        assert.ok(en[k] && typeof en[k] === 'object' && en[k].one && en[k].other, `${b}: plural "${k}" needs { one, other } in English`);
        const want = holes(en[k].other).filter((h) => h !== 'n');
        for (const form of forms(v)) for (const h of want) assert.ok(holes(form).includes(h), `${b}: "${k}" Arabic form "${form}" lost {${h}}`);
        continue;
      }
      assert.equal(typeof v, 'string', `${b}: "${k}" must be text`);
      assert.ok(v.trim(), `${b}: "${k}" has no Arabic`);
      assert.deepEqual(holes(v), holes(k), `${b}: "${k}" → "${v}" changes the {placeholders}`);
      assert.doesNotMatch(v, /<\/?(i|cite)\b|font-style:\s*italic/i, `${b}: "${k}" uses italics`);
    }
  }
});

/* ---- coverage: every wrapped literal is in the page's dictionaries ---- */
const unq = (s) => s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
const LIT = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\x60((?:[^\x60\\$]|\\.)*)\x60`;
function literals(src, fn) {
  const out = [];
  const one = new RegExp(String.raw`(?<![\w.$])${fn}\(\s*(?:${LIT})`, 'g');
  for (const m of src.matchAll(one)) out.push(unq(m[1] ?? m[2] ?? m[3]));
  return out;
}
function pluralLiterals(src, fn) {
  const out = [];
  const re = new RegExp(String.raw`(?<![\w.$])${fn}\([^,()]*(?:\([^()]*\))?[^,()]*,\s*(?:${LIT})\s*,\s*(?:${LIT})`, 'g');
  for (const m of src.matchAll(re)) out.push(unq(m[4] ?? m[5] ?? m[6]));
  return out;
}
const pageBundles = (html) => ((html.match(/<meta name="trove-i18n" content="([^"]*)"/) || [])[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const dictFor = (names) => Object.assign({}, ...['common', ...names].map((n) => (bundles('ar').includes(n) ? load('ar', n) : {})));

const DOCS = path.join(ROOT, 'docs');
const PAGES = fs.readdirSync(DOCS).filter((f) => f.endsWith('.html') && !['trove-admin.html', 'index.html'].includes(f));
// Shared scripts and the bundles they read from.
const SCRIPTS = { 'api.js': ['common'], 'site-chrome.js': ['common'], 'provider-panel.js': ['provider'] };

for (const file of PAGES) {
  test(`${file}: every _t()/_tn() string is in its dictionaries`, () => {
    const html = fs.readFileSync(path.join(DOCS, file), 'utf8');
    const d = dictFor(pageBundles(html));
    const keys = [...literals(html, '_t'), ...pluralLiterals(html, '_tn')];
    const missing = [...new Set(keys.filter((k) => !(k in d)))];
    assert.deepEqual(missing, [], `${file}: strings missing from ${['common', ...pageBundles(html)].join(', ')}`);
  });
}
for (const [file, names] of Object.entries(SCRIPTS)) {
  test(`${file}: every _t()/_tn() string is in its dictionaries`, () => {
    const src = fs.readFileSync(path.join(DOCS, file), 'utf8');
    const d = dictFor(names);
    const keys = [...literals(src, '_t'), ...pluralLiterals(src, '_tn')];
    const missing = [...new Set(keys.filter((k) => !(k in d)))];
    assert.deepEqual(missing, [], `${file}: strings missing from ${['common', ...names].join(', ')}`);
  });
}

test('server code: every i18n.t()/i18n.tn() string is in the server-side dictionaries', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p); } };
  walk(SRC);
  const d = Object.assign({}, ...bundles('ar').map((b) => load('ar', b)));
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // i18n.t(lang, 'key' …), and the T('key' …) shorthand a module binds to a language
    const keys = [
      ...literals(src.replace(/i18n\.t\(\s*[\w.]+\s*,/g, 'i18n_t('), 'i18n_t'),
      ...literals(src, 'T'),
      ...pluralLiterals(src.replace(/i18n\.tn\(\s*[\w.]+\s*,/g, 'i18n_tn('), 'i18n_tn'),
      ...pluralLiterals(src, 'TN'),
    ];
    for (const k of keys) if (!(k in d) && !/^\s*$/.test(k)) missing.push(`${path.basename(f)}: ${k}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});
