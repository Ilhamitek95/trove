'use strict';
/**
 * Tax invoices and tax credit notes (UAE VAT), bilingual English/Arabic.
 * Everything here sits behind VAT registration: an order only gets an
 * invoice number when VAT was captured on it (VAT_REGISTERED on at payment),
 * so nothing changes for buyers until the owner registers and flips the flag.
 *
 *   assignInvoiceNo(orderId)  INV-000001, INV-000002… — sequential, assigned
 *                             inside the payment transaction.
 *   invoiceHtml(order)        printable tax invoice: supplier legal name,
 *                             address and TRN (Admin → Site content → Company
 *                             details), invoice number + date, buyer, every
 *                             line (VAT-inclusive), delivery, total excl. VAT,
 *                             VAT at 5% and total.
 *   creditNotes(order)        every credit note on the order: item returns
 *                             (CN-<order>-R<id>), cancellations before dispatch
 *                             (CN-<order>-C<id>) and a whole-order refund
 *                             (CN-<order>) — each with the VAT it reverses.
 *   creditNoteHtml(order, ref) the printable tax credit note for one of them.
 *
 * Served to the buyer from /api/account/orders/:publicId/tax-invoice and
 * …/credit-notes/:ref, and to the admin from /api/admin/orders/… .
 * Prices on Trove are VAT-inclusive, so the VAT is 5/105 of the amount.
 */
