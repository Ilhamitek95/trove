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
 */

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

function thumb(item) {
  if (item.image) {
    return `<img src="${esc(item.image)}" width="72" height="72" alt="${esc(item.name)}" style="display:block;width:72px;height:72px;border:0;border-radius:12px;object-fit:cover;background:#F2E9E4">`;
  }
  let h = 7;
  for (const ch of String(item.name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="72" height="72" align="center" valign="middle"
    style="width:72px;height:72px;border-radius:12px;background:${TILE[h % TILE.length]};font-family:${SERIF};font-size:30px;font-weight:500;color:${INK}">${esc(String(item.name || '·').trim().charAt(0).toUpperCase())}</td></tr></table>`;
}

const p = (s) => `<p style="margin:14px 0;font-family:${SANS};font-size:15px;line-height:1.65;color:${INK}">${s}</p>`;
const note = (s) => `<p style="margin:18px 0 0;text-align:center;font-family:${SANS};font-size:13.5px;line-height:1.6;color:${MUTED}">${s}</p>`;
const label = (s) => `<div style="font-family:${SANS};font-size:12.5px;color:${MUTED};padding-bottom:6px">${s}</div>`;
const heading = (s) => `<div style="font-family:${SERIF};font-size:22px;font-weight:600;color:${INK};padding:30px 0 4px">${s}</div>`;
/** A soft cream panel for the one number or fact the email is about. */
const panel = (html) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0"><tr>
  <td style="background:${CREAM};border:1px solid ${LINE};border-radius:14px;padding:16px 20px;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK}">${html}</td></tr></table>`;

function button(text, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:30px auto 6px"><tr>
    <td style="background:${INK};border-radius:999px"><a href="${href}" style="display:inline-block;padding:14px 32px;font-family:${SANS};font-size:15px;font-weight:700;color:${CREAM};text-decoration:none;border-radius:999px">${text}</a></td>
  </tr></table>`;
}

/** One row per piece: picture, name + chosen options, quantity, line price. */
function itemRow(i) {
  const each = i.qty > 1 ? ` · ${aed(i.price_cents)} each` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${LINE}"><tr>
    <td width="72" valign="top" style="padding:14px 16px 14px 0">${thumb(i)}</td>
    <td valign="top" style="padding:16px 0;font-family:${SANS};color:${INK}">
      <div style="font-size:15px;font-weight:700;line-height:1.35">${esc(i.name)}</div>
      ${i.meta ? `<div style="font-size:13px;line-height:1.5;color:${MUTED};padding-top:3px">${esc(i.meta)}</div>` : ''}
      <div style="font-size:13px;color:${MUTED};padding-top:3px">Qty ${i.qty}${each}</div>
    </td>
    <td valign="top" align="right" style="padding:16px 0 16px 12px;font-family:${SANS};font-size:15px;font-weight:700;color:${INK};white-space:nowrap">${aed(i.price_cents * i.qty)}</td>
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
  return groups.map((g, n) => `<div style="font-family:${SANS};font-size:13px;color:${MUTED};padding:${n ? 22 : 10}px 0 0">
      Parcel ${n + 1} of ${groups.length} · packed by <b style="color:${INK}">${esc(g.shop)}</b></div>${itemsBlock(g.items)}`).join('');
}

const totalRow = (name, value, bold) => `<tr>
  <td style="padding:${bold ? '12px 0 0' : '4px 0'};font-family:${SANS};font-size:${bold ? 17 : 14.5}px;${bold ? `font-weight:700;color:${INK};border-top:1px solid ${LINE}` : `color:${MUTED}`}">${esc(name)}</td>
  <td align="right" style="padding:${bold ? '12px 0 0' : '4px 0'};font-family:${SANS};font-size:${bold ? 17 : 14.5}px;${bold ? `font-weight:700;color:${INK};border-top:1px solid ${LINE}` : `color:${INK}`}">${value}</td></tr>`;
const totals = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0">${rows.join('')}</table>`;

/** Confirmed → Packed → On its way → Delivered, with the first `done` steps filled. */
function tracker(done) {
  const steps = ['Confirmed', 'Packed', 'On its way', 'Delivered'];
  const on = (i) => i < done;
  const bar = (lit, hidden) => `<div style="height:2px;line-height:2px;font-size:0;background:${hidden ? 'transparent' : lit ? INK : '#E6D9D2'}">&nbsp;</div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 4px"><tr>
    ${steps.map((s, i) => `<td width="25%" valign="top" align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="50%" valign="middle">${bar(on(i), i === 0)}</td>
        <td valign="middle"><div style="width:12px;height:12px;border-radius:12px;background:${on(i) ? INK : '#FFFFFF'};border:2px solid ${on(i) ? INK : '#DBC7BD'}"></div></td>
        <td width="50%" valign="middle">${bar(on(i + 1), i === steps.length - 1)}</td>
      </tr></table>
      <div style="font-family:${SANS};font-size:12px;padding-top:8px;color:${on(i) ? INK : MUTED};font-weight:${on(i) ? 700 : 500}">${s}</div>
    </td>`).join('')}
  </tr></table>`;
}

/**
 * The shell every email shares: wordmark, a tinted hero with the headline,
 * the white card, and the footer. `kicker` is the small line above the
 * headline (e.g. the order number), `preheader` the inbox preview text.
 */
function layout(title, inner, { intro = '', kicker = '', preheader = '', tone = 'sage', reason = "You're receiving this because of an order you placed with Trove." } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant:wght@500;600&family=Quicksand:wght@500;700&display=swap" rel="stylesheet">
<style>
  body{margin:0;padding:0;background:${CREAM}}
  a{color:${INK}}
  @media (max-width:620px){
    .wrap{width:100%!important}
    .px{padding-left:22px!important;padding-right:22px!important}
    .stack{display:block!important;width:100%!important;box-sizing:border-box}
    .h1{font-size:30px!important}
  }
</style></head>
<body style="margin:0;padding:0;background:${CREAM}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM}">${esc(preheader)}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM}"><tr><td align="center" style="padding:28px 12px 36px">
  <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
    <tr><td class="px" style="padding:0 8px 18px">
      <a href="${SITE_LINK}" style="text-decoration:none;font-family:${SERIF};font-size:34px;font-weight:600;color:${INK};letter-spacing:.01em">trove<span style="color:#F19A82">.</span></a>
    </td></tr>
    <tr><td style="background:#FFFFFF;border:1px solid ${LINE};border-radius:20px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="px" style="background:${TONES[tone] || TONES.sage};padding:34px 40px 30px;border-radius:20px 20px 0 0">
          ${kicker ? `<div style="font-family:${SANS};font-size:13px;color:${MUTED};padding-bottom:10px">${kicker}</div>` : ''}
          <div class="h1" style="font-family:${SERIF};font-size:36px;line-height:1.1;font-weight:500;color:${INK}">${esc(title)}</div>
          ${intro ? `<div style="font-family:${SANS};font-size:15.5px;line-height:1.6;color:${INK};padding-top:12px">${intro}</div>` : ''}
        </td></tr>
        <tr><td class="px" style="padding:8px 40px 36px">${inner}</td></tr>
      </table>
    </td></tr>
    <tr><td class="px" align="center" style="padding:24px 8px 0;font-family:${SANS};font-size:12px;line-height:1.7;color:#8b8380">
      <a href="${SITE_LINK}" style="color:${INK};text-decoration:none;font-weight:700">Shop Trove</a> &nbsp;·&nbsp;
      <a href="${SITE_LINK}/account" style="color:${INK};text-decoration:none;font-weight:700">Your account</a><br>
      Trove · Curated for Living · Dubai, UAE<br>
      ${esc(reason)}<br>
      This is an automated email from a no-reply address, so replies aren't read.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const dubaiDate = (sqlTime) => {
  if (!sqlTime) return '';
  const d = new Date(String(sqlTime).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(sqlTime) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
};

/* ---- order confirmation ----
 * Sent the moment payment succeeds, from the shared paid effects — so the
 * real webhook and demo-mode completion send exactly the same receipt.
 * { order, items[{ name, qty, price_cents, meta, image, shop }], shops[], ship }
 * with money in fils on the order row.
 */
function orderConfirmation({ order, items, shops, ship }) {
  const many = shops.length > 1;
  const first = ship && ship.name ? `, ${esc(String(ship.name).split(' ')[0])}` : '';
  const who = many ? 'The shops are' : `${esc(shops[0] || 'The shop')} is`;
  const date = dubaiDate(order.created_at);
  const inner =
    tracker(1)
    + heading(`Your ${items.length > 1 ? 'pieces' : 'piece'}`)
    + itemsByShop(items)
    + totals([
      totalRow('Subtotal', aed(order.subtotal_cents)),
      ...(order.service_fee_cents ? [totalRow('Service fee', aed(order.service_fee_cents))] : []),
      totalRow('Delivery', order.shipping_cents ? aed(order.shipping_cents) : 'Free'),
      totalRow('Total', aed(order.total_cents), true),
    ])
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 0;background:${CREAM};border:1px solid ${LINE};border-radius:14px"><tr>
        ${ship ? `<td class="stack" width="50%" valign="top" style="padding:18px 20px;font-family:${SANS};font-size:14.5px;line-height:1.6;color:${INK}">
          ${label('Delivering to')}${esc(ship.name)}<br>${esc(ship.line)}${ship.line2 ? '<br>' + esc(ship.line2) : ''}<br>${esc(ship.city)}</td>` : ''}
        <td class="stack" width="50%" valign="top" style="padding:18px 20px;font-family:${SANS};font-size:14.5px;line-height:1.6;color:${INK}">
          ${label('Arriving')}<b>In 3–6 days</b><br>${many
            ? `In ${shops.length} parcels — each shop packs its own, all tracked together in one place.`
            : 'Packed by hand and tracked all the way to your door.'}</td>
      </tr></table>`
    + button('Track your order', `${SITE_LINK}/account`)
    + note('Something not right? You can request a return from this order in your account.');
  return {
    subject: `Your Trove order ${order.public_id} is confirmed`,
    html: layout('Your order is confirmed', inner, {
      kicker: `Order <b style="color:${INK}">${esc(order.public_id)}</b>${date ? ' · ' + date : ''}`,
      intro: `Thank you${first}. ${who} preparing your ${items.length > 1 ? 'pieces' : 'piece'} now, and you can follow every step from your account.`,
      preheader: `Order ${order.public_id} is confirmed — ${aed(order.total_cents)}, arriving in 3–6 days.`,
    }),
  };
}

/* ---- return lifecycle templates ----
 * Each takes { order, items, money } (+ extras) with money = { gross, fee,
 * refund } in fils, and returns { subject, html } ready for send().
 */
function returnRequested({ order, items, money, reasonLabel }) {
  const inner =
    heading('Coming back')
    + itemsBlock(items)
    + panel(`Reason: <b>${esc(reasonLabel)}</b><br>If it's approved, <b>${aed(money.refund)}</b> goes back to your original payment method${money.fee ? ` (a ${aed(money.fee)} collection fee applies on orders of AED 200 and below and is already deducted from that figure)` : ' — collection is free for this order'}. The original delivery fee isn't refundable.`)
    + p('Nothing else to do for now — keep the item packed and ready in case the return is approved.');
  return {
    subject: `We've received your return request — order ${order.public_id}`,
    html: layout('Your return request is in', inner, {
      tone: 'clay',
      kicker: `Order <b style="color:${INK}">${esc(order.public_id)}</b>`,
      intro: `We've received your return request for order <b>${esc(order.public_id)}</b> and our team is reviewing it now. You'll hear from us by email as soon as it's decided — usually within a couple of days.`,
      preheader: `Return request received for order ${order.public_id} — we'll be in touch shortly.`,
    }),
  };
}

function returnApproved({ order, items, money }) {
  const inner =
    panel(`<span style="font-family:${SERIF};font-size:26px;font-weight:600">${aed(money.refund)}</span><br>on its way back to your original payment method${money.fee ? ` (${aed(money.fee)} collection fee deducted)` : ''}. Depending on your bank it can take 5–10 business days to appear.`)
    + heading('Coming back')
    + itemsBlock(items)
    + p('Our courier will be in touch to collect the item — please keep it packed and ready with any original packaging.');
  return {
    subject: `Your return is approved — ${aed(money.refund)} on its way`,
    html: layout('Return approved', inner, {
      kicker: `Order <b style="color:${INK}">${esc(order.public_id)}</b>`,
      intro: `Good news — your return for order <b>${esc(order.public_id)}</b> is approved.`,
      preheader: `${aed(money.refund)} is on its way back to you.`,
    }),
  };
}

function returnDeclined({ order, items, declineReason }) {
  const inner =
    itemsBlock(items)
    + panel(`The reason from our team: <b>${esc(declineReason)}</b>`)
    + p('The full request and this decision stay with the order in your account.');
  return {
    subject: `About your return request — order ${order.public_id}`,
    html: layout('Your return request', inner, {
      tone: 'clay',
      kicker: `Order <b style="color:${INK}">${esc(order.public_id)}</b>`,
      intro: `We've reviewed your return request for order <b>${esc(order.public_id)}</b> and this time we can't accept it.`,
      preheader: `An update on your return request for order ${order.public_id}.`,
    }),
  };
}

/* ---- order we couldn't complete ----
 * Sent when a payment succeeds but the order can't go ahead — a piece sold
 * out between checkout and payment (two buyers on the last one), or the
 * order had already expired. The full amount goes back automatically.
 * { order, items[{ name, qty, price_cents, meta, image }], soldOut:boolean }
 */
function orderUnavailable({ order, items, soldOut = true }) {
  const inner =
    panel(`<span style="font-family:${SERIF};font-size:26px;font-weight:600">${aed(order.total_cents)}</span><br>is on its way back to your original payment method. Depending on your bank it can take 5–10 business days to appear. You haven't been charged for anything.`)
    + (items && items.length ? heading(soldOut ? 'No longer available' : 'Your order') + itemsBlock(items) : '')
    + p(soldOut
      ? 'Most pieces on Trove are handmade in small numbers, and someone else checked out with the last one moments before your payment went through. We are sorry — the rest of your basket was not sent either, so nothing arrives half-complete.'
      : 'Your checkout was left open for longer than we can hold an order, so we could not complete it.')
    + button('Back to the shop', SITE_LINK);
  return {
    subject: `We couldn't complete your Trove order ${order.public_id} — full refund on its way`,
    html: layout("We couldn't complete your order", inner, {
      tone: 'clay',
      kicker: `Order <b style="color:${INK}">${esc(order.public_id)}</b>`,
      intro: `We're sorry — order <b>${esc(order.public_id)}</b> couldn't go ahead, so we have refunded it in full.`,
      preheader: `Order ${order.public_id}: a full refund of ${aed(order.total_cents)} is on its way.`,
    }),
  };
}

module.exports = { enabled, send, productImage, orderConfirmation, orderUnavailable, returnRequested, returnApproved, returnDeclined };

/* ======================================================================
 * Account + partner emails (2026-09-30). Same shell as the receipts; each
 * template takes plain data plus the absolute link(s) it needs, and returns
 * { subject, html }. Callers send them fire-and-forget via send().
 * ==================================================================== */
const ACCOUNT_REASON = "You're receiving this because of your Trove account.";
const PARTNER_REASON = "You're receiving this because you applied to sell or offer services on Trove.";
const ADMIN_REASON = 'You are receiving this because you look after Trove.';
const firstName = (name) => esc(String(name || '').trim().split(/\s+/)[0] || 'there');

/** Password reset: a one-hour, single-use link. */
function passwordReset({ name, link }) {
  const inner =
    p('Someone — hopefully you — asked to reset the password for your Trove account. Use the button below to choose a new one.')
    + button('Choose a new password', esc(link))
    + note('The link works once and expires in an hour. If you did not ask for this, you can ignore this email — your password stays as it is.');
  return {
    subject: 'Reset your Trove password',
    html: layout('Reset your password', inner, {
      tone: 'clay', intro: `Hello ${firstName(name)},`, reason: ACCOUNT_REASON,
      preheader: 'Your link to choose a new Trove password — it expires in an hour.',
    }),
  };
}

/** Welcome + confirm your email. Shopping never waits on the click. */
function welcomeVerify({ name, link }) {
  const inner =
    p('Thank you for joining Trove — a curated home for pieces made by independent makers in Dubai and Abu Dhabi.')
    + p('Please confirm this is your email address, so we can reach you about your orders and help you back into your account if you ever forget your password.')
    + button('Confirm my email', esc(link))
    + note('You can shop straight away — confirming just keeps your account safe. The link expires in 7 days.');
  return {
    subject: 'Welcome to Trove — please confirm your email',
    html: layout('Welcome to Trove', inner, {
      intro: `Hello ${firstName(name)},`, reason: ACCOUNT_REASON,
      preheader: 'Confirm your email address to keep your Trove account safe.',
    }),
  };
}

/** Sent after any password change, so an owner notices one they did not make. */
function passwordChanged({ name, link }) {
  const inner =
    p('The password for your Trove account has just been changed, and every other device has been signed out.')
    + p(`If this was you, there is nothing else to do. If it was not, <a href="${esc(link)}" style="color:${INK};font-weight:700">reset your password</a> straight away.`);
  return {
    subject: 'Your Trove password was changed',
    html: layout('Password changed', inner, { tone: 'clay', intro: `Hello ${firstName(name)},`, reason: ACCOUNT_REASON, preheader: 'Your Trove password was just changed.' }),
  };
}

/* ---- maker (shop) and provider applications ---- */
const KIND = { shop: { what: 'shop' }, provider: { what: 'services practice' } };

/** To the applicant, the moment an application lands. kind = shop | provider. */
function applicationReceived({ kind = 'shop', name, businessName, link }) {
  const k = KIND[kind] || KIND.shop;
  const inner =
    panel(`<b>${esc(businessName)}</b><br>Application received · under review`)
    + p("Our curation team looks at every application by hand, so it can take a few days. You'll hear from us by email as soon as there is a decision.")
    + p(kind === 'shop'
      ? 'Meanwhile you can sign in and get your shop ready — add your pieces, photos and pickup address — so it can go on sale the moment it is approved.'
      : 'Meanwhile you can sign in and prepare your listings, so they can go live the moment your practice is approved.')
    + button(kind === 'shop' ? 'Open your dashboard' : 'Open your services dashboard', esc(link));
  return {
    subject: kind === 'shop' ? 'We have your Trove shop application' : 'We have your Trove services application',
    html: layout('Thank you for applying', inner, {
      intro: `Hello ${firstName(name)}, thank you for applying to open a ${k.what} on Trove.`,
      reason: PARTNER_REASON,
      preheader: `Your application for ${businessName} is with our curation team.`,
    }),
  };
}

/** To Trove's admin: a new application is waiting. Contact details stay in the admin panel. */
function applicationAlert({ kind = 'shop', businessName, applicantName, location, category, link }) {
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
function applicationApproved({ kind = 'shop', name, businessName, link }) {
  const inner = kind === 'shop'
    ? p(`<b>${esc(businessName)}</b> is approved, and any piece you have marked live is now on sale on Trove.`)
      + p('When a piece sells we email you, and it appears in your dashboard with everything you need to pack it. Our courier collects from your pickup address — please make sure it and your pickup phone are filled in under Storefront.')
      + button('Go to your dashboard', esc(link))
    : p(`<b>${esc(businessName)}</b> is approved, and your live services now appear in the Trove Services Marketplace.`)
      + p('Booking requests arrive in your services dashboard.')
      + button('Go to your services dashboard', esc(link));
  return {
    subject: kind === 'shop' ? `Welcome to Trove — ${String(businessName).slice(0, 80)} is approved` : `You're approved on Trove Services — ${String(businessName).slice(0, 80)}`,
    html: layout("You're approved", inner, { intro: `Congratulations, ${firstName(name)}.`, reason: PARTNER_REASON, preheader: `${businessName} is approved on Trove.` }),
  };
}

/** Application not accepted — polite, with the admin's note when there is one. */
function applicationRejected({ kind = 'shop', name, businessName, adminNote = '', link }) {
  const k = KIND[kind] || KIND.shop;
  const inner =
    p(`Thank you for applying to open a ${k.what} on Trove, and for sharing your work with us. We read every application carefully, and this time we are not able to accept <b>${esc(businessName)}</b>.`)
    + (adminNote ? panel(`A note from our curation team:<br><b>${esc(adminNote)}</b>`) : '')
    + p('This is often about fit with what we are curating right now rather than the quality of your work. You are welcome to apply again in the future.')
    + button('Visit Trove', esc(link));
  return {
    subject: `About your Trove application — ${String(businessName).slice(0, 80)}`,
    html: layout('About your application', inner, { tone: 'clay', intro: `Hello ${firstName(name)},`, reason: PARTNER_REASON, preheader: `An update on your application for ${businessName}.` }),
  };
}

/**
 * New order to pack — to the shop owner, listing ONLY their pieces. By design
 * it carries no buyer email, phone or address: Trove books the courier, which
 * holds the delivery details itself.
 * { shopName, ownerName, publicId, items[{ name, qty, price_cents, meta, image }], packByDays, link }
 */
function orderToPack({ shopName, ownerName, publicId, items, packByDays = 2, link }) {
  const units = items.reduce((t, i) => t + i.qty, 0);
  const inner =
    heading(units > 1 ? 'Pieces to pack' : 'Piece to pack')
    + itemsBlock(items)
    + panel(`<b>Please pack ${units > 1 ? 'them' : 'it'} within ${packByDays} days</b> in your own packaging, then tap <b>Packed · ready for collection</b> on the order in your dashboard. Our courier collects from your pickup address, so the buyer receives it inside our 3–6 day delivery promise.`)
    + button('Open the order', esc(link))
    + note('Trove arranges the courier and looks after the customer, so there is nobody to contact — everything you need is on the order.');
  return {
    subject: `New order to pack — ${publicId}`,
    html: layout('You have a new order', inner, {
      kicker: `Order <b style="color:${INK}">${esc(publicId)}</b> · ${esc(shopName)}`,
      intro: `Good news, ${firstName(ownerName)} — ${units > 1 ? `${units} pieces` : 'a piece'} from your shop just sold.`,
      reason: "You're receiving this because you sell on Trove.",
      preheader: `Order ${publicId}: please pack within ${packByDays} days.`,
    }),
  };
}

Object.assign(module.exports, {
  passwordReset, welcomeVerify, passwordChanged,
  applicationReceived, applicationAlert, applicationApproved, applicationRejected, orderToPack,
});
