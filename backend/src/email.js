'use strict';
/**
 * Transactional email via Resend's HTTP API (no SDK — one fetch).
 *
 * Best-effort by design: an email must never fail the request that triggered
 * it, so callers fire-and-forget with .catch. Without RESEND_API_KEY every
 * send resolves as skipped (logged), which keeps local dev and the test suite
 * working with zero setup.
 *
 * Env:
 *   RESEND_API_KEY  switches real sending on
 *   EMAIL_FROM      verified sender, e.g. "Trove <noreply@troveathome.com>"
 *                   (the domain must be verified in the Resend dashboard).
 *                   A no-reply address: nobody reads replies, so the
 *                   templates point people to their account, never "reply".
 *
 * Markup is table-based with inline styles — the only layout every inbox
 * (Gmail, Outlook, Apple Mail, phones) renders the same. Brand rules hold
 * here too: cream/charcoal, orange only as a display accent, no italics,
 * UK English.
 *
 * Languages (2026-10-02): every email to a buyer, maker or provider goes out
 * in the recipient's language — the account's users.lang, a guest order's
 * orders.lang, a services customer's service_bookings.lang (langFor()).
 * Emails to the person who runs Trove stay English. The strings live in
 * docs/i18n/ar/email.json (keyed by the English); an Arabic email is
 * right-to-left, its links point at the /ar pages, and prices and order
 * numbers sit in left-to-right isolates. English output is unchanged.
 */
const i18n = require('./i18n');

const enabled = () => !!process.env.RESEND_API_KEY;
const from = () => process.env.EMAIL_FROM || 'Trove <noreply@troveathome.com>';

