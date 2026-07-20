'use strict';
/**
 * CMS wiring — static checks that keep the three copies of the site content
 * in lock-step:
 *
 *   1. every editable leaf in content.js DEFAULTS is wired to the storefront
 *      via a data-cms / data-cms-rich attribute (or is a JS-rendered list),
 *   2. the demo copy baked into docs/trove.html matches DEFAULTS exactly
 *      (demo mode renders the HTML as-is, so drift = two different sites),
 *   3. every section has an editor card in trove-admin.html's CMS_SPEC,
 *   4. no data-cms attribute points at a path that doesn't exist.
 *
 * The "CMS edits saved but never showed" bug shipped because nothing checked
 * the wiring end-to-end — this file is that check for everything static.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { testEnv } = require('./helpers');
testEnv({});

const { DEFAULTS, SECTIONS } = require('../src/content');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const storeHtml = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(DOCS, 'trove-admin.html'), 'utf8');

// Lists the storefront re-renders from JS (flexible length — no static wiring).
const JS_RENDERED = new Set(['sell.hero.facts', 'sell.steps.items', 'sell.faq.items']);

const entities = (s) => s.replace(/&/g, '&amp;');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const richHtml = (s) => entities(s).replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\|/g, '<br>');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function plainText(p) {
  const m = storeHtml.match(new RegExp(`data-cms="${reEsc(p)}"[^>]*>([^<]*)<`));
  return m ? norm(m[1]) : null;
}
function richText(p) {
  const m = storeHtml.match(new RegExp(`<(\\w+)\\b[^>]*data-cms-rich="${reEsc(p)}"[^>]*>([\\s\\S]*?)</\\1>`));
  return m ? norm(m[2].replace(/<em[^>]*>/g, '<em>')) : null;
}

// Walk DEFAULTS into [path, defaultString] pairs of statically-wired leaves,
// plus the strings of JS-rendered lists (checked for demo-copy presence only).
const wired = [];
const jsListStrings = [];
for (const section of SECTIONS) {
  for (const [key, dv] of Object.entries(DEFAULTS[section])) {
    if (key === 'productIds') continue; // picker-driven, no default copy
    if (Array.isArray(dv)) {
      if (JS_RENDERED.has(`${section}.${key}`)) {
        for (const item of dv) {
          if (typeof item === 'string') jsListStrings.push(item);
          else jsListStrings.push(...Object.values(item));
        }
      } else {
        dv.forEach((item, i) => {
          for (const [f, v] of Object.entries(item)) wired.push([`${section}.${key}.${i}.${f}`, v]);
        });
      }
    } else {
      wired.push([`${section}.${key}`, dv]);
    }
  }
}

test('every editable default is wired into the storefront and matches the demo copy', () => {
  for (const [p, dv] of wired) {
    const plain = plainText(p);
    const got = plain ?? richText(p);
    assert.ok(got !== null, `"${p}" has no data-cms/data-cms-rich element in trove.html`);
    const want = plain !== null ? entities(dv) : richHtml(dv);
    assert.equal(got, norm(want), `demo copy for "${p}" drifted from content.js DEFAULTS`);
  }
});

test('JS-rendered list defaults (facts, steps, FAQ) exist in the demo copy', () => {
  for (const s of jsListStrings) {
    assert.ok(storeHtml.includes(entities(s)), `demo copy is missing this default string: "${s.slice(0, 60)}…"`);
  }
});

test('every content section has an editor card in the admin CMS_SPEC', () => {
  for (const section of SECTIONS) {
    assert.ok(adminHtml.includes(`key:'${section}'`), `"${section}" is missing from CMS_SPEC in trove-admin.html`);
  }
});

test('no data-cms attribute points at a path that does not exist', () => {
  const attrs = [...storeHtml.matchAll(/data-cms(?:-rich)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(attrs.length >= wired.length, 'expected the storefront to carry the wired attributes');
  for (const p of attrs) {
    const parts = p.split('.');
    const section = parts.slice(0, 2).join('.');
    let v = DEFAULTS[section];
    for (const k of parts.slice(2)) v = v == null ? undefined : v[k];
    assert.equal(typeof v, 'string', `data-cms="${p}" resolves to nothing in content.js DEFAULTS`);
  }
});

test('the storefront loads content without gating on the LIVE flag (regression)', () => {
  // The launch bug: loadContent() checked LIVE before fetching, but it runs
  // concurrently with the code that SETS LIVE — so it always bailed and admin
  // edits never showed. Applied content must not be gated on LIVE.
  const fn = storeHtml.match(/async function loadContent\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'loadContent() found in trove.html');
  assert.ok(!/if\s*\(\s*!\s*LIVE\s*\)/.test(fn[0]), 'loadContent() must not check LIVE — that races with loadCatalog()');
});
