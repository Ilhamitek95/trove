'use strict';
/**
 * Priced extras — the optional finishing touches a maker offers on a piece
 * (gift wrap, a gift box, hand-engraving), each with its own price.
 *
 * An extra is always the buyer's choice to add; there is no "required" extra —
 * that would just be part of the price. The chosen extras are snapshotted on
 * the line item (name AND price, as they stood at purchase) and their cost is
 * folded into the line's unit price, so settlement, returns and every other
 * money path keep reading the one price_cents number they always have.
 *
 * The server owns the prices: a buyer's request only ever names the extras,
 * and the amounts come from the product row at checkout time.
 *
 * Shapes:
 *   products.extras     [{ name:'Gift wrap', priceCents:1500 }, …]
 *   order_items.extras  [{ name:'Gift wrap', priceCents:1500 }, …]  (snapshot)
 */

const MAX_EXTRAS = 6;       // a longer list is a price list, not a listing
const NAME_MAX = 40;
const MAX_PRICE_CENTS = 100000 * 100;  // same ceiling a product price gets in practice

const parse = (text) => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };

/** Clean a seller-submitted list: trims, dedupes by name, drops empties. */
function normalize(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw.slice(0, MAX_EXTRAS)) {
    if (!e || typeof e !== 'object') continue;
    const name = String(e.name || '').trim().slice(0, NAME_MAX);
    if (!name) continue;
    if (out.some((o) => o.name.toLowerCase() === name.toLowerCase())) continue;
    const cents = Math.round(Number(e.priceCents));
    // 0 is a real price — a free gift message is still worth offering.
    out.push({ name, priceCents: Number.isFinite(cents) && cents > 0 ? Math.min(cents, MAX_PRICE_CENTS) : 0 });
  }
  return out;
}

/** Seller-side validation message, or null when the list is usable. */
function extrasError(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return 'Extras must be a list';
  if (raw.length > MAX_EXTRAS) return `Up to ${MAX_EXTRAS} extras per product`;
  for (const e of raw) {
    if (!e || typeof e !== 'object') return 'Each extra needs a name and a price';
    const name = String(e.name || '').trim();
    const price = Number(e.priceCents);
    // An empty row (nothing typed yet) is the common slip — just drop it.
    if (!name && (e.priceCents == null || e.priceCents === '' || !price)) continue;
    if (!name) return 'Give every extra a name, like Gift wrap';
    if (e.priceCents != null && e.priceCents !== '' && (!Number.isFinite(price) || price < 0))
      return `The price for “${name}” doesn't look right`;
  }
  return null;
}

/**
 * Validate a buyer's chosen extras against the product's own list.
 * Returns { error } or { value: [{name, priceCents}, …] } ready to store —
 * always in the product's order, priced from the product, never the client.
 */
function selectionError(productExtrasText, selection, productName) {
  const offered = Array.isArray(productExtrasText) ? productExtrasText : parse(productExtrasText);
  const wanted = new Map();   // lowercase → the buyer's own spelling, for the error
  for (const s of Array.isArray(selection) ? selection : []) {
    const name = String(s && typeof s === 'object' ? s.name : s == null ? '' : s).trim();
    if (name) wanted.set(name.toLowerCase(), name);
  }
  if (!wanted.size) return { value: [] };
  const value = offered.filter((e) => wanted.delete(e.name.toLowerCase()));
  if (wanted.size) return { error: `“${wanted.values().next().value}” isn't one of the extras for ${productName}` };
  return { value: value.map((e) => ({ name: e.name, priceCents: e.priceCents || 0 })) };
}

/** What the chosen extras add to ONE unit, in fils. */
const totalCents = (chosen) => (Array.isArray(chosen) ? chosen : parse(chosen))
  .reduce((t, e) => t + (parseInt(e.priceCents, 10) || 0), 0);

/** "Gift wrap (AED 15) · Gift message" — the one-line form for receipts and dashboards. */
const label = (chosen) => (Array.isArray(chosen) ? chosen : parse(chosen))
  .map((e) => e.priceCents ? `${e.name} (AED ${(e.priceCents / 100).toLocaleString()})` : e.name).join(' · ');

module.exports = { MAX_EXTRAS, parse, normalize, extrasError, selectionError, totalCents, label };
