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
const identity = require('./identity');

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

/**
 * Why a shop's money is held back from every run until the owner releases it
 * (Seller Agreement v4: Trove may pause a shop and hold back settlement while
 * it investigates), or null:
 *   'on_hold'               the shop is suspended, or the owner put its
 *                           payouts on hold (shops.payout_hold, 'manual')
 *   'bank_details_changed'  the maker changed their bank account: the first
 *                           run after it waits for the owner's check
 * Held rows stay unswept, so nothing is lost — they go in the run after the
 * hold is lifted.
 */
function holdReason(shop) {
  if (shop.status === 'suspended') return 'on_hold';
  if (shop.payout_hold) return shop.payout_hold_reason === 'bank_details_changed' ? 'bank_details_changed' : 'on_hold';
  return null;
}

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
    const shop = db.prepare('SELECT s.*, u.name AS owner_name FROM shops s JOIN users u ON u.id = s.user_id WHERE s.id=?').get(shopId);
    const net = b.creditCents + b.debitCents;
    const id = identity.status(shop);
    const row = {
      shopId,
      name: shop.name,
      slug: shop.slug,
      creditCents: b.creditCents,
      debitCents: b.debitCents,
      netCents: net,
      itemCount: b.creditIds.length,
      suspended: shop.status === 'suspended',
      bank: { name: shop.payout_bank_name, accountName: shop.payout_account_name, iban: shop.iban_masked },
      // Who the money is for, beside whose account it goes to: a mismatch is
      // flagged for the admin to look at before exporting the bank file.
      ownerName: shop.owner_name,
      accountNameMatches: identity.payoutNameMatches(shop, shop.owner_name),
      identity: { method: id.method, verified: id.verified, eidExpiry: id.eidExpiry || null },
    };
    const hold = holdReason(shop);
    if (shop.tier !== 'consignment' || !payoutSetupComplete(shop)) excluded.push({ ...row, reason: 'payout_setup_incomplete' });
    // Trove pays only makers whose identity is established (src/identity.js):
    // a verified licence, or Emirates ID details an admin checked and that
    // have not expired. Their credits wait, unswept, for a later run.
    else if (!id.verified) excluded.push({ ...row, reason: id.reason });
    else if (hold) excluded.push({ ...row, reason: hold });
    else if (net <= 0) excluded.push({ ...row, reason: 'netted_negative' });
    else eligible.push(row);
  }
  return {
    eligible,
    excluded,
    // The cut-off this preview used (UTC): Run settlement today uses the same.
    cutoffAt: runStart,
    totalNetCents: eligible.reduce((s, r) => s + r.netCents, 0),
    commissionPercent: fees.COMMISSION_PERCENT,
    // Service providers' fees for bookings paid through Trove, payable in the
    // same run (src/service-credits.js). Shown here; paid from /admin until
    // providers have payout details of their own.
    serviceCredits: require('./service-credits').preview(runStart),
  };
}

const badRequest = (msg) => { const e = new Error(msg); e.status = 400; return e; };

/**
 * The cut-off a run on `date` (YYYY-MM-DD, Dubai calendar) uses: a purchase is
 * in the run when its return window closed before this moment. A run made
 * today (the button, or the Tuesday cron) cuts at NOW — exactly what the
 * 'Next settlement run' card previews, so the card never promises a payment
 * the run then leaves out. A past date cuts at the end of that Dubai day.
 * A future date is refused: it would sweep credits whose return window is
 * still open.
 */
function cutoffFor(date) {
  const today = dubaiToday();
  if (!date || date === today) return nowSql();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) throw badRequest('runDate must be a date like 2026-10-06');
  if (date > today) throw badRequest('A settlement run can’t be dated in the future — purchases still inside their return window would be paid');
  // 24:00 in Dubai (UTC+4) is 20:00 UTC on the same date.
  return `${date} 20:00:00`;
}

/**
 * Create a draft settlement for runDate (YYYY-MM-DD, default today in Dubai):
 * one settlement_item per payable supplier, sweeping their credit AND debit
 * rows. Returns null when nothing is payable. Shops netting ≤ 0 or without
 * payout setup keep their rows unswept for a future run.
 */
