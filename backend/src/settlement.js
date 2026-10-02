'use strict';
/**
 * Settlement engine — the fortnightly purchase run for consignment suppliers
 * (every other Tuesday, anchored to fees.SETTLEMENT_ANCHOR_DATE).
 *
 * Lifecycle:  credit_sale (pending, return window open)
 *          →  eligible (delivered + the buyer's 15-day return window closed
 *                       + no return still open for it + order not refunded)
 *          →  settlement draft (swept, settlement_id stamped)
 *          →  exported (bank CSV, the ONLY place an IBAN is ever decrypted)
 *          →  paid (negative 'payout' ledger rows + self-billed purchase notes)
 *
 * Because a credit waits for the buyer's whole return window, a return inside
 * that window only ever shrinks an UNPAID credit — no clawback. Refund debits
 * still exist for the exceptions (orders placed under the old 30-day promise,
 * an admin refund outside the window): they net against a supplier's next
 * run; a shop netting ≤ 0 is skipped and its rows stay unswept — that IS the
 * carry-forward mechanism. The eligibility rule lives in exactly one query
 * below; every balance figure shown anywhere derives from it.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const fees = require('./fees');
const pcrypto = require('./crypto');
const { UPLOADS_DIR } = require('./uploads');

const PRIVATE_DIR = () => process.env.PRIVATE_DIR || path.join(UPLOADS_DIR, '..', 'private');

/* A supplier credit is payable when its parcel was delivered, its return
 * window closed BEFORE the run start, the ORDER's buyer window closed too (on
 * a multi-shop order the buyer's clock starts at the last delivery, so every
 * other parcel must be delivered first), no return request for that shop's
 * pieces is still in flight, the order was never refunded, and nothing
 * holds it (orders.hold_reason: a card dispute, or a refund made straight in
 * the Stripe dashboard that a person has to reconcile — src/stripe-events.js).
 * Orders placed under the old 30-day promise (return_days set by
 * migration 016) keep the per-parcel hold they were sold under. */
const ELIGIBLE_CREDITS = `
  SELECT b.id, b.shop_id, b.order_id, b.amount_cents
  FROM seller_balances b
  JOIN orders o     ON o.id = b.order_id
  JOIN shipments sh ON sh.order_id = b.order_id AND sh.shop_id = b.shop_id
  WHERE b.type = 'credit_sale' AND b.settlement_id IS NULL
    AND o.refunded_at IS NULL
    AND COALESCE(o.hold_reason, '') = ''
    AND sh.status = 'delivered'
    AND sh.return_window_ends_at IS NOT NULL
    AND sh.return_window_ends_at < @at
    AND (o.return_days IS NOT NULL OR (
      COALESCE(o.return_window_ends_at, sh.return_window_ends_at) < @at
      AND NOT EXISTS (SELECT 1 FROM shipments s2
        WHERE s2.order_id = b.order_id AND s2.status NOT IN ('delivered','cancelled'))))
    AND NOT EXISTS (
      SELECT 1 FROM return_requests rr
      JOIN return_request_items ri ON ri.request_id = rr.id
      JOIN order_items oi ON oi.id = ri.order_item_id
      WHERE rr.order_id = b.order_id AND oi.shop_id = b.shop_id
        AND rr.status IN ('requested','approved','collected'))`;

/* Unswept refund debits apply to the very next run, no window. */
const OPEN_DEBITS = `
  SELECT b.id, b.shop_id, b.amount_cents
  FROM seller_balances b
  WHERE b.type = 'debit_refund' AND b.settlement_id IS NULL`;

const payoutSetupComplete = (shop) => !!(shop.iban_encrypted && shop.agreement_accepted_at);

const nowSql = () => db.prepare("SELECT datetime('now') AS t").get().t;

/** Group eligible credits + open debits per shop as of runStart. */
function gather(runStart) {
  const perShop = new Map();
  const bucket = (shopId) => {
    if (!perShop.has(shopId)) perShop.set(shopId, { creditIds: [], debitIds: [], creditCents: 0, debitCents: 0 });
    return perShop.get(shopId);
  };
  for (const c of db.prepare(ELIGIBLE_CREDITS).all({ at: runStart })) {
    const b = bucket(c.shop_id);
    b.creditIds.push(c.id);
    b.creditCents += c.amount_cents;
  }
  for (const d of db.prepare(OPEN_DEBITS).all()) {
    const b = bucket(d.shop_id);
    b.debitIds.push(d.id);
    b.debitCents += d.amount_cents; // stored negative
  }
  return perShop;
}

