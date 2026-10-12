'use strict';
/**
 * The money and policy figures written into the site's copy follow fees.js
 * (F319 / F378 / F502).
 *
 * The copy — the pages in docs/, the Site content defaults (content.js), the
 * interface dictionaries (docs/i18n) and server strings — is written with
 * the figures Trove launched with: makers keep 60% (Trove's 40%), a 15-day
 * return window, payouts every other Tuesday, delivery AED 30 on orders of
 * AED 200 and below, a 1–4 day courier window (so most pieces arrive in 3–6
 * days) and the AED 30/month provider listing fee. Those are SHIPPED below,
 * equal to the defaults in fees.js.
 *
 * Every one of them can be changed by an environment setting (fees.js). When
 * one is, refigure() rewrites the shipped figure to the current one in the
 * copy as the server reads it — page templates (outside <style> and style
 * attributes), dictionaries (keys AND Arabic values, so translation still
 * matches), Site content defaults and i18n.t() strings — so the sell page,
 * apply page, help pages and emails say what checkout charges. With the
 * shipped figures (today) every function here returns its input unchanged.
 *
 * Arabic: a dictionary entry whose English carries a changed figure gets the
 * same number swapped in its Arabic (Arabic copy uses Western digits); if the
 * Arabic does not show the number the same way, or the change is a wording
 * one (the payout rhythm), the entry is dropped so the page shows the correct
 * English rather than a wrong Arabic figure. Static scripts (docs/*.js) are
 * not rewritten; only the payout-rhythm wording appears in them.
 *
 * Owner note: the commission, return window and payout rhythm are also terms
 * of the Seller Agreement and Terms of Sale. Changing them by setting makes
 * the site copy follow, but the legal documents only change with a new
 * version (see CLAUDE.md, "Business model").
 *
 * test/oct12-E.test.js changes the figures and checks the pages for stale ones.
 */
const fees = require('./fees');

const SHIPPED = Object.freeze({
  commission: 40, returnDays: 15, intervalDays: 14, deliveryFeeCents: 3000, freeOverCents: 20000,
  transitMin: 1, transitMax: 4, leadDefault: 2, providerSubCents: 3000,
});
const KEYS = Object.keys(SHIPPED);

function current() {
  return {
    commission: fees.COMMISSION_PERCENT,
    returnDays: fees.RETURN_WINDOW_DAYS,
    intervalDays: fees.SETTLEMENT_INTERVAL_DAYS,
    deliveryFeeCents: fees.DELIVERY_FEE_CENTS,
    freeOverCents: fees.FREE_DELIVERY_THRESHOLD_CENTS,
    transitMin: fees.COURIER_TRANSIT_MIN_DAYS,
    transitMax: fees.COURIER_TRANSIT_MAX_DAYS,
    leadDefault: fees.LEAD_DAYS_DEFAULT,
    providerSubCents: fees.PROVIDER_SUB_FEE_CENTS,
  };
}
/** A short key for caches: changes whenever any figure does. */
function signature() {
  const c = current();
  return KEYS.map((k) => c[k]).join('|');
}
const SHIPPED_SIG = KEYS.map((k) => SHIPPED[k]).join('|');
/** True when any figure differs from the shipped copy. */
const changed = () => signature() !== SHIPPED_SIG;

const aed = (cents) => {
  const n = cents / 100;
  return 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toFixed(2));
};

/* Regex sources (strings, so each use gets a fresh RegExp). */
const SHARE = String.raw`(?<![\d.])60%`;
const COMMISSION = String.raw`(?<![\d.])40%`;
const RETURN_EN = String.raw`(?<![\d.])15(?=-day\b| days?\b)`;
const RETURN_AR = String.raw`(?<![\d.,])15(?![\d.,%])`;
const SUB_EN = String.raw`AED 30(?=\/month| a month)`;
// (a following digit, or ,/. + digit, is a different amount; a comma or full stop after it is punctuation)
const FEE_EN = String.raw`AED 30(?!\d|[,.]\d|\/month| a month)`;
const THIRTY_AR = String.raw`AED\s?30(?!\d|[,.]\d)`;
const OVER_EN = String.raw`AED 200(?!\d|[,.]\d|\+)`; // never the 'AED 200+' price-filter label
const OVER_AR = String.raw`AED\s?200(?!\d|[,.]\d|\+)`;
/** 'a–b', 'a to b' and the Arabic 'a إلى b', digit-bounded. */
const RANGE = (a, b) => String.raw`(?<!\d)${a}(\s*(?:–|-|to|إلى)\s*)${b}(?!\d)`;

const has = (src) => (s) => new RegExp(src).test(s);
const sub = (src, to) => (s) => s.replace(new RegExp(src, 'g'), to);

/*
 * Each rule: `src` over English copy and its replacement `to`; numeric rules
 * also `swap(arabic)` (the same change in an Arabic dictionary value) and
 * `seen(arabic)` (the Arabic shows the number that way). Wording rules have
 * no swap: the Arabic entry is dropped instead.
 */