async function send({ to, subject, html }) {
  if (!to) return { skipped: true };
  if (!enabled()) {
    console.log(`email skipped (no RESEND_API_KEY): "${subject}" -> ${to}`);
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: from(), to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log(`email sent: "${subject}" -> ${to}`);
  return res.json();
}

/* ---- the recipient's language ---- */
const okLang = (l) => (l === 'ar' ? 'ar' : 'en');
/**
 * { order } → the buyer account's language, else the order's own (guest
 * checkout: the language of the checkout page); { booking } → the booking's;
 * { userId } / { email } → that account's. Unknown → English.
 */
function langFor({ order, booking, userId, email } = {}) {
  try {
    const db = require('./db');
    if (order) {
      if (order.buyer_id) {
        const u = db.prepare('SELECT lang FROM users WHERE id=?').get(order.buyer_id);
        if (u && u.lang) return okLang(u.lang);
      }
      if (order.lang) return okLang(order.lang);
      if (order.id) { const r = db.prepare('SELECT lang FROM orders WHERE id=?').get(order.id); if (r) return okLang(r.lang); }
      return 'en';
    }
    if (booking) {
      if (booking.lang) return okLang(booking.lang);
      if (booking.id) { const r = db.prepare('SELECT lang FROM service_bookings WHERE id=?').get(booking.id); if (r) return okLang(r.lang); }
      return 'en';
    }
    if (userId) { const u = db.prepare('SELECT lang FROM users WHERE id=?').get(userId); return okLang(u && u.lang); }
    if (email) { const u = db.prepare('SELECT lang FROM users WHERE email=? COLLATE NOCASE').get(String(email).trim()); return okLang(u && u.lang); }
  } catch (_) { /* never fails an email */ }
  return 'en';
}

/** A piece's name in Arabic when its current English name has a current translation, else as written. */
function pieceName(lang, name) {
  if (lang !== 'ar' || !name) return name;
  try {
    const hash = require('crypto').createHash('sha256').update(String(name)).digest('hex');
    const r = require('./db').prepare("SELECT text FROM translations WHERE entity='product' AND field='name' AND lang='ar' AND source_hash=? LIMIT 1").get(hash);
    return r && r.text ? r.text : name;
  } catch (_) { return name; }
}

/* ---- shared bits for the templates ---- */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const aed = (cents) => {
  const n = (cents || 0) / 100;
  return 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB')
    : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
const SITE_LINK = 'https://troveathome.com';
// Where uploaded photos are served from (absolute — an inbox has no base URL).
const SITE = () => (process.env.PUBLIC_URL || String(process.env.CLIENT_URL || '').split(',')[0] || SITE_LINK).trim().replace(/\/+$/, '');

const INK = '#292727', MUTED = '#7b716d', LINE = '#EFE5E0', CREAM = '#FDF7F5';
const SANS = "Quicksand,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Cormorant,Georgia,'Times New Roman',serif";
const SANS_AR = "'IBM Plex Sans Arabic',Quicksand,Tahoma,'Segoe UI',Arial,sans-serif";
const SERIF_AR = "'Noto Naskh Arabic',Cormorant,Georgia,'Times New Roman',serif";
const TONES = { sage: '#E4ECE5', clay: '#F2E9E4', blush: '#FCEBE4' };
const TILE = ['#DBC7BD', '#CAD5CC', '#E9D8CF', '#F8D7E4', '#CFDBBE', '#BED3DF'];

/**
 * A product's picture for an email: the maker's first uploaded photo, else
 * the matched stock shot the storefront shows, else '' (the template then
 * draws a brand tile). Always an absolute URL.
 */
function productImage({ images, name } = {}) {
  let list = images;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (_) { list = []; } }
  const first = Array.isArray(list) && list.find(Boolean);
  if (first) return /^https?:/i.test(first) ? first : SITE() + (first.startsWith('/') ? '' : '/') + first;
  return require('./stock-images').stockImage(name);
}

const dubaiDate = (sqlTime, lang = 'en') => {
  if (!sqlTime) return '';
  const d = new Date(String(sqlTime).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(sqlTime) ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  return lang === 'ar' ? i18n.date('ar', d) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
};
const svcDate = (d, lang = 'en') => {
  if (!d) return '';
  const t = new Date(String(d) + 'T00:00:00Z');
  if (Number.isNaN(t.getTime())) return String(d);
  return lang === 'ar' ? i18n.date('ar', t, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : t.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
/** 'Friday 2 October' (Dubai day of a SQLite UTC time) in the language — the pack-by / ID-expiry days. */
function dayLabel(lang, sql, { year = false } = {}) {
  const lt = require('./lead-times');
  if (lang !== 'ar') return lt.dubaiDay(sql, { year });
  if (!sql) return '';
  const d = lt.fromSql(sql);
  if (Number.isNaN(d.getTime())) return '';
  return i18n.date('ar', d, { weekday: 'long', day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}) });
}

/** An absolute Trove link in the reader's language (the /ar twin for Arabic). */
function localLink(lang, url) {
  const s = String(url == null ? '' : url);
  if (lang !== 'ar') return s;
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(.*)$/i.exec(s);
  if (!m) return s.startsWith('/') ? i18n.arUrl(s) : s;
  return m[1] + i18n.arUrl((m[2] || '/') + m[3]);
}

/**
 * The building blocks of every template, in one language. English output is
 * exactly what the templates produced before languages existed.
 */
function kit(lang) {
  lang = okLang(lang);
  const ar = lang === 'ar';
  const sans = ar ? SANS_AR : SANS;
  const serif = ar ? SERIF_AR : SERIF;
  const END = ar ? 'left' : 'right';
  const T = (k, v) => i18n.t(lang, k, v, ['email']);
  const TN = (n, one, other, v) => i18n.tn(lang, n, one, other, v, ['email']);
  /** Money (and order numbers) in a left-to-right isolate when the email is Arabic. */
  const A = (cents) => (ar ? i18n.iso('ar', aed(cents)) : aed(cents));
  const I = (s) => (ar ? i18n.iso('ar', s) : s);
  const L = (url) => localLink(lang, url);
  const date = (sql) => dubaiDate(sql, lang);
  const sdate = (d) => svcDate(d, lang);

  function thumb(item) {
    if (item.image) {
      return `<img src="${esc(item.image)}" width="72" height="72" alt="${esc(item.name)}" style="display:block;width:72px;height:72px;border:0;border-radius:12px;object-fit:cover;background:#F2E9E4">`;
    }
    let h = 7;
    for (const ch of String(item.name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="72" height="72" align="center" valign="middle"
    style="width:72px;height:72px;border-radius:12px;background:${TILE[h % TILE.length]};font-family:${serif};font-size:30px;font-weight:500;color:${INK}">${esc(String(item.name || '·').trim().charAt(0).toUpperCase())}</td></tr></table>`;
  }

  const p = (s) => `<p style="margin:14px 0;font-family:${sans};font-size:15px;line-height:${ar ? 1.85 : 1.65};color:${INK}">${s}</p>`;
  const note = (s) => `<p style="margin:18px 0 0;text-align:center;font-family:${sans};font-size:13.5px;line-height:${ar ? 1.8 : 1.6};color:${MUTED}">${s}</p>`;
  const label = (s) => `<div style="font-family:${sans};font-size:12.5px;color:${MUTED};padding-bottom:6px">${s}</div>`;
  const heading = (s) => `<div style="font-family:${serif};font-size:22px;font-weight:600;color:${INK};padding:30px 0 4px">${s}</div>`;
  /** A soft cream panel for the one number or fact the email is about. */
  const panel = (html) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0"><tr>
  <td style="background:${CREAM};border:1px solid ${LINE};border-radius:14px;padding:16px 20px;font-family:${sans};font-size:15px;line-height:${ar ? 1.8 : 1.6};color:${INK}">${html}</td></tr></table>`;

  function button(text, href) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:30px auto 6px"><tr>
    <td style="background:${INK};border-radius:999px"><a href="${L(href)}" style="display:inline-block;padding:14px 32px;font-family:${sans};font-size:15px;font-weight:700;color:${CREAM};text-decoration:none;border-radius:999px">${text}</a></td>
  </tr></table>`;
  }

  /** One row per piece: picture, name + chosen options, quantity, line price. */
  function itemRow(i) {
    const name = pieceName(lang, i.name);
    const each = i.qty > 1 ? T(' · {price} each', { price: A(i.price_cents) }) : '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${LINE}"><tr>
    <td width="72" valign="top" style="padding:${ar ? '14px 0 14px 16px' : '14px 16px 14px 0'}">${thumb({ ...i, name })}</td>
    <td valign="top" style="padding:16px 0;font-family:${sans};color:${INK}">
      <div style="font-size:15px;font-weight:700;line-height:1.35">${esc(name)}</div>
      ${i.meta ? `<div style="font-size:13px;line-height:1.5;color:${MUTED};padding-top:3px">${esc(i.meta)}</div>` : ''}
      <div style="font-size:13px;color:${MUTED};padding-top:3px">${T('Qty {n}', { n: i.qty })}${each}</div>
    </td>
    <td valign="top" align="${END}" style="padding:${ar ? '16px 12px 16px 0' : '16px 0 16px 12px'};font-family:${sans};font-size:15px;font-weight:700;color:${INK};white-space:nowrap">${A(i.price_cents * i.qty)}</td>
  </tr></table>`;
  }
  const itemsBlock = (items) => `<div style="margin:6px 0 4px">${items.map(itemRow).join('')}</div>`;

  /** Pieces grouped by the shop that packs them — one group per parcel. */
  function itemsByShop(items) {
    const groups = [];
    for (const i of items) {
      const key = i.shop || '';
      let g = groups.find((x) => x.shop === key);
      if (!g) groups.push(g = { shop: key, items: [] });
      g.items.push(i);
    }
    if (groups.length < 2) return itemsBlock(items);
    return groups.map((g, n) => `<div style="font-family:${sans};font-size:13px;color:${MUTED};padding:${n ? 22 : 10}px 0 0">
      ${T('Parcel {n} of {total} · packed by {shop}', { n: n + 1, total: groups.length, shop: `<b style="color:${INK}">${esc(g.shop)}</b>` })}</div>${itemsBlock(g.items)}`).join('');
  }

  const totalRow = (name, value, bold) => `<tr>
  <td style="padding:${bold ? '12px 0 0' : '4px 0'};font-family:${sans};font-size:${bold ? 17 : 14.5}px;${bold ? `font-weight:700;color:${INK};border-top:1px solid ${LINE}` : `color:${MUTED}`}">${esc(name)}</td>
  <td align="${END}" style="padding:${bold ? '12px 0 0' : '4px 0'};font-family:${sans};font-size:${bold ? 17 : 14.5}px;${bold ? `font-weight:700;color:${INK};border-top:1px solid ${LINE}` : `color:${INK}`}">${value}</td></tr>`;
  const totals = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0">${rows.join('')}</table>`;

  /** Confirmed → Packed → On its way → Delivered, with the first `done` steps filled. */
  function tracker(done) {
    const steps = [T('Confirmed'), T('Packed'), T('On its way'), T('Delivered')];
    const on = (i) => i < done;
    const bar = (lit, hidden) => `<div style="height:2px;line-height:2px;font-size:0;background:${hidden ? 'transparent' : lit ? INK : '#E6D9D2'}">&nbsp;</div>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 4px"><tr>
    ${steps.map((s, i) => `<td width="25%" valign="top" align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="50%" valign="middle">${bar(on(i), i === 0)}</td>
        <td valign="middle"><div style="width:12px;height:12px;border-radius:12px;background:${on(i) ? INK : '#FFFFFF'};border:2px solid ${on(i) ? INK : '#DBC7BD'}"></div></td>
        <td width="50%" valign="middle">${bar(on(i + 1), i === steps.length - 1)}</td>
      </tr></table>
      <div style="font-family:${sans};font-size:12px;padding-top:8px;color:${on(i) ? INK : MUTED};font-weight:${on(i) ? 700 : 500}">${s}</div>
    </td>`).join('')}
  </tr></table>`;
  }

  /**
   * The shell every email shares: wordmark, a tinted hero with the headline,
   * the white card, and the footer. `kicker` is the small line above the
   * headline (e.g. the order number), `preheader` the inbox preview text.
   */
  function layout(title, inner, { intro = '', kicker = '', preheader = '', tone = 'sage', reason = T("You're receiving this because of an order you placed with Trove.") } = {}) {
    const home = ar ? `${SITE_LINK}/ar` : SITE_LINK;
    return `<!doctype html>
<html lang="${lang}"${ar ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant:wght@500;600&family=Quicksand:wght@500;700${ar ? '&family=IBM+Plex+Sans+Arabic:wght@400;500;700&family=Noto+Naskh+Arabic:wght@500;600' : ''}&display=swap" rel="stylesheet">
<style>
  body{margin:0;padding:0;background:${CREAM}${ar ? ';direction:rtl;text-align:right' : ''}}
  a{color:${INK}}
  @media (max-width:620px){
    .wrap{width:100%!important}
    .px{padding-left:22px!important;padding-right:22px!important}
    .stack{display:block!important;width:100%!important;box-sizing:border-box}
    .h1{font-size:30px!important}
  }
</style></head>
<body${ar ? ' dir="rtl"' : ''} style="margin:0;padding:0;background:${CREAM}${ar ? ';direction:rtl;text-align:right' : ''}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM}">${esc(preheader)}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
<table role="presentation"${ar ? ' dir="rtl"' : ''} width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM}"><tr><td align="center" style="padding:28px 12px 36px">
  <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
    <tr><td class="px" style="padding:0 8px 18px"${ar ? ' align="right"' : ''}>
      <a href="${home}" style="text-decoration:none;font-family:${SERIF};font-size:34px;font-weight:600;color:${INK};letter-spacing:.01em"${ar ? ' dir="ltr"' : ''}>trove<span style="color:#F19A82">.</span></a>
    </td></tr>
    <tr><td style="background:#FFFFFF;border:1px solid ${LINE};border-radius:20px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="px" style="background:${TONES[tone] || TONES.sage};padding:34px 40px 30px;border-radius:20px 20px 0 0${ar ? ';text-align:right' : ''}">
          ${kicker ? `<div style="font-family:${sans};font-size:13px;color:${MUTED};padding-bottom:10px">${kicker}</div>` : ''}
          <div class="h1" style="font-family:${serif};font-size:36px;line-height:${ar ? 1.35 : 1.1};font-weight:500;color:${INK}">${esc(title)}</div>
          ${intro ? `<div style="font-family:${sans};font-size:15.5px;line-height:${ar ? 1.8 : 1.6};color:${INK};padding-top:12px">${intro}</div>` : ''}
        </td></tr>
        <tr><td class="px" style="padding:8px 40px 36px${ar ? ';text-align:right' : ''}">${inner}</td></tr>
      </table>
    </td></tr>
    <tr><td class="px" align="center" style="padding:24px 8px 0;font-family:${sans};font-size:12px;line-height:1.7;color:#8b8380">
      <a href="${home}" style="color:${INK};text-decoration:none;font-weight:700">${T('Shop Trove')}</a> &nbsp;·&nbsp;
      <a href="${SITE_LINK}${ar ? '/ar' : ''}/account" style="color:${INK};text-decoration:none;font-weight:700">${T('Your account')}</a><br>
      ${T('Trove · Curated for Living · Dubai, UAE')}<br>
      ${esc(reason)}<br>
      ${T("This is an automated email from a no-reply address, so replies aren't read.")}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  }

  /** Booking summary panel (Services Marketplace). */
  const svcPrice = (bk) => (bk.amount_cents ? A(bk.amount_cents)
    : bk.price_type === 'from' ? T('From {price}', { price: A(bk.price_cents) }) : bk.price_type === 'hourly' ? T('{price} / hour', { price: A(bk.price_cents) }) : A(bk.price_cents));
  const svcKicker = (bk) => T('Booking {code}', { code: `<b style="color:${INK}">${esc(I(bk.code))}</b>` });
  function svcSummary(bk, { price = true, pay = true } = {}) {
    const rows = [
      [T('Service'), esc(bk.title)],
      [T('With'), esc(bk.provider_name)],
      [T('Where'), esc(bk.area)],
      bk.service_date ? [T('Date'), esc(sdate(bk.service_date))] : (bk.preferred_date ? [T('You asked for'), esc(bk.preferred_date)] : null),
      price ? [T('Price'), esc(svcPrice(bk))] : null,
      pay ? [T('Paying'), bk.payment_method === 'trove' ? T('Through Trove by card') : T('Directly with the provider')] : null,
    ].filter(Boolean);
    return panel(rows.map(([k, v]) => `<span style="color:${MUTED}">${k}</span>&nbsp; <b>${v}</b>`).join('<br>'));
  }
  const svcLayout = (who, title, inner, opts) => layout(title, inner, { ...opts, reason: who === 'provider' ? T("You're receiving this because you offer services on the Trove Services Marketplace.") : T("You're receiving this because of a booking on the Trove Services Marketplace.") });
  const orderKicker = (id, extra = '') => T('Order {id}', { id: `<b style="color:${INK}">${esc(I(id))}</b>` }) + extra;

  return {
    lang, ar, sans, serif, T, TN, A, I, L, date, sdate, p, note, label, heading, panel, button, itemsBlock, itemsByShop,
    totalRow, totals, tracker, layout, svcSummary, svcLayout, svcKicker, svcPrice, orderKicker,
  };
}

/* ---- order confirmation ----
 * Sent the moment payment succeeds, from the shared paid effects — so the
 * real webhook and demo completion send exactly the same receipt.
 * { order, items[{ name, qty, price_cents, meta, image, shop }], shops[], ship }
 * with money in fils on the order row.
 */
function orderConfirmation({ order, items, shops, ship, estimate, lang }) {
  const { T, A, I, L, date, ar, p, note, label, heading, button, itemsByShop, totalRow, totals, tracker, layout, sans, orderKicker } = kit(lang || langFor({ order }));
  // The order's delivery estimate (src/lead-times.js orderEstimate): the
  // slowest piece's make time + the courier's window. Older callers without
  // one get the standard 2-day make time.
  const est = estimate || require('./lead-times').orderEstimate([]);
  const estLabel = !ar ? est.label
    : est.minDays === est.maxDays || est.minDays == null ? i18n.tn('ar', Number(est.maxDays) || 0, '{n} day', '{n} days', null, ['email'])
      : T('{min}–{max} days', { min: est.minDays, max: est.maxDays });
  const many = shops.length > 1;
  const first = ship && ship.name ? `${ar ? '، ' : ', '}${esc(String(ship.name).split(' ')[0])}` : '';
  const who = many ? T('The shops are') : T('{shop} is', { shop: esc(shops[0] || T('The shop')) });
  const odate = date(order.created_at);
  const plural = items.length > 1;
  const inner =
    tracker(1)
    + heading(plural ? T('Your pieces') : T('Your piece'))
    + itemsByShop(items)
    + totals([
      totalRow(T('Subtotal'), A(order.subtotal_cents)),
      ...(order.service_fee_cents ? [totalRow(T('Service fee'), A(order.service_fee_cents))] : []),
      totalRow(T('Delivery'), order.shipping_cents ? A(order.shipping_cents) : T('Free')),
      totalRow(T('Total'), A(order.total_cents), true),
      // Once Trove is VAT-registered: the VAT inside the total and the tax
      // invoice number (the invoice itself is in the buyer's account).
      ...(order.vat_amount_cents > 0 ? [totalRow(T('Includes VAT at 5%'), A(order.vat_amount_cents))] : []),
      ...(order.tax_invoice_no ? [totalRow(T('Tax invoice'), esc(I(order.tax_invoice_no)))] : []),
    ])
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 0;background:${CREAM};border:1px solid ${LINE};border-radius:14px"><tr>
        ${ship ? `<td class="stack" width="50%" valign="top" style="padding:18px 20px;font-family:${sans};font-size:14.5px;line-height:1.6;color:${INK}">
          ${label(T('Delivering to'))}${esc(ship.name)}<br>${esc(ship.line)}${ship.line2 ? '<br>' + esc(ship.line2) : ''}<br>${esc(ship.city)}</td>` : ''}
        <td class="stack" width="50%" valign="top" style="padding:18px 20px;font-family:${sans};font-size:14.5px;line-height:1.6;color:${INK}">
          ${label(T('Arriving'))}<b>${T('In {label}', { label: esc(estLabel) })}</b><br>${est.separately
            ? T('Pieces arrive separately as each is ready — {n} parcels, each shop packs its own, all tracked together in one place.', { n: shops.length })
            : many
            ? T('In {n} parcels — each shop packs its own, all tracked together in one place.', { n: shops.length })
            : est.leadDays > 2 ? T('Made or finished for you by hand, then tracked all the way to your door.') : T('Packed by hand and tracked all the way to your door.')}</td>
      </tr></table>`
    + button(T('Track your order'), `${SITE_LINK}/account`)
    + (order.buyer_id
      ? note(T('Something not right? You can request a return from this order in your account.'))
      // A guest order joins an account only once that account's email is
      // confirmed (src/guest-orders.js) — say so, rather than promise a
      // tracking page they cannot reach.
      : note(T('You checked out as a guest. To track this order or request a return, sign in or create a Trove account with {email} and confirm the address: the order then appears in your account.', { email: esc(I(order.email)) })));
  return {
    subject: T('Your Trove order {id} is confirmed', { id: I(order.public_id) }),
    html: layout(T('Your order is confirmed'), inner, {
      kicker: orderKicker(order.public_id, odate ? ' · ' + odate : ''),
      intro: T('Thank you{first}. {who} preparing {pieces} now, and you can follow every step from your account.', { first, who, pieces: plural ? T('your pieces') : T('your piece') }),
      preheader: T('Order {id} is confirmed — {total}, arriving in {label}.', { id: I(order.public_id), total: A(order.total_cents), label: estLabel }),
    }),
  };
  // (L is used by button(); kept for templates that link inline)
}

/* ---- return lifecycle templates ----
 * Each takes { order, items, money } (+ extras) with money = { gross, fee,
 * refund } in fils, and returns { subject, html } ready for send().
 */
// The bracket after a return refund amount: the collection fee taken off,
// and/or the original delivery given back (whole order back for a fault).
function deliveryNote(money, k = kit('en')) {
  const { T, A } = k;
  const bits = [];
  if (money.delivery) bits.push(T('including your {amount} delivery', { amount: A(money.delivery) }));
  if (money.fee) bits.push(T('{amount} collection fee deducted', { amount: A(money.fee) }));
  return bits.length ? ` (${bits.join(k.ar ? '؛ ' : '; ')})` : '';
}

function returnRequested({ order, items, money, reasonLabel, lang }) {
  const k = kit(lang || langFor({ order }));
  const { T, A, I, p, heading, panel, itemsBlock, layout, orderKicker } = k;
  const inner =
    heading(T('Coming back'))
    + itemsBlock(items)
    + panel(T('Reason: {reason}', { reason: `<b>${esc(T(reasonLabel))}</b>` }) + '<br>'
      + T("If it's approved, our courier collects the item and, once they have it, {amount} goes back to your original payment method", { amount: `<b>${A(money.refund)}</b>` })
      + (money.fee ? T(' (a {fee} collection fee applies when you change your mind on an order of AED 200 and below, and is already deducted from that figure)', { fee: A(money.fee) }) : T(' — collection is free for this return'))
      + '. '
      + (money.delivery ? T('That figure includes your {amount} delivery, because the whole order is coming back with a fault.', { amount: A(money.delivery) }) : T('The original delivery fee is refunded only when the whole order comes back because it arrived faulty or damaged, was the wrong item or was not as described.')))
    + p(T('Nothing else to do for now — keep the item packed and ready in case the return is approved.'));
  return {
    subject: T("We've received your return request — order {id}", { id: I(order.public_id) }),
    html: layout(T('Your return request is in'), inner, {
      tone: 'clay',
      kicker: orderKicker(order.public_id),
      intro: T("We've received your return request for order {id} and our team is reviewing it now. You'll hear from us by email as soon as it's decided — usually within a couple of days.", { id: `<b>${esc(I(order.public_id))}</b>` }),
      preheader: T("Return request received for order {id} — we'll be in touch shortly.", { id: I(order.public_id) }),
    }),
  };
}

function returnApproved({ order, items, money, lang }) {
  const k = kit(lang || langFor({ order }));
  const { T, A, I, p, heading, panel, itemsBlock, layout, orderKicker, serif } = k;
  const inner =
    panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(money.refund)}</span><br>${T("will go back to your original payment method as soon as our courier has collected the item{note}. We'll email you the moment it's on its way.", { note: deliveryNote(money, k) })}`)
    + heading(T('Coming back'))
    + itemsBlock(items)
    + p(T('Our courier collection is booked and the courier will be in touch to arrange it — please keep the item packed and ready with any original packaging. What happens next: approved → collection booked → collected → refunded.'));
  return {
    subject: T('Your return is approved — collection booked for order {id}', { id: I(order.public_id) }),
    html: layout(T('Return approved'), inner, {
      kicker: orderKicker(order.public_id),
      intro: T('Good news — your return for order {id} is approved and the collection is booked.', { id: `<b>${esc(I(order.public_id))}</b>` }),
      preheader: T('Collection booked — {amount} comes back to you once the courier has the item.', { amount: A(money.refund) }),
    }),
  };
}

function returnDeclined({ order, items, declineReason, lang }) {
  const { T, I, p, panel, itemsBlock, layout, orderKicker } = kit(lang || langFor({ order }));
  const inner =
    itemsBlock(items)
    + panel(T('The reason from our team: {reason}', { reason: `<b>${esc(declineReason)}</b>` }))
    + p(T('The full request and this decision stay with the order in your account.'));
  return {
    subject: T('About your return request — order {id}', { id: I(order.public_id) }),
    html: layout(T('Your return request'), inner, {
      tone: 'clay',
      kicker: orderKicker(order.public_id),
      intro: T("We've reviewed your return request for order {id} and this time we can't accept it.", { id: `<b>${esc(I(order.public_id))}</b>` }),
      preheader: T('An update on your return request for order {id}.', { id: I(order.public_id) }),
    }),
  };
}

/* ---- order we couldn't complete ----
 * Sent when a payment succeeds but the order can't go ahead — a piece sold
 * out between checkout and payment (two buyers on the last one), or the
 * order had already expired. The full amount goes back automatically.
 * { order, items[{ name, qty, price_cents, meta, image }], soldOut:boolean }
 */
function orderUnavailable({ order, items, soldOut = true, lang }) {
  const { T, A, I, p, heading, panel, itemsBlock, button, layout, orderKicker, serif } = kit(lang || langFor({ order }));
  const inner =
    panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(order.total_cents)}</span><br>${T("is on its way back to your original payment method. Depending on your bank it can take 5–10 business days to appear. You haven't been charged for anything.")}`)
    + (items && items.length ? heading(soldOut ? T('No longer available') : T('Your order')) + itemsBlock(items) : '')
    + p(soldOut
      ? T('Most pieces on Trove are handmade in small numbers, and someone else checked out with the last one moments before your payment went through. We are sorry — the rest of your basket was not sent either, so nothing arrives half-complete.')
      : T('Your checkout was left open for longer than we can hold an order, so we could not complete it.'))
    + button(T('Back to the shop'), SITE_LINK);
  return {
    subject: T("We couldn't complete your Trove order {id} — full refund on its way", { id: I(order.public_id) }),
    html: layout(T("We couldn't complete your order"), inner, {
      tone: 'clay',
      kicker: orderKicker(order.public_id),
      intro: T("We're sorry — order {id} couldn't go ahead, so we have refunded it in full.", { id: `<b>${esc(I(order.public_id))}</b>` }),
      preheader: T('Order {id}: a full refund of {amount} is on its way.', { id: I(order.public_id), amount: A(order.total_cents) }),
    }),
  };
}

module.exports = { enabled, send, productImage, orderConfirmation, orderUnavailable, returnRequested, returnApproved, returnDeclined, langFor, kit, dayLabel, localLink, pieceName };

/* ---- return refunded (appended 2026-09-30) ----
 * Sent when the courier has collected a returned item (or Trove refunds it
 * early) and the card refund has gone out. Same { order, items, money }
 * shape as the other return templates.
 */
function returnRefunded({ order, items, money, lang }) {
  const k = kit(lang || langFor({ order }));
  const { T, A, I, p, heading, panel, itemsBlock, layout, orderKicker, serif } = k;
  const inner =
    panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(money.refund)}</span><br>${T('is on its way back to your original payment method{note}. Depending on your bank it can take 5–10 business days to appear.', { note: deliveryNote(money, k) })}`)
    + heading(T('Returned'))
    + itemsBlock(items)
    + p(T('Thank you for sending it back. The return and this refund stay with the order in your account.'));
  return {
    subject: T('Your refund is on its way — {amount} for order {id}', { amount: A(money.refund), id: I(order.public_id) }),
    html: layout(T('Refund on its way'), inner, {
      kicker: orderKicker(order.public_id),
      intro: T('We have your returned item from order {id}, so your refund has gone out.', { id: `<b>${esc(I(order.public_id))}</b>` }),
      preheader: T('{amount} is on its way back to you.', { amount: A(money.refund) }),
    }),
  };
}
module.exports.returnRefunded = returnRefunded;
/* ---- Services Marketplace bookings ----
 * Every template takes { booking, viewUrl, payUrl, commissionPercent } where
 * booking is a service_bookings row joined with provider_name. Guests have no
 * account, so customer emails carry the booking's private link (view + cancel)
 * instead of pointing to /account. The provider never gets the customer's
 * email; their mobile only once the booking is secured.
 * Customer emails follow the booking's language; provider emails the
 * provider account's (booking.provider_email, from the joined row).
 */
const PROVIDER_LINK = `${SITE_LINK}/provider`;
const firstName = (s) => esc(String(s || '').trim().split(/\s+/)[0] || '');
const customerLang = (bk, lang) => lang || langFor({ booking: bk });
const providerLang = (bk, lang) => lang || (bk && bk.provider_email ? langFor({ email: bk.provider_email }) : 'en');

function bookingRequestReceived({ booking: bk, viewUrl, lang }) {
  const { T, I, p, note, button, svcSummary, svcLayout, svcKicker } = kit(customerLang(bk, lang));
  const inner = svcSummary(bk)
    + p(bk.payment_method === 'trove'
      ? T('Nothing is charged yet. If {provider} accepts, they confirm the date and the final price, and we email you a secure link to pay Trove by card.', { provider: esc(bk.provider_name) })
      : T('If {provider} accepts, they will reach you on your mobile to arrange the details. You settle with them directly — Trove takes no part in that payment.', { provider: esc(bk.provider_name) }))
    + button(T('View or cancel your booking'), viewUrl)
    + note(T('Keep this email: the button above is your private link to this booking — no account needed.'));
  return {
    subject: T("We've sent your booking request — {code}", { code: I(bk.code) }),
    html: svcLayout('customer', T('Your request is on its way'), inner, {
      kicker: svcKicker(bk),
      intro: T("Thank you, {name}. Your request is with {provider} and we'll email you as soon as they reply.", { name: firstName(bk.name), provider: `<b>${esc(bk.provider_name)}</b>` }),
      preheader: T("Booking {code} is with {provider} — we'll let you know when they reply.", { code: I(bk.code), provider: bk.provider_name }),
    }),
  };
}

function bookingNewRequest({ booking: bk, commissionPercent, lang }) {
  const { T, p, note, panel, button, svcSummary, svcLayout, svcKicker } = kit(providerLang(bk, lang));
  const inner = svcSummary(bk)
    + (bk.notes ? panel(`<span style="color:${MUTED}">${T('Their brief')}</span><br>${esc(bk.notes)}`) : '')
    + p(bk.payment_method === 'trove'
      ? (bk.price_type === 'fixed'
        ? T("The customer wants to pay through Trove by card. When you confirm, you set the service date; the customer then pays Trove, and their mobile is released to you once the payment is in. Your fee is the amount paid minus Trove's {percent}% platform fee.", { percent: commissionPercent })
        : T("The customer wants to pay through Trove by card. When you confirm, you set the service date and the final price; the customer then pays Trove, and their mobile is released to you once the payment is in. Your fee is the amount paid minus Trove's {percent}% platform fee.", { percent: commissionPercent }))
      : T('The customer will settle directly with you. Confirm and their mobile is released to you so you can arrange the details.'))
    + button(T('Open your bookings'), PROVIDER_LINK)
    + note(T('Not one for you? Decline with a short note from your dashboard — there is no penalty.'));
  return {
    subject: T('New booking request — {title}', { title: bk.title }),
    html: svcLayout('provider', T('A new booking request'), inner, {
      kicker: svcKicker(bk), tone: 'clay',
      intro: T('{name} in {area} would like to book you.', { name: `<b>${esc(bk.name)}</b>`, area: esc(bk.area) }),
      preheader: T('{name} in {area} would like to book {title}.', { name: bk.name, area: bk.area, title: bk.title }),
    }),
  };
}

function bookingConfirmedPay({ booking: bk, payUrl, viewUrl, lang }) {
  const { T, A, I, L, p, note, panel, button, svcLayout, svcKicker, sdate, serif } = kit(customerLang(bk, lang));
  const inner = panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(bk.amount_cents)}</span><br>${T('to pay Trove by card for {title} with {provider} on {date}.', { title: esc(bk.title), provider: esc(bk.provider_name), date: `<b>${esc(sdate(bk.service_date))}</b>` })}`)
    + p(T("Your booking is secured once you pay, and {provider} then gets your mobile to arrange the details. For this booking Trove is your contracting party; if the service isn't delivered, you're refunded in full.", { provider: esc(bk.provider_name) }))
    + button(T('Pay securely'), payUrl)
    + note(T("Changed your mind, or the price isn't right? You can cancel instead — {link}.", { link: `<a href="${L(viewUrl)}" style="color:${INK}">${T('view your booking')}</a>` }));
  return {
    subject: T('Confirmed — pay to secure your booking {code}', { code: I(bk.code) }),
    html: svcLayout('customer', T('Your booking is confirmed'), inner, {
      kicker: svcKicker(bk),
      intro: T('Good news — {provider} has accepted your request. One step left: pay by card to secure it.', { provider: `<b>${esc(bk.provider_name)}</b>` }),
      preheader: T('{provider} accepted — pay {amount} to secure booking {code}.', { provider: bk.provider_name, amount: A(bk.amount_cents), code: I(bk.code) }),
    }),
  };
}

function bookingConfirmedDirect({ booking: bk, viewUrl, lang }) {
  const { T, I, p, button, svcSummary, svcLayout, svcKicker } = kit(customerLang(bk, lang));
  const inner = svcSummary(bk)
    + p(T('{provider} now has your mobile and will be in touch to arrange the time, place and final details. You settle with them directly, as you agree — Trove takes no part in that payment.', { provider: esc(bk.provider_name) }))
    + button(T('View your booking'), viewUrl);
  return {
    subject: T('Confirmed — your booking {code}', { code: I(bk.code) }),
    html: svcLayout('customer', T('Your booking is confirmed'), inner, {
      kicker: svcKicker(bk),
      intro: T('Good news — {provider} has accepted your request.', { provider: `<b>${esc(bk.provider_name)}</b>` }),
      preheader: T('{provider} accepted booking {code} and will be in touch.', { provider: bk.provider_name, code: I(bk.code) }),
    }),
  };
}

function bookingPaid({ booking: bk, viewUrl, lang }) {
  const { T, A, I, p, button, totals, totalRow, svcSummary, svcLayout, svcKicker } = kit(customerLang(bk, lang));
  const inner = totals([
    totalRow(bk.title, A(bk.amount_cents)),
    totalRow(T('Paid to Trove by card'), A(bk.amount_cents), true),
  ])
    + svcSummary(bk, { price: false, pay: false })
    + p(T("{provider} now has your mobile and will be in touch to arrange the details. If the service isn't delivered, Trove refunds you in full, and you can cancel for a full refund any time before the service day.", { provider: esc(bk.provider_name) }))
    + button(T('View your booking'), viewUrl);
  return {
    subject: T('Payment received — booking {code} is secured', { code: I(bk.code) }),
    html: svcLayout('customer', T('Payment received'), inner, {
      kicker: svcKicker(bk),
      intro: T("Thank you — we've received your payment of {amount} and your booking is secured.", { amount: `<b>${A(bk.amount_cents)}</b>` }),
      preheader: T('{amount} received — booking {code} is secured.', { amount: A(bk.amount_cents), code: I(bk.code) }),
    }),
  };
}

function bookingPaidProvider({ booking: bk, commissionPercent, lang }) {
  const { T, A, sdate, p, panel, button, svcSummary, svcLayout, svcKicker, serif } = kit(providerLang(bk, lang));
  const grace = require('./service-credits').GRACE_DAYS;
  const inner = panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(bk.provider_net_cents)}</span><br>${T("your fee after Trove's {percent}% platform fee (the customer paid {amount})", { percent: commissionPercent, amount: A(bk.amount_cents) })}`)
    + svcSummary(bk, { price: false, pay: false })
    + p(T("Paid through Trove. The customer's mobile is now in your dashboard — reach out to arrange the details. Your fee is paid by bank transfer from {payer} on Trove's behalf on the first fortnightly payout day once the service date has passed and the {grace}-day complaint window has closed — add your bank details under Payouts in your dashboard if you haven't yet.", { payer: esc(require('./service-credits').payerName()), grace }))
    + button(T('Open your bookings'), PROVIDER_LINK);
  return {
    subject: bk.service_date ? T('Paid through Trove — {title} on {date}', { title: bk.title, date: sdate(bk.service_date) }) : T('Paid through Trove — {title}', { title: bk.title }),
    html: svcLayout('provider', T('The booking is paid'), inner, {
      kicker: svcKicker(bk),
      intro: T("{name} has paid for the booking, so it's secured.", { name: `<b>${esc(bk.name)}</b>` }),
      preheader: T('Paid through Trove — your fee {amount} after {percent}%.', { amount: A(bk.provider_net_cents), percent: commissionPercent }),
    }),
  };
}

/** Declined by the provider, or cancelled by anyone — to the customer. */
function bookingCancelled({ booking: bk, kind, refunded, by, lang }) {
  const { T, A, I, p, panel, button, svcSummary, svcLayout, svcKicker, serif } = kit(customerLang(bk, lang));
  const declined = kind === 'declined';
  const money = bk.paid_at
    ? (refunded || bk.refunded_at
      ? panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(bk.amount_cents)}</span><br>${T('is on its way back to your card in full. Depending on your bank it can take 5–10 business days to appear.')}`)
      : panel(T('You paid for this booking, so our team will refund you in full — you will get an email when it is done.')))
    : (bk.payment_method === 'trove' ? p(T('Nothing was charged.')) : '');
  const reason = bk.decline_reason ? panel(`${declined ? T('Their note') : T('The reason given')}: <b>${esc(bk.decline_reason)}</b>`) : '';
  const inner = svcSummary(bk, { pay: false }) + reason + money
    + button(T('Find another service'), `${SITE_LINK}/services`);
  const title = declined ? T('About your booking request') : T('Your booking is cancelled');
  const intro = declined
    ? T("We're sorry — {provider} can't take this booking.", { provider: `<b>${esc(bk.provider_name)}</b>` })
    : by === 'customer' ? T('As you asked, we have cancelled your booking.')
      : by === 'provider' ? T("We're sorry — this booking has been cancelled by {provider}.", { provider: esc(bk.provider_name) })
        : T("We're sorry — this booking has been cancelled.");
  return {
    subject: declined ? T('About your booking request {code}', { code: I(bk.code) }) : T('Booking {code} is cancelled', { code: I(bk.code) }),
    html: svcLayout('customer', title, inner, { kicker: svcKicker(bk), tone: 'clay', intro, preheader: T('An update on booking {code}.', { code: I(bk.code) }) }),
  };
}