/** What the next run would pay, and who is held back and why. */
function preview(runStart = nowSql()) {
  const eligible = [];
  const excluded = [];
  for (const [shopId, b] of gather(runStart)) {
    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(shopId);
    const net = b.creditCents + b.debitCents;
    const row = {
      shopId,
      name: shop.name,
      slug: shop.slug,
      creditCents: b.creditCents,
      debitCents: b.debitCents,
      netCents: net,
      itemCount: b.creditIds.length,
      bank: { name: shop.payout_bank_name, accountName: shop.payout_account_name, iban: shop.iban_masked },
    };
    if (shop.tier !== 'consignment' || !payoutSetupComplete(shop)) excluded.push({ ...row, reason: 'payout_setup_incomplete' });
    else if (net <= 0) excluded.push({ ...row, reason: 'netted_negative' });
    else eligible.push(row);
  }
  return {
    eligible,
    excluded,
    totalNetCents: eligible.reduce((s, r) => s + r.netCents, 0),
    commissionPercent: fees.COMMISSION_PERCENT,
    // Service providers' fees for bookings paid through Trove, payable in the
    // same run (src/service-credits.js). Shown here; paid from /admin until
    // providers have payout details of their own.
    serviceCredits: require('./service-credits').preview(runStart),
  };
}

/**
 * Create a draft settlement for runDate (YYYY-MM-DD): one settlement_item per
 * payable supplier, sweeping their credit AND debit rows. Returns null when
 * nothing is payable. Shops netting ≤ 0 or without payout setup keep their
 * rows unswept for a future run.
 */
function run(runDate) {
  const date = runDate || db.prepare("SELECT date('now') AS d").get().d;
  const runStart = `${date} 00:00:00`;
  return db.transaction(() => {
    const { eligible } = preview(runStart);
    if (!eligible.length) return null;
    const settlementId = db.prepare("INSERT INTO settlements (run_date, status, total_cents) VALUES (?, 'draft', 0)").run(date).lastInsertRowid;
    const stamp = db.prepare('UPDATE seller_balances SET settlement_id=? WHERE id=? AND settlement_id IS NULL');
    const perShop = gather(runStart);
    const items = [];
    for (const r of eligible) {
      const b = perShop.get(r.shopId);
      const itemId = db.prepare(`INSERT INTO settlement_items
          (settlement_id, shop_id, amount_cents, credit_cents, debit_cents, item_count, bank_reference, bank_snapshot)
        VALUES (?,?,?,?,?,?, '', ?)`)
        .run(settlementId, r.shopId, r.netCents, r.creditCents, r.debitCents, r.itemCount, JSON.stringify(r.bank)).lastInsertRowid;
      const reference = `Purchase of handmade goods — PO #${itemId}`;
      db.prepare('UPDATE settlement_items SET bank_reference=? WHERE id=?').run(reference, itemId);
      for (const id of [...b.creditIds, ...b.debitIds]) stamp.run(settlementId, id);
      items.push({ settlementItemId: itemId, shopId: r.shopId, amountCents: r.netCents, reference });
    }
    const total = items.reduce((s, i) => s + i.amountCents, 0);
    db.prepare('UPDATE settlements SET total_cents=? WHERE id=?').run(total, settlementId);
    return { settlementId, runDate: date, items, totalCents: total };
  })();
}

/**
 * Bank-upload CSV for a settlement. The one and only place supplier IBANs are
 * decrypted — straight into the response, never logged or stored. 503 without
 * PAYOUT_ENC_KEY. Marks a draft as exported.
 */
