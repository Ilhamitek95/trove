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
 *   EMAIL_FROM      verified sender, e.g. "Trove <hello@troveathome.com>"
 *                   (the domain must be verified in the Resend dashboard)
 */

const enabled = () => !!process.env.RESEND_API_KEY;
const from = () => process.env.EMAIL_FROM || 'Trove <hello@troveathome.com>';

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
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const aed = (cents) => {
  const n = (cents || 0) / 100;
  return 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB')
    : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};

function layout(title, inner) {
  return `<div style="background:#FDF7F5;padding:36px 16px;color:#292727;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#FFFDFC;border:1px solid #EADFD9;border-radius:18px;padding:34px 32px">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:.01em">trove<span style="color:#F19A82">.</span></div>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;margin:22px 0 4px">${title}</h1>
    ${inner}
    <p style="font-size:12px;color:#8b8380;margin:30px 0 0;border-top:1px solid #EADFD9;padding-top:14px">
      Trove · Dubai, UAE · <a href="https://troveathome.com" style="color:#292727">troveathome.com</a><br>
      You're receiving this because of an order you placed with Trove.
    </p>
  </div>
</div>`;
}
const p = (s) => `<p style="font-size:14.5px;line-height:1.65;margin:12px 0">${s}</p>`;
// `meta` is the optional second line under an item — the chosen variation and
// any personalisation, so a receipt says which mug is on its way.
function itemsBlock(items) {
  return `<div style="background:#FDF7F5;border:1px solid #EADFD9;border-radius:12px;padding:14px 18px;margin:16px 0">
    ${items.map((i) => `<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0">
      <span>${esc(i.name)}${i.qty > 1 ? ` &times;${i.qty}` : ''}${i.meta ? `<br><span style="font-size:12.5px;color:#8b8380">${esc(i.meta)}</span>` : ''}</span>
      <span style="font-weight:600">${aed(i.price_cents * i.qty)}</span>
    </div>`).join('')}
  </div>`;
}
const totalRow = (label, value, bold) => `<div style="display:flex;justify-content:space-between;font-size:${bold ? '15.5px' : '14px'};padding:${bold ? '10px 0 0' : '3px 0'};${bold ? 'border-top:1px solid #EADFD9;margin-top:8px;font-weight:700' : 'color:#6f6764'}">
  <span>${esc(label)}</span><span>${value}</span></div>`;

/* ---- order confirmation ----
 * Sent the moment payment succeeds, from the shared paid effects — so the
 * real webhook and demo-mode completion send exactly the same receipt.
 * { order, items, shops[], ship } with money in fils on the order row.
 */
function orderConfirmation({ order, items, shops, ship }) {
  const many = shops.length > 1;
  const inner =
    p(`Thank you${ship && ship.name ? `, ${esc(String(ship.name).split(' ')[0])}` : ''} — your order is confirmed and the ${many ? 'shops are' : 'shop is'} preparing it now.`)
    + `<div style="font-size:13px;color:#8b8380;margin:18px 0 0">Order</div>
       <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:.04em">${esc(order.public_id)}</div>`
    + itemsBlock(items)
    + totalRow('Subtotal', aed(order.subtotal_cents))
    + (order.service_fee_cents ? totalRow('Service fee', aed(order.service_fee_cents)) : '')
    + totalRow('Delivery', order.shipping_cents ? aed(order.shipping_cents) : 'Free')
    + totalRow('Total', aed(order.total_cents), true)
    + p(`Arriving in <b>3–6 days</b>${many ? `, in ${shops.length} parcels — each shop packs its own, all tracked together in one place.` : '.'}`)
    + (ship ? `<div style="background:#FDF7F5;border:1px solid #EADFD9;border-radius:12px;padding:14px 18px;margin:16px 0;font-size:14px;line-height:1.6">
        <div style="font-size:12px;color:#8b8380;margin-bottom:4px">Delivering to</div>
        ${esc(ship.name)}<br>${esc(ship.line)}<br>${esc(ship.city)}</div>` : '')
    + p(`You can follow every parcel in <a href="https://troveathome.com/account" style="color:#292727"><b>your account</b></a>. Something not right? Just reply to this email.`);
  return { subject: `Your Trove order ${order.public_id} is confirmed`, html: layout('Your order is confirmed', inner) };
}

/* ---- return lifecycle templates ----
 * Each takes { order, items, money } (+ extras) with money = { gross, fee,
 * refund } in fils, and returns { subject, html } ready for send().
 */

function returnRequested({ order, items, money, reasonLabel }) {
  const inner =
    p(`We've received your return request for order <b>${esc(order.public_id)}</b> and our team is reviewing it now. You'll hear from us by email as soon as it's decided — usually within a couple of days.`)
    + itemsBlock(items)
    + p(`Reason: <b>${esc(reasonLabel)}</b>`)
    + p(`If it's approved, <b>${aed(money.refund)}</b> goes back to your original payment method${money.fee ? ` (a ${aed(money.fee)} collection fee applies on orders of AED 200 and below and is already deducted from that figure)` : ' — collection is free for this order'}. The original delivery fee isn't refundable.`)
    + p('Nothing else to do for now — keep the item packed and ready in case the return is approved.');
  return { subject: `We've received your return request — order ${order.public_id}`, html: layout('Your return request is in', inner) };
}

function returnApproved({ order, items, money }) {
  const inner =
    p(`Good news — your return for order <b>${esc(order.public_id)}</b> is approved.`)
    + itemsBlock(items)
    + p(`<b>${aed(money.refund)}</b> is on its way back to your original payment method${money.fee ? ` (${aed(money.fee)} collection fee deducted)` : ''}. Depending on your bank it can take 5–10 business days to appear.`)
    + p('Our courier will be in touch to collect the item — please keep it packed and ready with any original packaging.');
  return { subject: `Your return is approved — ${aed(money.refund)} on its way`, html: layout('Return approved', inner) };
}

function returnDeclined({ order, items, declineReason }) {
  const inner =
    p(`We've reviewed your return request for order <b>${esc(order.public_id)}</b> and this time we can't accept it.`)
    + itemsBlock(items)
    + p(`The reason from our team: <b>${esc(declineReason)}</b>`)
    + p('If you think something here is wrong, just reply to this email and a person will take another look.');
  return { subject: `About your return request — order ${order.public_id}`, html: layout('Your return request', inner) };
}

module.exports = { enabled, send, orderConfirmation, returnRequested, returnApproved, returnDeclined };