function bookingCancelledProvider({ booking: bk, lang }) {
  const { T, I, p, button, svcSummary, svcLayout, svcKicker } = kit(providerLang(bk, lang));
  const inner = svcSummary(bk, { pay: false })
    + p(bk.paid_at ? T('The customer has been refunded in full, so no fee is due on this booking.') : T('Nothing further to do.'))
    + button(T('Open your bookings'), PROVIDER_LINK);
  return {
    subject: T('Booking {code} was cancelled', { code: I(bk.code) }),
    html: svcLayout('provider', T('A booking was cancelled'), inner, {
      kicker: svcKicker(bk), tone: 'clay',
      intro: T("{name}'s booking for {title} has been cancelled.", { name: `<b>${esc(bk.name)}</b>`, title: esc(bk.title) }),
      preheader: T('Booking {code} was cancelled.', { code: I(bk.code) }),
    }),
  };
}

function bookingRefunded({ booking: bk, lang }) {
  const { T, A, I, panel, svcSummary, svcLayout, svcKicker, serif } = kit(customerLang(bk, lang));
  const inner = panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(bk.refund_cents || bk.amount_cents)}</span><br>${T('is on its way back to your card. Depending on your bank it can take 5–10 business days to appear.')}`)
    + svcSummary(bk, { price: false, pay: false });
  return {
    subject: T('Refund on its way — booking {code}', { code: I(bk.code) }),
    html: svcLayout('customer', T('Your refund is on its way'), inner, {
      kicker: svcKicker(bk), tone: 'clay',
      intro: T("We've refunded your payment for booking {code} in full.", { code: `<b>${esc(I(bk.code))}</b>` }),
      preheader: T('A full refund for booking {code} is on its way.', { code: I(bk.code) }),
    }),
  };
}

module.exports.bookingRequestReceived = bookingRequestReceived;
module.exports.bookingNewRequest = bookingNewRequest;
module.exports.bookingConfirmedPay = bookingConfirmedPay;
module.exports.bookingConfirmedDirect = bookingConfirmedDirect;
module.exports.bookingPaid = bookingPaid;
module.exports.bookingPaidProvider = bookingPaidProvider;
module.exports.bookingCancelled = bookingCancelled;
module.exports.bookingCancelledProvider = bookingCancelledProvider;
module.exports.bookingRefunded = bookingRefunded;

/* ======================================================================
 * Account + partner emails (2026-09-30). Same shell as the receipts; each
 * template takes plain data plus the absolute link(s) it needs (and the
 * recipient's `lang`), and returns { subject, html }. Callers send them
 * fire-and-forget via send().
 * ==================================================================== */
const ADMIN_REASON = 'You are receiving this because you look after Trove.';
const firstNameOr = (name, T) => esc(String(name || '').trim().split(/\s+/)[0] || T('there'));

/** Password reset: a one-hour, single-use link. */
function passwordReset({ name, link, lang }) {
  const { T, p, note, button, layout } = kit(lang);
  const inner =
    p(T('Someone — hopefully you — asked to reset the password for your Trove account. Use the button below to choose a new one.'))
    + button(T('Choose a new password'), esc(link))
    + note(T('The link works once and expires in an hour. If you did not ask for this, you can ignore this email — your password stays as it is.'));
  return {
    subject: T('Reset your Trove password'),
    html: layout(T('Reset your password'), inner, {
      tone: 'clay', intro: T('Hello {name},', { name: firstNameOr(name, T) }), reason: T("You're receiving this because of your Trove account."),
      preheader: T('Your link to choose a new Trove password — it expires in an hour.'),
    }),
  };
}

/** Welcome + confirm your email. Shopping never waits on the click. */
function welcomeVerify({ name, link, lang }) {
  const { T, p, note, button, layout } = kit(lang);
  const inner =
    p(T('Thank you for joining Trove — a curated home for pieces made by independent makers in Dubai and Abu Dhabi.'))
    + p(T('Please confirm this is your email address, so we can reach you about your orders and help you back into your account if you ever forget your password.'))
    + button(T('Confirm my email'), esc(link))
    + note(T('You can shop straight away — confirming just keeps your account safe. The link expires in 7 days.'));
  return {
    subject: T('Welcome to Trove — please confirm your email'),
    html: layout(T('Welcome to Trove'), inner, {
      intro: T('Hello {name},', { name: firstNameOr(name, T) }), reason: T("You're receiving this because of your Trove account."),
      preheader: T('Confirm your email address to keep your Trove account safe.'),
    }),
  };
}

/** Sent after any password change, so an owner notices one they did not make. */
function passwordChanged({ name, link, lang }) {
  const { T, L, p, layout } = kit(lang);
  const inner =
    p(T('The password for your Trove account has just been changed, and every other device has been signed out.'))
    + p(T('If this was you, there is nothing else to do. If it was not, {link} straight away.', { link: `<a href="${esc(L(link))}" style="color:${INK};font-weight:700">${T('reset your password')}</a>` }));
  return {
    subject: T('Your Trove password was changed'),
    html: layout(T('Password changed'), inner, { tone: 'clay', intro: T('Hello {name},', { name: firstNameOr(name, T) }), reason: T("You're receiving this because of your Trove account."), preheader: T('Your Trove password was just changed.') }),
  };
}

/**
 * Sent whenever the bank account Trove pays a maker or provider is changed,
 * so an owner notices a change they did not make. Only the masked IBAN.
 * { name, businessName, kind: 'shop' | 'provider', bankName, iban (masked), link }
 */
function bankDetailsChanged({ name, businessName, kind = 'shop', bankName, iban, link, held = true, lang }) {
  const { T, I, L, p, panel, layout } = kit(lang);
  const what = kind === 'provider' ? T('your service fees') : T('your sales');
  const inner =
    panel(`<b>${esc(businessName)}</b><br>${T('Payout account: {bank} · {iban}', { bank: esc(bankName), iban: esc(I(iban)) })}`)
    + p(held
      ? T('The bank account Trove pays {what} into has just been changed. For your protection, the next payment to the new account waits until Trove has checked the change.', { what })
      : T('The bank account Trove pays {what} into has just been saved.', { what }))
    + p(T('If this was you, there is nothing else to do. If it was not, reply to this email straight away and {link} — nothing will be paid to the new account until we hear from you.', { link: `<a href="${esc(L(link))}" style="color:${INK};font-weight:700">${T('reset your password')}</a>` }));
  return {
    subject: held ? T('Your Trove payout bank details were changed') : T('Your Trove payout bank details were saved'),
    html: layout(held ? T('Bank details changed') : T('Bank details saved'), inner, { tone: 'clay', intro: T('Hello {name},', { name: firstNameOr(name, T) }), reason: T("You're receiving this because of your Trove account."), preheader: T('The bank account Trove pays you was just updated.') }),
  };
}

/* ---- maker (shop) and provider applications ---- */
const KIND = { shop: { what: 'shop' }, provider: { what: 'services practice' } };

/** To the applicant, the moment an application lands. kind = shop | provider. */
function applicationReceived({ kind = 'shop', name, businessName, link, lang }) {
  const { T, p, panel, button, layout } = kit(lang);
  const inner =
    panel(`<b>${esc(businessName)}</b><br>${T('Application received · under review')}`)
    + p(T("Our curation team looks at every application by hand, so it can take a few days. You'll hear from us by email as soon as there is a decision."))
    + p(kind === 'shop'
      ? T('Meanwhile you can sign in and get your shop ready — add your pieces, photos and pickup address — so it can go on sale the moment it is approved.')
      : T('Meanwhile you can sign in and prepare your listings, so they can go live the moment your practice is approved.'))
    + button(kind === 'shop' ? T('Open your dashboard') : T('Open your services dashboard'), esc(link));
  return {
    subject: kind === 'shop' ? T('We have your Trove shop application') : T('We have your Trove services application'),
    html: layout(T('Thank you for applying'), inner, {
      intro: kind === 'shop'
        ? T('Hello {name}, thank you for applying to open a shop on Trove.', { name: firstNameOr(name, T) })
        : T('Hello {name}, thank you for applying to open a services practice on Trove.', { name: firstNameOr(name, T) }),
      reason: T("You're receiving this because you applied to sell or offer services on Trove."),
      preheader: T('Your application for {business} is with our curation team.', { business: businessName }),
    }),
  };
}

/** To Trove's admin: a new application is waiting. Contact details stay in the admin panel. Always English. */
function applicationAlert({ kind = 'shop', businessName, applicantName, location, category, link }) {
  const { panel, button, layout } = kit('en');
  const k = KIND[kind] || KIND.shop;
  const inner =
    panel(`<b>${esc(businessName)}</b><br>${esc(applicantName)}${location ? ' · ' + esc(location) : ''}${category ? '<br>' + esc(category) : ''}`)
    + button('Review in the admin panel', esc(link));
  return {
    subject: `New ${k.what} application: ${String(businessName).slice(0, 80)}`,
    html: layout(`New ${k.what} application`, inner, { reason: ADMIN_REASON, preheader: `${businessName} applied to Trove.` }),
  };
}

/** Application approved. */
function applicationApproved({ kind = 'shop', name, businessName, link, lang }) {
  const { T, p, button, layout } = kit(lang);
  const inner = kind === 'shop'
    ? p(T('{business} is approved, and any piece you have marked live is now on sale on Trove.', { business: `<b>${esc(businessName)}</b>` }))
      + p(T('When a piece sells we email you, and it appears in your dashboard with everything you need to pack it. Our courier collects from your pickup address — please make sure it and your pickup phone are filled in under Storefront.'))
      + button(T('Go to your dashboard'), esc(link))
    : p(T('{business} is approved, and your live services now appear in the Trove Services Marketplace.', { business: `<b>${esc(businessName)}</b>` }))
      + p(T('Booking requests arrive in your services dashboard.'))
      + button(T('Go to your services dashboard'), esc(link));
  const short = String(businessName).slice(0, 80);
  return {
    subject: kind === 'shop' ? T('Welcome to Trove — {business} is approved', { business: short }) : T("You're approved on Trove Services — {business}", { business: short }),
    html: layout(T("You're approved"), inner, { intro: T('Congratulations, {name}.', { name: firstNameOr(name, T) }), reason: T("You're receiving this because you applied to sell or offer services on Trove."), preheader: T('{business} is approved on Trove.', { business: businessName }) }),
  };
}

/** Application not accepted — polite, with the admin's note when there is one. */
function applicationRejected({ kind = 'shop', name, businessName, adminNote = '', link, lang }) {
  const { T, p, panel, button, layout } = kit(lang);
  const inner =
    p(kind === 'shop'
      ? T('Thank you for applying to open a shop on Trove, and for sharing your work with us. We read every application carefully, and this time we are not able to accept {business}.', { business: `<b>${esc(businessName)}</b>` })
      : T('Thank you for applying to open a services practice on Trove, and for sharing your work with us. We read every application carefully, and this time we are not able to accept {business}.', { business: `<b>${esc(businessName)}</b>` }))
    + (adminNote ? panel(`${T('A note from our curation team:')}<br><b>${esc(adminNote)}</b>`) : '')
    + p(T('This is often about fit with what we are curating right now rather than the quality of your work. You are welcome to apply again in the future.'))
    + button(T('Visit Trove'), esc(link));
  return {
    subject: T('About your Trove application — {business}', { business: String(businessName).slice(0, 80) }),
    html: layout(T('About your application'), inner, { tone: 'clay', intro: T('Hello {name},', { name: firstNameOr(name, T) }), reason: T("You're receiving this because you applied to sell or offer services on Trove."), preheader: T('An update on your application for {business}.', { business: businessName }) }),
  };
}

/**
 * New order to pack — to the shop owner, listing ONLY their pieces. By design
 * it carries no buyer email, phone or address: Trove books the courier, which
 * holds the delivery details itself.
 * { shopName, ownerName, publicId, items[{ name, qty, price_cents, meta, image }], packBy, link, lang }
 * packBy is the concrete day ('Friday 2 October', or its Arabic): the day the
 * order was paid plus the longest make/pack time among THIS shop's pieces.
 */
function orderToPack({ shopName, ownerName, publicId, items, packBy, link, lang }) {
  const { T, TN, I, note, heading, panel, button, itemsBlock, layout, orderKicker } = kit(lang);
  const units = items.reduce((t, i) => t + i.qty, 0);
  const inner =
    heading(units > 1 ? T('Pieces to pack') : T('Piece to pack'))
    + itemsBlock(items)
    + panel(units > 1
      ? T('{packBy} in your own packaging, then tap {packed} on the order in your dashboard. That date comes from the make and pack time you set on these pieces, and it is the time the buyer was shown. Our courier collects from your pickup address and takes it on to the buyer.', { packBy: `<b>${T('Please pack by {day}', { day: esc(packBy) })}</b>`, packed: `<b>${T('Packed · ready for collection')}</b>` })
      : T('{packBy} in your own packaging, then tap {packed} on the order in your dashboard. That date comes from the make and pack time you set on this piece, and it is the time the buyer was shown. Our courier collects from your pickup address and takes it on to the buyer.', { packBy: `<b>${T('Please pack by {day}', { day: esc(packBy) })}</b>`, packed: `<b>${T('Packed · ready for collection')}</b>` }))
    + button(T('Open the order'), esc(link))
    + note(T('Trove arranges the courier and looks after the customer, so there is nobody to contact — everything you need is on the order.'));
  return {
    subject: T('New order to pack — {id}', { id: I(publicId) }),
    html: layout(T('You have a new order'), inner, {
      kicker: orderKicker(publicId, ` · ${esc(shopName)}`),
      intro: units > 1
        ? T('Good news, {name} — {pieces} from your shop just sold.', { name: firstNameOr(ownerName, T), pieces: TN(units, '{n} piece', '{n} pieces') })
        : T('Good news, {name} — a piece from your shop just sold.', { name: firstNameOr(ownerName, T) }),
      reason: T("You're receiving this because you sell on Trove."),
      preheader: T('Order {id}: please pack by {day}.', { id: I(publicId), day: packBy }),
    }),
  };
}

/**
 * Pack-by reminder — to the maker, once, when the pack-by day has gone and
 * the parcel is not yet marked Packed. Like the new-order email it carries
 * nothing about the buyer.
 * { shopName, ownerName, publicId, items[{ name, qty }], packBy, link, lang }
 */
function packReminder({ shopName, ownerName, publicId, items, packBy, link, lang }) {
  const k = kit(lang);
  const { T, I, p, panel, button, layout, orderKicker } = k;
  const list = items.map((i) => `${esc(pieceName(k.lang, i.name))}${i.qty > 1 ? ' ×' + i.qty : ''}`).join(k.ar ? '، ' : ', ');
  const inner =
    panel(T('Order {id} was due to be packed by {day}: {list}.', { id: `<b>${esc(I(publicId))}</b>`, day: `<b>${esc(packBy)}</b>`, list }))
    + p(T('If it is ready, tap {packed} on the order so our courier can come for it. If it needs a little longer, let us know through the Contact page on troveathome.com when it will be ready, so we can keep the buyer in the picture.', { packed: `<b>${T('Packed · ready for collection')}</b>` }))
    + button(T('Open the order'), esc(link));
  return {
    subject: T('Reminder: order {id} is due to be packed', { id: I(publicId) }),
    html: layout(T('A parcel is waiting to be packed'), inner, {
      tone: 'clay',
      kicker: orderKicker(publicId, ` · ${esc(shopName)}`),
      intro: T('Hello {name}, a quick nudge about an order from your shop.', { name: firstNameOr(ownerName, T) }),
      reason: T("You're receiving this because you sell on Trove."),
      preheader: T('Order {id} was due to be packed by {day}.', { id: I(publicId), day: packBy }),
    }),
  };
}

/**
 * To Trove's admin, once, when a parcel is two days past its pack-by day and
 * still not marked Packed — time to call the maker and update the buyer.
 * Always English. { shopName, publicId, items[{ name, qty }], packBy, link }
 */
function packOverdueAdmin({ shopName, publicId, items, packBy, link }) {
  const { p, panel, button, layout } = kit('en');
  const list = items.map((i) => `${esc(i.name)}${i.qty > 1 ? ' ×' + i.qty : ''}`).join(', ');
  const inner =
    panel(`<b>${esc(shopName)}</b> was due to pack order <b>${esc(publicId)}</b> by <b>${esc(packBy)}</b> and has not marked it Packed. The maker was reminded when the day passed.<br>${list}`)
    + p('Worth a call to the maker, and a note to the buyer if the parcel will be late.')
    + button('Open the admin', esc(link));
  return {
    subject: `Overdue: ${shopName} has not packed order ${publicId}`,
    html: layout('A parcel is two days late', inner, {
      tone: 'clay',
      kicker: `Order <b style="color:${INK}">${esc(publicId)}</b>`,
      reason: "You're receiving this because you run Trove.",
      preheader: `${shopName}: order ${publicId} was due to be packed by ${packBy}.`,
    }),
  };
}

/** The admin's second sign-in step: a 6-digit code, valid for a few minutes. Always English. */
function adminSignInCode({ name, code, minutes = 10 }) {
  const { p, note, panel, layout } = kit('en');
  const inner =
    p('Here is the code to finish signing in to the Trove admin:')
    + panel(`<span style="font-family:${SERIF};font-size:34px;font-weight:600;letter-spacing:6px">${esc(code)}</span>`)
    + note(`It works once and expires in ${esc(minutes)} minutes. If you did not just sign in, someone may know your password — reset it from the sign-in page straight away.`);
  return {
    subject: `${code} is your Trove admin sign-in code`,
    html: layout('Your sign-in code', inner, { tone: 'clay', intro: `Hello ${esc(String(name || '').trim().split(/\s+/)[0] || 'there')},`, reason: "You're receiving this because of your Trove account.", preheader: 'Your Trove admin sign-in code.' }),
  };
}

/**
 * To a maker whose Emirates ID is about to expire (or has): Trove can only
 * pay makers whose ID is current, so they update it under Payouts.
 */
function idExpiring({ name, shopName, expiry, expired, link, lang }) {
  const { T, p, button, layout } = kit(lang);
  const inner =
    p(expired
      ? T('The Emirates ID we have on file for {shop} expired on {date}. We can only pay makers whose ID is current, so your payments are on hold until you add your renewed ID.', { shop: `<b>${esc(shopName)}</b>`, date: `<b>${esc(expiry)}</b>` })
      : T('The Emirates ID we have on file for {shop} expires on {date}. Please add your renewed ID before then, so your fortnightly payments carry on without a pause.', { shop: `<b>${esc(shopName)}</b>`, date: `<b>${esc(expiry)}</b>` }))
    + p(T('Open Payouts in your dashboard and update your Emirates ID details and photos. Your bank details stay as they are.'))
    + button(T('Update my Emirates ID'), esc(link));
  return {
    subject: expired ? T('Your Emirates ID on Trove has expired') : T('Your Emirates ID on Trove expires soon'),
    html: layout(expired ? T('Your ID has expired') : T('Your ID expires soon'), inner, {
      tone: 'clay', intro: T('Hello {name},', { name: firstNameOr(name, T) }), reason: T("You're receiving this because you sell on Trove."),
      preheader: expired ? T('Payments are on hold until you add your renewed Emirates ID.') : T('Your Emirates ID expires on {date}.', { date: expiry }),
    }),
  };
}

Object.assign(module.exports, {
  adminSignInCode, idExpiring,
  packReminder, packOverdueAdmin,
  passwordReset, welcomeVerify, passwordChanged, bankDetailsChanged,
  applicationReceived, applicationAlert, applicationApproved, applicationRejected, orderToPack,
});

/**
 * Payment note — to a service provider once admin has marked their batch
 * of fees paid. Only what the provider already knows: booking codes, services,
 * dates and their own fees. Never anything about the customer.
 * { providerName, ownerName, amountCents, reference, payer, bookings[{ code, title, serviceDate, netCents }], debitCents, lang }
 */
function providerFeesSent({ providerName, ownerName, amountCents, reference, payer, bookings = [], debitCents = 0, lang }) {
  const { T, A, I, sdate, p, note, label, panel, button, totals, totalRow, svcLayout, serif } = kit(lang);
  const rows = bookings.map((b) => totalRow(`${b.code} · ${b.title}${b.serviceDate ? ` · ${sdate(b.serviceDate)}` : ''}`, A(b.netCents)));
  if (debitCents) rows.push(totalRow(T('Less a fee already paid on a booking later refunded'), `−${A(-debitCents)}`));
  rows.push(totalRow(T('Total sent'), A(amountCents), true));
  const inner = panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(amountCents)}</span><br>${T('reference {ref}', { ref: `<b>${esc(I(reference))}</b>` })}`)
    + label(bookings.length === 1 ? T('The booking covered') : T('The bookings covered'))
    + totals(rows)
    + p(T("This payment was sent from {payer} on Trove's behalf, so look for that name on your bank statement. Please allow 1–2 working days for it to arrive.", { payer: `<b>${esc(payer)}</b>` }))
    + button(T('Open your payouts'), PROVIDER_LINK)
    + note(T('Your dashboard lists every fee and when it was paid.'));
  return {
    subject: T('Your Trove fees are on their way — {amount}', { amount: A(amountCents) }),
    html: svcLayout('provider', T('Your fees are on their way'), inner, {
      kicker: T('Payment reference {ref}', { ref: `<b style="color:${INK}">${esc(I(reference))}</b>` }),
      intro: T("Hello {name}, we've sent your fees for {provider} by bank transfer.", { name: firstNameOr(ownerName, T), provider: esc(providerName) }),
      preheader: T("{amount} sent from {payer} on Trove's behalf — reference {ref}.", { amount: A(amountCents), payer, ref: I(reference) }),
    }),
  };
}