function exportCsv(settlementId) {
  const st = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  if (!st) { const e = new Error('Settlement not found'); e.status = 404; throw e; }
  const rows = db.prepare(`SELECT si.*, s.name AS shop_name, s.payout_bank_name, s.payout_account_name, s.iban_encrypted
    FROM settlement_items si JOIN shops s ON s.id = si.shop_id WHERE si.settlement_id=? ORDER BY si.id`).all(settlementId);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['supplier,account_name,bank,iban,amount_aed,reference'];
  for (const r of rows) {
    const iban = r.iban_encrypted ? pcrypto.decrypt(r.iban_encrypted) : '';
    lines.push([esc(r.shop_name), esc(r.payout_account_name), esc(r.payout_bank_name), esc(iban),
      (r.amount_cents / 100).toFixed(2), esc(r.bank_reference)].join(','));
  }
  if (st.status === 'draft') {
    db.prepare("UPDATE settlements SET status='exported', exported_at=datetime('now') WHERE id=?").run(settlementId);
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Mark a settlement paid after the bank transfers went out: writes the
 * negative 'payout' ledger rows, then generates one self-billed purchase note
 * per item (file IO deliberately outside the transaction).
 */
function markPaid(settlementId) {
  const st = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  if (!st) { const e = new Error('Settlement not found'); e.status = 404; throw e; }
  if (st.status === 'paid') { const e = new Error('Settlement already paid'); e.status = 409; throw e; }
  const items = db.prepare('SELECT * FROM settlement_items WHERE settlement_id=?').all(settlementId);
  db.transaction(() => {
    for (const it of items) {
      db.prepare(`INSERT INTO seller_balances (shop_id, settlement_id, type, amount_cents) VALUES (?,?, 'payout', ?)`)
        .run(it.shop_id, settlementId, -it.amount_cents);
    }
    db.prepare("UPDATE settlements SET status='paid', paid_at=datetime('now') WHERE id=?").run(settlementId);
  })();
  for (const it of items) {
    try { generatePurchaseNote(it, st); }
    catch (e) { console.error(`purchase note failed for settlement item ${it.id}:`, e.message); }
  }
  return db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
}

/** Self-billed purchase documentation: Trove generates the supplier's paper trail. */
function generatePurchaseNote(item, settlement) {
  const shop = db.prepare('SELECT s.*, u.name AS owner_name FROM shops s JOIN users u ON u.id=s.user_id WHERE s.id=?').get(item.shop_id);
  const orders = db.prepare(`
    SELECT b.amount_cents, o.public_id, o.created_at
    FROM seller_balances b JOIN orders o ON o.id = b.order_id
    WHERE b.settlement_id=? AND b.shop_id=? AND b.type='credit_sale' ORDER BY o.created_at`).all(settlement.id, item.shop_id);
  // Units Trove cancelled before dispatch were never bought from the maker.
  const lineStmt = db.prepare(`SELECT oi.name_snapshot, oi.qty - oi.cancelled_qty AS qty, oi.price_cents FROM order_items oi
    JOIN orders o ON o.id = oi.order_id WHERE o.public_id=? AND oi.shop_id=? AND oi.qty > oi.cancelled_qty`);
  const aed = (c) => `AED ${(c / 100).toFixed(2)}`;
  const orderBlocks = orders.map((o) => {
    const lines = lineStmt.all(o.public_id, item.shop_id);
    const gross = lines.reduce((s, l) => s + l.price_cents * l.qty, 0);
    return `<tr><td>${o.public_id}</td><td>${o.created_at.slice(0, 10)}</td>
      <td>${lines.map((l) => `${l.qty} × ${l.name_snapshot}`).join('<br>')}</td>
      <td style="text-align:right">${aed(gross)}</td>
      <td style="text-align:right">${aed(gross - o.amount_cents)}</td>
      <td style="text-align:right"><strong>${aed(o.amount_cents)}</strong></td></tr>`;
  }).join('');
  const debitRow = item.debit_cents
    ? `<tr><td colspan="5">Refund adjustments carried into this run</td><td style="text-align:right">${aed(item.debit_cents)}</td></tr>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Purchase note — ${item.bank_reference}</title>
<style>body{font-family:Georgia,serif;color:#262321;max-width:720px;margin:40px auto;padding:0 20px}
h1{font-size:22px;font-weight:600}table{width:100%;border-collapse:collapse;margin:16px 0}
td,th{padding:8px 6px;border-bottom:1px solid #e6ddd6;font-size:14px;text-align:left;vertical-align:top}
.tot{font-size:16px}.muted{color:#6b625b;font-size:13px}</style></head><body>
<h1>trove — self-billed purchase note</h1>
<p class="muted">${item.bank_reference} · Settlement run ${settlement.run_date}</p>
<p><strong>Supplier:</strong> ${shop.name} (${shop.owner_name})<br>
<strong>Emirates ID:</strong> ····${shop.emirates_id_last4 || '????'} ·
<strong>Seller Agreement:</strong> ${shop.agreement_version || '—'}</p>
<table><thead><tr><th>Order</th><th>Sale date</th><th>Goods</th><th style="text-align:right">List price</th><th style="text-align:right">Trove margin</th><th style="text-align:right">Purchase price</th></tr></thead>
<tbody>${orderBlocks}${debitRow}</tbody>
<tfoot><tr class="tot"><td colspan="5"><strong>Total paid to supplier</strong></td><td style="text-align:right"><strong>${aed(item.amount_cents)}</strong></td></tr></tfoot></table>
<p>This document records Trove's purchase of the goods listed above from the supplier
named above under the Trove Seller Agreement (consignment purchase). Title transferred
to Trove at order confirmation. Bank transfer reference: “${item.bank_reference}”.</p>
</body></html>`;
  const dir = path.join(PRIVATE_DIR(), 'purchase-notes');
  fs.mkdirSync(dir, { recursive: true });
  const file = `note-${item.id}-${Date.now()}.html`;
  fs.writeFileSync(path.join(dir, file), html);
  db.prepare('INSERT INTO purchase_notes (settlement_item_id, shop_id, html_path) VALUES (?,?,?)')
    .run(item.id, item.shop_id, path.join(dir, file));
}

/* ---------------- the fortnightly schedule ----------------
 * Run dates are the anchor Tuesday plus whole multiples of the interval, in
 * both directions, so the calendar never depends on when the server booted
 * or whether a run was skipped. Dates are plain YYYY-MM-DD (Dubai calendar
 * day); the arithmetic runs on UTC midnights so no timezone can shift it. */
const DAY_MS = 86400000;
const toDay = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const interval = () => Math.max(1, Math.round(fees.SETTLEMENT_INTERVAL_DAYS));
/** Today's date on the Dubai calendar (UTC+4, no daylight saving). */
const dubaiToday = (now = Date.now()) => new Date(now + 4 * 3600000).toISOString().slice(0, 10);

/** True when `date` (YYYY-MM-DD) is a settlement run day. */
function isRunDate(date) {
  const diff = toDay(date) - toDay(fees.SETTLEMENT_ANCHOR_DATE);
  return Number.isFinite(diff) && ((diff % interval()) + interval()) % interval() === 0;
}

/** The first run date on or after `from` (YYYY-MM-DD, default today in Dubai). */
function nextRunDate(from = dubaiToday()) {
  const f = toDay(from), a = toDay(fees.SETTLEMENT_ANCHOR_DATE), n = interval();
  const k = Math.ceil((f - a) / n);
  return fromDay(a + k * n);
}

/** The next `count` run dates from `from` — for the dashboard and the tests. */
function upcomingRunDates(count = 3, from = dubaiToday()) {
  const out = [nextRunDate(from)];
  while (out.length < count) out.push(fromDay(toDay(out[out.length - 1]) + interval()));
  return out;
}

/** Human label for the schedule, e.g. 'Every other Tuesday'. */
function scheduleLabel() {
  const n = interval();
  if (n === 7) return 'Every Tuesday';
  if (n === 14) return 'Every other Tuesday';
  return `Every ${n} days`;
}

/** A supplier's money view — every figure derived from the same eligibility rule. */
function balances(shopId) {
  const now = nowSql();
  const eligible = db.prepare(ELIGIBLE_CREDITS + ' AND b.shop_id = @shop').all({ at: now, shop: shopId })
    .reduce((s, r) => s + r.amount_cents, 0);
  const allUnsweptCredits = db.prepare(`
    SELECT COALESCE(SUM(b.amount_cents),0) AS c FROM seller_balances b
    JOIN orders o ON o.id = b.order_id
    WHERE b.type='credit_sale' AND b.settlement_id IS NULL AND b.shop_id=? AND o.refunded_at IS NULL`).get(shopId).c;
  const openDebits = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM seller_balances
    WHERE type='debit_refund' AND settlement_id IS NULL AND shop_id=?`).get(shopId).c;
  const settled = db.prepare(`SELECT COALESCE(SUM(si.amount_cents),0) AS c
    FROM settlement_items si JOIN settlements st ON st.id=si.settlement_id
    WHERE si.shop_id=? AND st.status='paid'`).get(shopId).c;
  return {
    pendingCents: allUnsweptCredits - eligible, // in the return window / not delivered yet
    payableCents: eligible + openDebits,        // next run (may be negative = carry-forward)
    settledCents: settled,
  };
}

module.exports = {
  preview, run, exportCsv, markPaid, balances, payoutSetupComplete, ELIGIBLE_CREDITS,
  isRunDate, nextRunDate, upcomingRunDates, scheduleLabel, dubaiToday,
};