function rules(c) {
  const out = [];
  const numeric = (src, to, arSrc, arTo) => ({ src, to, swap: sub(arSrc, arTo), seen: has(arSrc) });
  const range = (a, b, x, y) => {
    const src = RANGE(a, b);
    const to = (m, mid) => `${x}${mid}${y}`;
    return { src, to, swap: sub(src, to), seen: has(src) };
  };
  if (c.commission !== SHIPPED.commission) {
    out.push(numeric(SHARE, `${100 - c.commission}%`, SHARE, `${100 - c.commission}%`));
    out.push(numeric(COMMISSION, `${c.commission}%`, COMMISSION, `${c.commission}%`));
  }
  if (c.returnDays !== SHIPPED.returnDays || c.intervalDays !== SHIPPED.intervalDays) {
    // 'in practice 16 to 29 days after delivery' = the window + 1 … the window + one payout cycle
    out.push(range(16, 29, c.returnDays + 1, c.returnDays + c.intervalDays));
  }
  if (c.returnDays !== SHIPPED.returnDays) out.push(numeric(RETURN_EN, String(c.returnDays), RETURN_AR, String(c.returnDays)));
  if (c.providerSubCents !== SHIPPED.providerSubCents) out.push(numeric(SUB_EN, aed(c.providerSubCents), THIRTY_AR, aed(c.providerSubCents)));
  if (c.deliveryFeeCents !== SHIPPED.deliveryFeeCents) out.push(numeric(FEE_EN, aed(c.deliveryFeeCents), THIRTY_AR, aed(c.deliveryFeeCents)));
  if (c.freeOverCents !== SHIPPED.freeOverCents) out.push(numeric(OVER_EN, aed(c.freeOverCents), OVER_AR, aed(c.freeOverCents)));
  if (c.transitMin !== SHIPPED.transitMin || c.transitMax !== SHIPPED.transitMax || c.leadDefault !== SHIPPED.leadDefault) {
    out.push(range(1, 4, c.transitMin, c.transitMax));                                  // the courier window
    out.push(range(3, 6, c.leadDefault + c.transitMin, c.leadDefault + c.transitMax)); // most pieces arrive in …
  }
  if (c.intervalDays !== SHIPPED.intervalDays) {
    const weekly = c.intervalDays === 7;
    out.push({ src: 'every other Tuesday', to: weekly ? 'every Tuesday' : `every ${c.intervalDays} days, on a Tuesday` });
    out.push({ src: 'Fortnightly', to: weekly ? 'Weekly' : 'Regular' });
    out.push({ src: 'fortnightly', to: weekly ? 'weekly' : 'regular' });
    out.push({ src: 'fortnight', to: weekly ? 'week' : 'payout cycle' });
  }
  return out;
}

let cache = { sig: null, list: [] };
function activeRules() {
  const sig = signature();
  if (cache.sig !== sig) cache = { sig, list: rules(current()) };
  return cache.list;
}

/** { text, hit: [the rules that changed it] } */
function refigureDetailed(text) {
  if (typeof text !== 'string' || !changed()) return { text, hit: [] };
  let out = text;
  const hit = [];
  for (const r of activeRules()) {
    if (!new RegExp(r.src).test(out)) continue;
    out = out.replace(new RegExp(r.src, 'g'), r.to);
    hit.push(r);
  }
  return { text: out, hit };
}

/** Copy with the shipped figures replaced by the current ones (unchanged today). */
const refigure = (text) => refigureDetailed(text).text;

/** A page template: refigured everywhere except CSS (<style> blocks and style attributes). */
function refigureHtml(html) {
  if (typeof html !== 'string' || !changed()) return html;
  return html.split(/(<style\b[\s\S]*?<\/style>|\sstyle="[^"]*")/i).map((part, i) => (i % 2 ? part : refigure(part))).join('');
}

/**
 * One dictionary entry → [key, value], or [key, null] when the Arabic can't
 * be trusted to carry the new figure (then the English shows).
 */
function refigureEntry(key, value) {
  const { text: k2, hit } = refigureDetailed(key);
  if (!hit.length) return [key, value];
  if (hit.some((r) => !r.swap)) return [k2, null];
  const one = (v) => {
    if (typeof v !== 'string') return v;
    if (hit.some((r) => !r.seen(v))) return null;
    return hit.reduce((s, r) => r.swap(s), v);
  };
  if (value && typeof value === 'object') {
    const forms = {};
    for (const [f, v] of Object.entries(value)) {
      const nv = one(v);
      if (nv == null) return [k2, null];
      forms[f] = nv;
    }
    return [k2, forms];
  }
  return [k2, one(value)];
}

/** A whole dictionary, refigured (the same object when nothing changed). */
function refigureDict(dict) {
  if (!changed() || !dict || typeof dict !== 'object') return dict;
  const out = {};
  for (const [k, v] of Object.entries(dict)) {
    const [k2, v2] = refigureEntry(k, v);
    if (v2 != null) out[k2] = v2;
  }
  return out;
}

/** Every string inside a plain JSON value, refigured (the Site content defaults). */
function refigureDeep(value) {
  if (!changed()) return value;
  if (typeof value === 'string') return refigure(value);
  if (Array.isArray(value)) return value.map(refigureDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, refigureDeep(v)]));
  return value;
}

module.exports = { SHIPPED, current, signature, changed, refigure, refigureHtml, refigureEntry, refigureDict, refigureDeep };
