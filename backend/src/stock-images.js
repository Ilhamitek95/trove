'use strict';
/**
 * The interim matched stock photos (owner, 2026-09-02) live in ONE place —
 * window.TROVE_STOCK_IMG in docs/api.js — because the storefront and the admin
 * crop editor read them there. The emails show the same covers, so this reads
 * the map out of that file once instead of keeping a second copy that could
 * drift. Delete both when the PHOTOGRAPHY-MANIFEST shoots replace them.
 */
const fs = require('fs');
const path = require('path');

let map = null;
function load() {
  if (map) return map;
  map = {};
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'api.js'), 'utf8');
    const block = src.slice(src.indexOf('window.TROVE_STOCK_IMG'));
    for (const m of block.matchAll(/'((?:[^'\\]|\\.)+)':\s*u\('([\w-]+)'\)/g)) map[m[1].replace(/\\'/g, "'")] = m[2];
  } catch (_) { /* no docs folder next to the backend — no stock covers */ }
  return map;
}

/** Square-cropped cover for a product name, or '' when it has no stock photo. */
function stockImage(name, px = 144) {
  const id = load()[name];
  return id ? `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${px}&h=${px}&q=70` : '';
}

module.exports = { stockImage, _map: load };