const db = require('./db');
const cfg = require('./config');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const aed = (c) => `AED ${((c || 0) / 100).toFixed(2)}`;
const day = (sql) => {
  if (!sql) return '';
  const d = new Date(String(sql).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
};

/** Next sequential number. Call inside the payment transaction. */
function assignInvoiceNo(orderId) {
  const o = db.prepare('SELECT tax_invoice_no, vat_amount_cents FROM orders WHERE id=?').get(orderId);
  if (!o || o.tax_invoice_no || !(o.vat_amount_cents > 0)) return o && o.tax_invoice_no;
  const last = db.prepare("SELECT MAX(CAST(substr(tax_invoice_no, 5) AS INTEGER)) AS n FROM orders WHERE tax_invoice_no LIKE 'INV-%'").get().n || 0;
  const no = `INV-${String(last + 1).padStart(6, '0')}`;
  db.prepare('UPDATE orders SET tax_invoice_no=? WHERE id=?').run(no, orderId);
  return no;
}

function supplier() {
  const c = require('./content').company();
  return {
    name: (c.legalName || '').trim(), address: (c.address || '').trim(), trn: (c.vatTrn || '').trim(),
    licence: (c.tradeLicence || '').trim(), email: (c.email || '').trim(),
  };
}

const parseShip = (j) => { try { return j ? JSON.parse(j) : null; } catch (_) { return null; } };

function page(title, titleAr, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Trove</title>
<style>
  body{font-family:system-ui,'Segoe UI',Helvetica,Arial,sans-serif;color:#292727;background:#fff;max-width:820px;margin:28px auto;padding:0 20px;font-size:14px;line-height:1.5}
  h1{font-weight:600;font-size:26px;margin:0}.ar{direction:rtl;unicode-bidi:isolate;color:#5f5753}
  .row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin:18px 0}
  .box{border:1px solid #EFE5E0;border-radius:12px;padding:12px 16px;flex:1;min-width:240px}
  .k{font-size:12px;color:#7b716d}
  table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #EFE5E0;vertical-align:top}
  th{font-size:12px;color:#7b716d;font-weight:600}td.n,th.n{text-align:right;white-space:nowrap}
  .tot td{border:0;padding:4px 6px}.tot .big td{font-weight:700;font-size:16px;border-top:1px solid #292727;padding-top:8px}
  .warn{background:#FCEBE4;border-radius:10px;padding:10px 14px;margin:14px 0;font-weight:600}
  @media print{.noprint{display:none}body{margin:0}}
</style></head><body>
<div class="row" style="align-items:flex-end"><div><h1>${esc(title)}</h1><div class="ar">${titleAr}</div></div>
<button class="noprint" onclick="window.print()" style="padding:9px 18px;border-radius:999px;border:1px solid #292727;background:#fff;font:inherit;font-weight:600;cursor:pointer">Print / save as PDF</button></div>
${body}
</body></html>`;
}

function partiesHtml(order, s) {
  const ship = parseShip(order.shipping_json) || {};
  const missing = !s.name || !s.trn;
  return `${missing ? '<div class="warn">The supplier legal name and TRN are not filled in yet (Admin → Site content → Company details), so this document is not a valid tax document until they are.</div>' : ''}
  <div class="row">
    <div class="box"><div class="k">Supplier · <span class="ar">المورّد</span></div>
      <b>${esc(s.name || 'Trove')}</b><br>${esc(s.address)}${s.licence ? `<br>Trade licence ${esc(s.licence)}` : ''}
      <br>TRN · <span class="ar">الرقم الضريبي</span>: <b>${esc(s.trn || '—')}</b></div>
    <div class="box"><div class="k">Customer · <span class="ar">العميل</span></div>
      <b>${esc(ship.name || order.email)}</b><br>${esc([ship.line, ship.line2, ship.city].filter(Boolean).join(', '))}</div>
  </div>`;
}

/** Every line on the order as sold (VAT-inclusive), with the delivery fee. */
function soldLines(order) {
  const rows = db.prepare(`SELECT oi.name_snapshot, oi.qty, oi.price_cents, oi.options FROM order_items oi WHERE oi.order_id=? ORDER BY oi.id`).all(order.id)
    .map((i) => ({ name: i.name_snapshot, meta: require('./options').label(i.options), qty: i.qty, unit: i.price_cents, gross: i.price_cents * i.qty }));
  if (order.shipping_cents) rows.push({ name: 'Delivery', meta: '', qty: 1, unit: order.shipping_cents, gross: order.shipping_cents });
  return rows;
}
const lineRows = (rows) => rows.map((l) => `<tr><td>${esc(l.name)}${l.meta ? `<div class="k">${esc(l.meta)}</div>` : ''}</td><td class="n">${l.qty}</td><td class="n">${aed(l.unit)}</td><td class="n">${aed(cfg.vatFromGross(l.gross))}</td><td class="n">${aed(l.gross)}</td></tr>`).join('');
const head = `<tr><th>Description · <span class="ar">الوصف</span></th><th class="n">Qty · <span class="ar">الكمية</span></th><th class="n">Unit price incl. VAT</th><th class="n">VAT 5%</th><th class="n">Amount · <span class="ar">المبلغ</span></th></tr>`;

function invoiceHtml(order) {
  if (!order || !order.tax_invoice_no) return null;
  const s = supplier();
  const vat = order.vat_amount_cents || 0;
  return page('Tax invoice', 'فاتورة ضريبية', `
  <div class="row"><div><div class="k">Invoice number · <span class="ar">رقم الفاتورة</span></div><b>${esc(order.tax_invoice_no)}</b></div>
    <div><div class="k">Date of supply · <span class="ar">تاريخ التوريد</span></div><b>${esc(day(order.title_transferred_at || order.created_at))}</b></div>
    <div><div class="k">Order</div><b>${esc(order.public_id)}</b></div></div>
  ${partiesHtml(order, s)}
  <table>${head}${lineRows(soldLines(order))}</table>
  <table class="tot">
    <tr><td>Total excluding VAT · <span class="ar">المجموع غير شامل الضريبة</span></td><td class="n">${aed(order.total_cents - vat)}</td></tr>
    <tr><td>VAT at 5% · <span class="ar">ضريبة القيمة المضافة 5%</span></td><td class="n">${aed(vat)}</td></tr>
    <tr class="big"><td>Total including VAT · <span class="ar">المجموع شامل الضريبة</span></td><td class="n">${aed(order.total_cents)}</td></tr>
  </table>
  <p class="k">Prices are in UAE dirhams and include VAT. Trove sells these pieces as the supplier of record.</p>`);
}

/** Every credit note on the order: { ref, kind, at, amountCents, vatCents, items[] }. */
function creditNotes(order) {
  const out = [];
  for (const r of db.prepare("SELECT * FROM return_requests WHERE order_id=? AND status='refunded' AND credit_note_ref IS NOT NULL AND vat_reversed_cents > 0 ORDER BY id").all(order.id)) {
    out.push({ ref: r.credit_note_ref, kind: 'return', at: r.refunded_at, amountCents: r.refund_cents || 0, vatCents: r.vat_reversed_cents,
      items: require('./returns').requestItems(r.id).map((i) => ({ name: i.name_snapshot, qty: i.qty, gross: i.price_cents * i.qty })),
      deliveryCents: r.delivery_refund_cents || 0, feeCents: r.fee_cents || 0 });
  }
  for (const c of db.prepare("SELECT * FROM order_cancellations WHERE order_id=? AND status='refunded' AND credit_note_ref IS NOT NULL AND vat_reversed_cents > 0 ORDER BY id").all(order.id)) {
    out.push({ ref: c.credit_note_ref, kind: 'cancellation', at: c.refunded_at, amountCents: c.refund_cents, vatCents: c.vat_reversed_cents,
      items: db.prepare(`SELECT oi.name_snapshot AS name, ci.qty, oi.price_cents * ci.qty AS gross FROM order_cancellation_items ci
        JOIN order_items oi ON oi.id = ci.order_item_id WHERE ci.cancellation_id=?`).all(c.id),
      deliveryCents: c.delivery_refund_cents || 0, feeCents: 0 });
  }
  if (order.credit_note_ref && order.refunded_at) {
    out.push({ ref: order.credit_note_ref, kind: 'order', at: order.refunded_at,
      amountCents: order.whole_refund_cents != null ? order.whole_refund_cents : order.total_cents,
      vatCents: order.whole_refund_vat_cents != null ? order.whole_refund_vat_cents : order.vat_reversed_cents,
      items: [], deliveryCents: 0, feeCents: 0 });
  }
  return out;
}

function creditNoteHtml(order, ref) {
  const cn = creditNotes(order).find((c) => c.ref === ref);
  if (!cn) return null;
  const s = supplier();
  const rows = cn.items.map((i) => ({ name: i.name, meta: '', qty: i.qty, unit: i.qty ? Math.round(i.gross / i.qty) : i.gross, gross: i.gross }));
  if (cn.deliveryCents) rows.push({ name: 'Delivery', meta: '', qty: 1, unit: cn.deliveryCents, gross: cn.deliveryCents });
  if (cn.feeCents) rows.push({ name: 'Less the return collection fee', meta: '', qty: 1, unit: -cn.feeCents, gross: -cn.feeCents });
  const what = { return: 'Items returned', cancellation: 'Items cancelled before dispatch', order: 'Order refunded' }[cn.kind];
  return page('Tax credit note', 'إشعار دائن ضريبي', `
  <div class="row"><div><div class="k">Credit note · <span class="ar">رقم الإشعار</span></div><b>${esc(cn.ref)}</b></div>
    <div><div class="k">Date · <span class="ar">التاريخ</span></div><b>${esc(day(cn.at))}</b></div>
    <div><div class="k">Against tax invoice · <span class="ar">الفاتورة الأصلية</span></div><b>${esc(order.tax_invoice_no || order.public_id)}</b></div></div>
  ${partiesHtml(order, s)}
  <p><b>${esc(what)}</b></p>
  ${rows.length ? `<table>${head}${lineRows(rows)}</table>` : ''}
  <table class="tot">
    <tr><td>Credit excluding VAT · <span class="ar">المبلغ غير شامل الضريبة</span></td><td class="n">${aed(cn.amountCents - cn.vatCents)}</td></tr>
    <tr><td>VAT credited at 5% · <span class="ar">الضريبة المستردة</span></td><td class="n">${aed(cn.vatCents)}</td></tr>
    <tr class="big"><td>Total credited · <span class="ar">إجمالي المبلغ المسترد</span></td><td class="n">${aed(cn.amountCents)}</td></tr>
  </table>`);
}

/** What the account page / admin list may link to. */
function docsFor(order) {
  return {
    taxInvoice: order.tax_invoice_no || null,
    creditNotes: order.tax_invoice_no ? creditNotes(order).map((c) => ({ ref: c.ref, at: c.at, amount: c.amountCents / 100, vat: c.vatCents / 100 })) : [],
  };
}

module.exports = { assignInvoiceNo, invoiceHtml, creditNotes, creditNoteHtml, docsFor, supplier };
