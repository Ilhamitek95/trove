'use strict';
/**
 * Product options and their variants — the buyer-facing variations a maker
 * offers on a piece (Colour: Sand / Clay / Ink, Size: S / M / L).
 *
 * Every combination is its own variant with its OWN stock and, when the maker
 * wants one, its own price. Running out of the ash glaze has to take the ash
 * glaze off sale without touching the deep clay one.
 *
 * The server owns the grid: whenever a shop saves options, the full cartesian
 * product is rebuilt and the stock/price it sent are merged in by key. A
 * combination that isn't in the grid does not exist, so an incomplete save can
 * never leave something quietly on sale.
 *
 * `products.stock` stays the single number the rest of the app reads (sold-out
 * badges, the catalogue, the seller table) and is kept equal to the sum of the
 * variant stocks.
 *
 * Shapes:
 *   products.options    [{ name:'Colour', values:['Sand','Clay'] }, …]
 *   products.variants   [{ key:'Colour:Sand', options:[…], stock:3, priceCents:null }, …]
 *   order_items.options [{ name:'Colour', value:'Clay' }, …]
 */

const MAX_GROUPS = 3;      // more than three questions is a configurator, not a listing
const MAX_VALUES = 20;
const NAME_MAX = 24;
const VALUE_MAX = 40;

const parse = (text) => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };

/** Clean a seller-submitted list: trims, dedupes, drops empties. */
function normalize(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw.slice(0, MAX_GROUPS)) {
    if (!g || typeof g !== 'object') continue;
    const name = String(g.name || '').trim().slice(0, NAME_MAX);
    if (!name) continue;
    if (out.some((o) => o.name.toLowerCase() === name.toLowerCase())) continue;
    const values = [];
    for (const v of Array.isArray(g.values) ? g.values : []) {
      const val = String(v == null ? '' : v).trim().slice(0, VALUE_MAX);
      if (val && !values.some((x) => x.toLowerCase() === val.toLowerCase())) values.push(val);
      if (values.length >= MAX_VALUES) break;
    }
    if (values.length) out.push({ name, values });
  }
  return out;
}

/** Seller-side validation message, or null when the list is usable. */
function optionsError(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return 'Options must be a list';
  if (raw.length > MAX_GROUPS) return `Up to ${MAX_GROUPS} option groups per product`;
  for (const g of raw) {
    if (!g || typeof g !== 'object') return 'Each option needs a name and at least one choice';
    const name = String(g.name || '').trim();
    const values = (Array.isArray(g.values) ? g.values : []).map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
    // A half-filled row (a name typed, no choices yet) is the common slip —
    // say which one, rather than silently dropping the seller's work.
    if (!name && !values.length) continue;
    if (!name) return 'Give every option a name, like Colour or Size';
    if (!values.length) return `Add at least one choice for “${name}”`;
    if (values.length > MAX_VALUES) return `Up to ${MAX_VALUES} choices for “${name}”`;
  }
  return null;
}

/**
 * Validate a buyer's selection against the product's own options.
 * Returns { error } or { value: [{name, value}, …] } ready to store.
 * Matching is case-insensitive but the stored value is the seller's spelling.
 */
function selectionError(productOptionsText, selection, productName) {
  const groups = Array.isArray(productOptionsText) ? productOptionsText : parse(productOptionsText);
  if (!groups.length) return { value: [] };
  const picked = new Map();
  for (const s of Array.isArray(selection) ? selection : []) {
    if (s && typeof s === 'object' && s.name != null) picked.set(String(s.name).trim().toLowerCase(), String(s.value == null ? '' : s.value).trim());
  }
  const value = [];
  for (const g of groups) {
    const chosen = picked.get(g.name.toLowerCase());
    if (!chosen) return { error: `Choose a ${g.name.toLowerCase()} for ${productName}` };
    const match = g.values.find((v) => v.toLowerCase() === chosen.toLowerCase());
    if (!match) return { error: `“${chosen}” isn't one of the ${g.name.toLowerCase()} choices for ${productName}` };
    value.push({ name: g.name, value: match });
  }
  return { value };
}

/** "Colour: Clay · Size: M" — the one-line form used in emails and dashboards. */
const label = (chosen) => (Array.isArray(chosen) ? chosen : parse(chosen))
  .map((o) => `${o.name}: ${o.value}`).join(' · ');

/* ---- variants ---- */

/** Stable identity for one combination, in the order the groups are listed. */
const variantKey = (chosen) => (Array.isArray(chosen) ? chosen : parse(chosen))
  .map((o) => `${o.name}:${o.value}`).join('|');

/** Every combination of the groups, as chosen-arrays. */
function combinations(groups) {
  return groups.reduce(
    (rows, g) => rows.flatMap((row) => g.values.map((v) => [...row, { name: g.name, value: v }])),
    [[]],
  );
}

/**
 * The full grid for these groups, carrying over the stock and price of any
 * combination that already existed (matched by key). A brand-new combination
 * starts at zero — the maker has to say they can make it before it sells.
 */
function buildVariants(groups, incoming) {
  if (!groups.length) return [];
  const prev = new Map((Array.isArray(incoming) ? incoming : [])
    .filter((v) => v && typeof v === 'object')
    .map((v) => [String(v.key || variantKey(v.options || [])), v]));
  return combinations(groups).map((chosen) => {
    const key = variantKey(chosen);
    const old = prev.get(key) || {};
    const stock = Math.max(0, parseInt(old.stock, 10) || 0);
    // An empty price override means "use the product price" — never free.
    const raw = old.priceCents == null || old.priceCents === '' ? null : Math.round(Number(old.priceCents));
    const priceCents = Number.isFinite(raw) && raw > 0 ? raw : null;
    return { key, options: chosen, stock, priceCents };
  });
}

/** The variant a buyer's choice points at, or null when it isn't in the grid. */
function findVariant(variantsText, chosen) {
  const key = variantKey(chosen);
  return parse(variantsText).find((v) => v.key === key) || null;
}

/** products.stock for a piece with variants: what the shop can actually make. */
const totalStock = (variants) => (Array.isArray(variants) ? variants : parse(variants))
  .reduce((t, v) => t + (parseInt(v.stock, 10) || 0), 0);

module.exports = {
  MAX_GROUPS, MAX_VALUES, parse, normalize, optionsError, selectionError, label,
  variantKey, combinations, buildVariants, findVariant, totalStock,
};