function run(runDate) {
  const date = runDate || dubaiToday();
  const runStart = cutoffFor(date);
  return db.transaction(() => {
    const { eligible } = preview(runStart);
    if (!eligible.length) return null;
    const settlementId = db.prepare("INSERT INTO settlements (run_date, status, total_cents) VALUES (?, 'draft', 0)").run(date).lastInsertRowid;
    const stamp = db.prepare('UPDATE seller_balances SET settlement_id=? WHERE id=? AND settlement_id IS NULL');
    const perShop = gather(runStart);
    const items = [];
    for (const r of eligible) {
      const b = perShop.get(r.shopId);
      // The account the run is drafted against — ciphertext, holder and bank
      // — is copied onto the item: the bank file pays THIS account, so a
      // later change to the shop's live details cannot redirect the run.
      const acct = db.prepare('SELECT iban_encrypted, payout_account_name, payout_bank_name FROM shops WHERE id=?').get(r.shopId);
      const itemId = db.prepare(`INSERT INTO settlement_items
          (settlement_id, shop_id, amount_cents, credit_cents, debit_cents, item_count, bank_reference, bank_snapshot,
           iban_encrypted, payout_account_name, payout_bank_name)
        VALUES (?,?,?,?,?,?, '', ?, ?,?,?)`)
        .run(settlementId, r.shopId, r.netCents, r.creditCents, r.debitCents, r.itemCount, JSON.stringify(r.bank),
          acct.iban_encrypted, acct.payout_account_name, acct.payout_bank_name).lastInsertRowid;
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
  // The account copied at run time (items drafted before that copy existed
  // fall back to the shop's live details).
  const rows = db.prepare(`SELECT si.id, si.amount_cents, si.bank_reference, s.name AS shop_name,
      CASE WHEN si.iban_encrypted IS NOT NULL THEN si.payout_bank_name ELSE s.payout_bank_name END AS payout_bank_name,
      CASE WHEN si.iban_encrypted IS NOT NULL THEN si.payout_account_name ELSE s.payout_account_name END AS payout_account_name,
      COALESCE(si.iban_encrypted, s.iban_encrypted) AS iban_encrypted
    FROM settlement_items si JOIN shops s ON s.id = si.shop_id WHERE si.settlement_id=? ORDER BY si.id`).all(settlementId);
  const esc = require('./csv').csvCell;
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
  // The order is Run → Download the bank file → send the transfers → Mark
  // paid. A draft whose file was never downloaded cannot have been paid.
  if (st.status !== 'exported') { const e = new Error('Download the bank file and send the transfers first — then mark the run paid'); e.status = 409; throw e; }
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
  // Each maker gets a payment note, like providers do (best-effort).
  for (const it of items) require('./notify').makerPaid({ shopId: it.shop_id, amountCents: it.amount_cents, reference: it.bank_reference, runDate: st.run_date });
  return db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
}

/** How long after 'Mark paid' the admin can still undo it. */
const UNDO_PAID_HOURS = 48;

/**
 * Cancel a draft or exported run (a wrong IBAN, a run made by mistake): every
 * ledger row it swept is un-stamped, so the money waits for the next run
 * exactly as before, and the run is removed. Nothing is recorded as paid. If
 * the bank file was already downloaded, none of its lines may be sent — the
 * caller says so.
 */
function cancelRun(settlementId) {
  const st = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  if (!st) { const e = new Error('Settlement not found'); e.status = 404; throw e; }
  if (st.status === 'paid') { const e = new Error('This run is marked paid — use Undo paid first (within 48 hours)'); e.status = 409; throw e; }
  db.transaction(() => {
    db.prepare("UPDATE seller_balances SET settlement_id=NULL WHERE settlement_id=? AND type IN ('credit_sale','debit_refund')").run(settlementId);
    db.prepare('DELETE FROM settlement_items WHERE settlement_id=?').run(settlementId);
    db.prepare('DELETE FROM settlements WHERE id=?').run(settlementId);
  })();
  return { cancelled: st.id, wasExported: st.status === 'exported', totalCents: st.total_cents };
}

/**
 * Undo 'Mark paid' within UNDO_PAID_HOURS (it was clicked before the
 * transfers really went out): the negative payout rows and the purchase notes
 * go, and the run is back to 'exported' — ready to mark paid again, or to
 * cancel. The makers were emailed a payment note; the caller tells the admin
 * to let them know.
 */
function undoPaid(settlementId, now = Date.now()) {
  const st = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  if (!st) { const e = new Error('Settlement not found'); e.status = 404; throw e; }
  if (st.status !== 'paid') { const e = new Error('Only a run marked paid can be undone'); e.status = 409; throw e; }
  const paidAt = Date.parse(String(st.paid_at).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(paidAt) || now - paidAt > UNDO_PAID_HOURS * 3600000) {
    const e = new Error(`'Mark paid' can only be undone within ${UNDO_PAID_HOURS} hours`); e.status = 409; throw e;
  }
  const notes = db.prepare(`SELECT pn.id, pn.html_path FROM purchase_notes pn JOIN settlement_items si ON si.id = pn.settlement_item_id
    WHERE si.settlement_id=?`).all(settlementId);
  db.transaction(() => {
    db.prepare("DELETE FROM seller_balances WHERE settlement_id=? AND type='payout'").run(settlementId);
    for (const n of notes) db.prepare('DELETE FROM purchase_notes WHERE id=?').run(n.id);
    db.prepare("UPDATE settlements SET status='exported', paid_at=NULL WHERE id=?").run(settlementId);
  })();
  for (const n of notes) { try { fs.unlinkSync(n.html_path); } catch (_) { /* already gone */ } }
  return db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
}

/**
 * Take one supplier out of a draft or exported run (an investigation, a
 * bank change to check): the item is deleted and its ledger rows are
 * un-stamped, so they wait for a later run exactly as before and nothing is
 * recorded as paid. With `hold`, the shop's payouts are also put on hold so
 * the next run does not sweep them straight back in. A paid run cannot be
 * changed. If the run was already exported, that supplier's line in the
 * downloaded bank file must not be sent — the caller says so.
 */
function removeItem(settlementId, itemId, { hold = false } = {}) {
  const st = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
  if (!st) { const e = new Error('Settlement not found'); e.status = 404; throw e; }
  if (st.status === 'paid') { const e = new Error('This run is already paid — it can no longer be changed'); e.status = 409; throw e; }
  const item = db.prepare('SELECT * FROM settlement_items WHERE id=? AND settlement_id=?').get(itemId, settlementId);
  if (!item) { const e = new Error('That supplier is not in this run'); e.status = 404; throw e; }
  db.transaction(() => {
    db.prepare("UPDATE seller_balances SET settlement_id=NULL WHERE settlement_id=? AND shop_id=? AND type IN ('credit_sale','debit_refund')")
      .run(settlementId, item.shop_id);
    db.prepare('DELETE FROM settlement_items WHERE id=?').run(item.id);
    db.prepare('UPDATE settlements SET total_cents=(SELECT COALESCE(SUM(amount_cents),0) FROM settlement_items WHERE settlement_id=?) WHERE id=?')
      .run(settlementId, settlementId);
    if (hold) setHold(item.shop_id, true);
  })();
  return { removed: item.id, shopId: item.shop_id, amountCents: item.amount_cents, wasExported: st.status === 'exported' };
}

/** Put a shop's payouts on hold ('manual'), or release any hold (incl. a bank-change hold). */
function setHold(shopId, on) {
  return db.prepare(on
    ? "UPDATE shops SET payout_hold=1, payout_hold_reason='manual' WHERE id=?"
    : "UPDATE shops SET payout_hold=0, payout_hold_reason='' WHERE id=?").run(shopId).changes > 0;
}

/**
 * The lines a purchase note lists for one order of one shop: only the units
 * Trove actually bought — units refunded through a return before the run are
 * listed apart as returned, never as purchased (returns.refundedUnitsSql).
 */
// Units Trove cancelled before dispatch were never bought from the maker.
const NOTE_LINES = `SELECT oi.name_snapshot, oi.qty - oi.cancelled_qty AS qty, oi.price_cents,
    COALESCE((SELECT SUM(ri.qty) FROM return_request_items ri
      JOIN return_requests r2 ON r2.id = ri.request_id
      WHERE ri.order_item_id = oi.id AND r2.status = 'refunded'), 0) AS returned
  FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.public_id=? AND oi.shop_id=? AND oi.qty > oi.cancelled_qty ORDER BY oi.id`;
function noteLines(publicId, shopId) {
  const kept = [], returned = [];
  for (const l of db.prepare(NOTE_LINES).all(publicId, shopId)) {
    const back = Math.min(l.qty, Math.max(0, l.returned));
    if (l.qty - back > 0) kept.push({ name: l.name_snapshot, qty: l.qty - back, priceCents: l.price_cents });
    if (back > 0) returned.push({ name: l.name_snapshot, qty: back, priceCents: l.price_cents });
  }
  return { kept, returned, grossCents: kept.reduce((s, l) => s + l.priceCents * l.qty, 0) };
}

/** Self-billed purchase documentation: Trove generates the supplier's paper trail. */
function generatePurchaseNote(item, settlement) {
  const shop = db.prepare('SELECT s.*, u.name AS owner_name FROM shops s JOIN users u ON u.id=s.user_id WHERE s.id=?').get(item.shop_id);
  const orders = db.prepare(`
    SELECT b.amount_cents, o.public_id, o.created_at
    FROM seller_balances b JOIN orders o ON o.id = b.order_id
    WHERE b.settlement_id=? AND b.shop_id=? AND b.type='credit_sale' ORDER BY o.created_at`).all(settlement.id, item.shop_id);
  const aed = (c) => `AED ${(c / 100).toFixed(2)}`;
  const h = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const orderBlocks = orders.map((o) => {
    const { kept, returned, grossCents: gross } = noteLines(o.public_id, item.shop_id);
    const back = returned.length
      ? `<br><span class="muted">Returned — not purchased: ${returned.map((l) => `${l.qty} × ${h(l.name)}`).join(', ')}</span>` : '';
    return `<tr><td>${o.public_id}</td><td>${o.created_at.slice(0, 10)}</td>
      <td>${kept.map((l) => `${l.qty} × ${h(l.name)}`).join('<br>')}${back}</td>
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
<p><strong>Supplier:</strong> ${h(shop.name)} (${h(shop.owner_name)})<br>
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

/** The last run date on or before `from` (YYYY-MM-DD, default today in Dubai). */
function lastRunDate(from = dubaiToday()) {
  const f = toDay(from), a = toDay(fees.SETTLEMENT_ANCHOR_DATE), n = interval();
  const k = Math.floor((f - a) / n);
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
  preview, run, cutoffFor, exportCsv, markPaid, cancelRun, undoPaid, UNDO_PAID_HOURS, removeItem, setHold, holdReason, noteLines, balances, payoutSetupComplete, ELIGIBLE_CREDITS,
  isRunDate, nextRunDate, lastRunDate, upcomingRunDates, scheduleLabel, dubaiToday,
};
