'use strict';
/**
 * Product tags — short lowercase phrases shoppers search by.
 * Stored on products.tags as a JSON array string. All input (seller-typed or
 * AI-written) goes through normalizeTags so the column only ever holds clean
 * values: lowercase, deduped, capped in length and count.
 */
const MAX_TAGS = 12;
const MAX_TAG_LEN = 28;

function normalizeTags(input) {
  let list = input;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = list.split(','); }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).toLowerCase()
      .replace(/[^\p{L}\p{N}&' -]/gu, ' ')   // letters/digits in any script, & ' - and spaces
      .replace(/\s+/g, ' ').trim()
      .slice(0, MAX_TAG_LEN).trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function parseTags(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

module.exports = { normalizeTags, parseTags, MAX_TAGS, MAX_TAG_LEN };