module.exports.providerFeesSent = providerFeesSent;

/**
 * Payment note — to a maker once admin has marked their fortnightly
 * settlement paid. The purchase note with every order lives in their dashboard.
 * { shopName, ownerName, amountCents, reference, runDate, payer, link, lang }
 */
function makerPaymentSent({ shopName, ownerName, amountCents, reference, runDate, payer, link, lang }) {
  const { T, A, I, p, note, panel, button, layout, serif } = kit(lang);
  const inner = panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(amountCents)}</span><br>${T('reference {ref}', { ref: `<b>${esc(I(reference))}</b>` })}`)
    + p(T('This is your payment for {shop} from the settlement run of {date}: every piece whose 15-day return window had closed.', { shop: `<b>${esc(shopName)}</b>`, date: esc(I(runDate)) }))
    + p(T("This payment was sent from {payer} on Trove's behalf, so look for that name on your bank statement. Please allow 1–2 working days for it to arrive.", { payer: `<b>${esc(payer)}</b>` }))
    + button(T('Open your payments'), esc(link))
    + note(T('Your dashboard has the purchase note listing every order in this payment.'));
  return {
    subject: T('Your Trove payment is on its way — {amount}', { amount: A(amountCents) }),
    html: layout(T('Your payment is on its way'), inner, {
      tone: 'sage',
      kicker: T('Payment reference {ref}', { ref: `<b style="color:${INK}">${esc(I(reference))}</b>` }),
      intro: T("Hello {name}, we've sent your payment by bank transfer.", { name: firstNameOr(ownerName, T) }),
      reason: T("You're receiving this because you sell on Trove."),
      preheader: T("{amount} sent from {payer} on Trove's behalf — reference {ref}.", { amount: A(amountCents), payer, ref: I(reference) }),
    }),
  };
}
module.exports.makerPaymentSent = makerPaymentSent;

/* ---- operations alerts + cancellations (fix round 2026-10-02) ---- */

/**
 * A plain alert to the person who runs Trove: something needs a human (a
 * courier booking failed, a parcel is lost, a card dispute arrived…).
 * Always English. { subject, title, lines: [plain text — escaped here], link, cta, kicker }
 */
function adminAlert({ subject, title, lines = [], link, cta = 'Open the admin', kicker = '' }) {
  const { panel, button, layout } = kit('en');
  const inner = panel(lines.map((l) => esc(l)).join('<br>'))
    + (link ? button(esc(cta), esc(link)) : '');
  return {
    subject,
    html: layout(title || subject, inner, {
      tone: 'clay',
      kicker: kicker ? esc(kicker) : '',
      reason: "You're receiving this because you run Trove.",
      preheader: lines[0] ? String(lines[0]).slice(0, 140) : subject,
    }),
  };
}

/**
 * Part (or all) of an order cancelled before dispatch — to the buyer.
 * { order, items[{ name, qty, price_cents, image }], money: { items, delivery, refund }, whole }
 */
function itemsCancelled({ order, items, money, whole = false, lang }) {
  const { T, A, I, p, heading, panel, itemsBlock, layout, orderKicker, serif } = kit(lang || langFor({ order }));
  const many = items.reduce((t, i) => t + i.qty, 0) > 1;
  const inner =
    panel(`<span style="font-family:${serif};font-size:26px;font-weight:600">${A(money.refund)}</span><br>${money.delivery
      ? T('is on its way back to your original payment method (including your {amount} delivery). Depending on your bank it can take 5–10 business days to appear.', { amount: A(money.delivery) })
      : T('is on its way back to your original payment method. Depending on your bank it can take 5–10 business days to appear.')}`)
    + heading(whole ? T('Cancelled') : T('Cancelled from your order'))
    + itemsBlock(items)
    + p(whole
      ? T('Nothing from this order will be delivered, and you have not been charged for any of it.')
      : T('Everything else on your order is still on its way, and your account shows where each parcel is.'));
  const id = `<b>${esc(I(order.public_id))}</b>`;
  return {
    subject: whole
      ? T('Your order {id} is cancelled — {amount} refunded', { id: I(order.public_id), amount: A(money.refund) })
      : T('Part of your order {id} is cancelled — {amount} refunded', { id: I(order.public_id), amount: A(money.refund) }),
    html: layout(whole ? T('Your order is cancelled') : T('Part of your order is cancelled'), inner, {
      tone: 'clay',
      kicker: orderKicker(order.public_id),
      intro: whole
        ? T("We've cancelled order {id} before it was sent and refunded you in full.", { id })
        : many
          ? T("We've cancelled some pieces from order {id} before they were sent, and refunded them.", { id })
          : T("We've cancelled a piece from order {id} before it was sent, and refunded it.", { id }),
      preheader: T('{amount} is on its way back to you.', { amount: A(money.refund) }),
    }),
  };
}

/**
 * To the maker: pieces from their parcel are cancelled (or the whole parcel
 * was refunded) — leave them out / do not hand the parcel to a courier.
 * { shopName, ownerName, publicId, items[{ name, qty }], whole, link, lang }
 */
function parcelCancelledMaker({ shopName, ownerName, publicId, items = [], whole = false, link, lang }) {
  const k = kit(lang);
  const { T, I, p, panel, button, layout, orderKicker } = k;
  const list = items.map((i) => `${esc(pieceName(k.lang, i.name))}${i.qty > 1 ? ' ×' + i.qty : ''}`).join('<br>');
  const inner =
    panel(whole
      ? `<b>${T('Please do not hand this parcel to a courier.')}</b> ${list
        ? T('Your part of order {id} was cancelled and refunded, so nothing from your shop goes out on it:', { id: esc(I(publicId)) }) + `<br>${list}`
        : T('Your part of order {id} was cancelled and refunded, so nothing from your shop goes out on it.', { id: esc(I(publicId)) })}`
      : `<b>${T('Please leave these out of the parcel:')}</b><br>${list}<br>${T('Everything else on the order still goes out as normal.')}`)
    + p(T('If a courier arrives for a parcel that is cancelled, please send them away and let us know. Nothing is paid out for cancelled pieces.'))
    + button(T('Open the order'), esc(link));
  return {
    subject: whole ? T('Order {id} cancelled — please do not send it', { id: I(publicId) }) : T('Order {id}: pieces cancelled — leave them out', { id: I(publicId) }),
    html: layout(whole ? T('This order is cancelled') : T('Pieces cancelled from an order'), inner, {
      tone: 'clay',
      kicker: orderKicker(publicId, ` · ${esc(shopName)}`),
      intro: whole
        ? T('Hello {name}, Trove has cancelled your part of this order before it was sent.', { name: firstNameOr(ownerName, T) })
        : T('Hello {name}, Trove has cancelled part of this order before it was sent.', { name: firstNameOr(ownerName, T) }),
      reason: T("You're receiving this because you sell on Trove."),
      preheader: whole ? T('Order {id} was refunded — do not hand it to the courier.', { id: I(publicId) }) : T('Order {id}: some pieces are cancelled.', { id: I(publicId) }),
    }),
  };
}

Object.assign(module.exports, { adminAlert, itemsCancelled, parcelCancelledMaker });
