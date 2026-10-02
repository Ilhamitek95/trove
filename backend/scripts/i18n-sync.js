#!/usr/bin/env node
'use strict';
/**
 * Keep docs/i18n/en/<bundle>.json in step with docs/i18n/ar/<bundle>.json.
 *
 * The dictionaries are keyed by the English text itself, so the English
 * bundle is the list of source strings: every key maps to itself, except
 * plural entries, which hold { one, other } (write those by hand in the
 * English file — this script keeps them and refuses to invent a 'one').
 *
 *   node scripts/i18n-sync.js          rewrite en/ from ar/ (sorted keys)
 *   node scripts/i18n-sync.js --check  exit 1 if anything is out of step
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'docs', 'i18n');
const check = process.argv.includes('--check');
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
let problems = 0;

for (const file of fs.readdirSync(path.join(DIR, 'ar')).filter((f) => f.endsWith('.json')).sort()) {
  const ar = read(path.join(DIR, 'ar', file));
  const enFile = path.join(DIR, 'en', file);
  const old = read(enFile);
  const en = {};
  for (const key of Object.keys(ar)) {
    if (ar[key] && typeof ar[key] === 'object') {
      if (old[key] && typeof old[key] === 'object' && old[key].one && old[key].other) en[key] = old[key];
      else { console.error(`${file}: plural "${key}" needs { one, other } in en/${file}`); problems += 1; en[key] = { one: key, other: key }; }
    } else en[key] = key;
  }
  const out = `${JSON.stringify(en, null, 2)}\n`;
  const cur = fs.existsSync(enFile) ? fs.readFileSync(enFile, 'utf8') : '';
  if (cur !== out) {
    if (check) { console.error(`en/${file} is out of step with ar/${file} (run node scripts/i18n-sync.js)`); problems += 1; }
    else { fs.mkdirSync(path.dirname(enFile), { recursive: true }); fs.writeFileSync(enFile, out); console.log(`wrote en/${file} (${Object.keys(en).length} keys)`); }
  }
}
process.exit(problems ? 1 : 0);
