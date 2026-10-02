'use strict';
/**
 * Manual provider payouts (owner, 2026-09-30: 'providers get paid with manual
 * bank transfers from my business, Serein Consultancy').
 *
 *   bank details   provider_payout_details — holder, bank and a UAE IBAN
 *                  checked with the same validator as the seller payout setup
 *                  (validate.ibanError) and encrypted with the same key and
 *                  envelope as shops.iban_encrypted (src/crypto.js). The API
 *                  only ever returns the masked IBAN. A provider who also runs
 *                  a shop can copy the shop's details: the ciphertext is copied
 *                  server-side and never passes through the client.
 *   statement      the provider's own credits with a status each: provisional
 *                  (may change), ready (paid in the run on a date) or paid.
 *   transfer file  exportCsv() — the ONLY place a provider IBAN is decrypted,
 *                  mirroring settlement.exportCsv for shops. Admin-only route,
 *                  payable providers with bank details only.
 *
 * The ledger rules themselves (what is payable when) stay in service-credits.js.
 */
const db = require('./db');
const pcrypto = require('./crypto');
const credits = require('./service-credits');

const MASKED = (row) => (row ? {
  accountName: row.account_name, bankName: row.bank_name, iban: row.iban_masked,
  source: row.source, updatedAt: row.updated_at,
  // A change waits for Trove's check before the first payment goes to it.
  held: !!row.hold_reason,
} : null);

const detailsRow = (providerId) => db.prepare('SELECT * FROM provider_payout_details WHERE provider_id=?').get(providerId);

/** The provider's bank details as the API shows them (masked), or null. */
const getDetails = (providerId) => MASKED(detailsRow(providerId));

/** The account's own shop, when it has verified payout details on file. */
function shopWithBank(userId) {
  const s = db.prepare('SELECT id, name, payout_bank_name, payout_account_name, iban_masked, iban_encrypted FROM shops WHERE user_id=?').get(userId);
  return s && s.iban_encrypted ? s : null;
}

function upsert(providerId, { accountName, bankName, ibanEncrypted, ibanMasked, source }) {
  db.prepare(`INSERT INTO provider_payout_details (provider_id, account_name, bank_name, iban_encrypted, iban_masked, source, updated_at)
      VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(provider_id) DO UPDATE SET account_name=excluded.account_name, bank_name=excluded.bank_name,
      iban_encrypted=excluded.iban_encrypted, iban_masked=excluded.iban_masked, source=excluded.source, updated_at=excluded.updated_at`)
    .run(providerId, accountName, bankName, ibanEncrypted, ibanMasked, source);
}

const fail = (status, error) => ({ status, error });

/**
 * Save bank details. `body` is either { accountName, bankName, iban } or
 * { useShop: true }, plus `currentPassword` when details are already on file.
 * `req` (the request) carries the signed-in owner for that step-up check.
 * Changing details already on file:
 *   - needs the account password again (never possible while an admin views
 *     the dashboard) — middleware.confirmOwner
 *   - puts the provider's payouts on hold ('bank_details_changed') until the
 *     owner checks it in Admin → Provider payouts, so a hijacked account
 *     cannot redirect the next transfer
 * Every save emails the account owner (masked IBAN only).
 * Returns { details } or { status, error, code? }.
 */
function saveDetails(provider, body = {}, req = null) {
  const existing = detailsRow(provider.id);
  if (existing && req) {
    const authErr = require('./middleware').confirmOwner(req, body.currentPassword);
    if (authErr) return authErr;
  }
  let next;
  if (body.useShop === true) {
    const shop = shopWithBank(provider.user_id);
    if (!shop) return fail(409, 'Your shop has no bank details on file yet — add them here instead');
    next = {
      accountName: shop.payout_account_name, bankName: shop.payout_bank_name,
      ibanEncrypted: shop.iban_encrypted, ibanMasked: shop.iban_masked, source: 'shop',
    };
  } else {
    const v = require('./validate');
    const accountName = String(body.accountName || '').trim().slice(0, 120);
    const bankName = String(body.bankName || '').trim().slice(0, 120);
    if (!accountName || !bankName) return fail(400, 'The account holder name and the bank name are both needed');
    const nameErr = v.payoutNamesError(accountName, bankName);
    if (nameErr) return fail(400, nameErr);
    const iban = String(body.iban || '').replace(/\s+/g, '').toUpperCase();
    const ibanErr = v.ibanError(iban);
    if (ibanErr) return fail(400, ibanErr);
    if (!pcrypto.hasKey()) return fail(503, 'Bank details are temporarily unavailable (encryption key not configured)');
    next = { accountName, bankName, ibanEncrypted: pcrypto.encrypt(iban), ibanMasked: pcrypto.maskIban(iban), source: 'own' };
  }
  // A different account (not a first save, and not the same IBAN saved
  // again) holds the next payment for the owner's check.
  const changed = !!existing && !pcrypto.sameIban(existing.iban_encrypted, next.ibanEncrypted);
  db.transaction(() => {
    upsert(provider.id, next);
    if (changed) {
      db.prepare("UPDATE provider_payout_details SET hold_reason='bank_details_changed', changed_at=datetime('now') WHERE provider_id=?").run(provider.id);
    }
  })();
  const owner = db.prepare('SELECT * FROM users WHERE id=?').get(provider.user_id);
  if (!existing || changed || existing.account_name !== next.accountName || existing.bank_name !== next.bankName) {
    require('./notify').bankDetailsChanged(owner, {
      kind: 'provider', businessName: provider.name, bankName: next.bankName, iban: next.ibanMasked, held: changed,
    });
  }
  return { details: getDetails(provider.id) };
}

/** Admin: the owner checked a bank change — release the hold. */
function releaseHold(providerId) {
  return db.prepare("UPDATE provider_payout_details SET hold_reason='' WHERE provider_id=? AND hold_reason<>''").run(providerId).changes > 0;
}

/**
 * The provider's own statement: every fee Trove owes or has paid them, newest
 * first. Only booking code, service, date and their fee — nothing about the
 * customer. An unpaid fee is 'provisional' (service date + complaint window
 * not passed — it may change if the booking is cancelled) or 'ready' (paid in
 * the run on `payoutOn`).
 */
function statement(providerId, today = credits.dubaiToday()) {
  const rows = db.prepare(`SELECT c.*, bk.code, bk.title, bk.service_date, bk.status AS booking_status, bk.completed_at, bk.refunded_at
    FROM provider_credits c JOIN service_bookings bk ON bk.id = c.booking_id
    WHERE c.provider_id=? ORDER BY c.id DESC LIMIT 200`).all(providerId);
  return rows.map((c) => {
    const base = {
      id: c.id, code: c.code, title: c.title, serviceDate: c.service_date || null, amountCents: c.amount_cents,
      kind: c.type === 'debit_refund' ? 'adjustment' : 'fee',
    };
    if (c.paid_at) return { ...base, status: 'paid', paidOn: c.paid_at.slice(0, 10), reference: c.pay_reference, payer: c.payer_name || '' };
    if (c.type === 'debit_refund') return { ...base, status: 'deducted' };
    if (c.voided_at || c.refunded_at) return { ...base, status: 'refunded' };
    const readyOn = credits.readyFrom(c.service_date);
    const payoutOn = readyOn ? credits.payoutDateFor(readyOn, today) : null;
    return { ...base, status: readyOn && readyOn <= today ? 'ready' : 'provisional', readyOn, payoutOn };
  });
}

/** Does the provider have a paid Trove booking (so bank details are needed)? */
const hasPaidBooking = (providerId) => !!db.prepare(
  "SELECT 1 FROM service_bookings WHERE provider_id=? AND payment_method='trove' AND paid_at IS NOT NULL LIMIT 1").get(providerId);

/* ---------------- the frozen transfer batch (F105) ----------------
 * Downloading the transfer file freezes, per provider, exactly which credit
 * and debit rows, which amount and which reference went into it
 * (provider_payout_batches). 'Mark paid' then closes THAT batch — never
 * whatever happens to be payable on the day of the click, and always with the
 * reference that was on the bank transfer. Downloading again with the same
 * rows keeps the batch (and its reference); with different rows the old open
 * batch is replaced by the new file's. */
const ids = (a) => JSON.stringify([...a].map(Number).sort((x, y) => x - y));

/** The provider's open (downloaded, not yet paid) batch, or null. */
function openBatch(providerId) {
  const b = db.prepare(`SELECT * FROM provider_payout_batches
    WHERE provider_id=? AND paid_at IS NULL AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(providerId);
  if (!b) return null;
  return { id: b.id, providerId: b.provider_id, reference: b.reference, amountCents: b.amount_cents,
    creditIds: JSON.parse(b.credit_ids || '[]'), debitIds: JSON.parse(b.debit_ids || '[]'), createdAt: b.created_at };
}

/** Freeze (or reuse) the batch for one provider row of the transfer file. */
function freezeBatch(r) {
  const open = openBatch(r.providerId);
  if (open && ids(open.creditIds) === ids(r.creditIds) && ids(open.debitIds) === ids(r.debitIds) && open.amountCents === r.netCents) return open;
  return db.transaction(() => {
    if (open) db.prepare("UPDATE provider_payout_batches SET superseded_at=datetime('now') WHERE id=?").run(open.id);
    db.prepare(`INSERT INTO provider_payout_batches (provider_id, reference, amount_cents, credit_ids, debit_ids)
      VALUES (?,?,?,?,?)`).run(r.providerId, r.reference, r.netCents, ids(r.creditIds), ids(r.debitIds));
    return openBatch(r.providerId);
  })();
}

/**
 * Bank transfer file for every provider payable now WITH bank details —
 * providers still waiting for bank details are left out. Decrypts straight
 * into the response; never logged or stored. Each line's batch is frozen.
 */
function exportCsv(runStart) {
  const pv = credits.preview(runStart);
  const esc = require('./csv').csvCell;
  const lines = ['provider,account_name,bank,iban,amount_aed,reference,bookings'];
  let count = 0;
  for (const r of pv.eligible) {
    const d = detailsRow(r.providerId);
    if (!d) continue;
    const batch = freezeBatch(r);
    lines.push([esc(r.name), esc(d.account_name), esc(d.bank_name), esc(pcrypto.decrypt(d.iban_encrypted)),
      (batch.amountCents / 100).toFixed(2), esc(batch.reference), esc(r.bookings.map((b) => b.code).join(' '))].join(','));
    count += 1;
  }
  return { csv: lines.join('\r\n') + '\r\n', count };
}

/**
 * 'Mark paid' for a downloaded batch: stamps exactly the rows that were in
 * the transfer file (those not already paid) with the reference and payer. A
 * fee in the file whose booking was refunded after the download was still
 * sent, so it is stamped paid and a refund debit is written for the next
 * transfer — the books match the bank. `expectCents` (what the admin saw)
 * must match the batch. Returns the payment, or { status, error }, or null
 * when there is no open batch.
 */
function closeBatch(providerId, { reference, expectCents, payer = credits.payerName() } = {}) {
  const b = openBatch(providerId);
  if (!b) return null;
  if (expectCents !== undefined && Number(expectCents) !== b.amountCents) {
    return { status: 409, error: 'That is not the amount in the transfer file you downloaded — refresh the page and check the file' };
  }
  const ref = String(reference || '').trim().slice(0, 120) || b.reference;
  const credit = db.prepare('SELECT * FROM provider_credits WHERE id=?');
  const stamp = db.prepare("UPDATE provider_credits SET paid_at=datetime('now'), pay_reference=?, payer_name=? WHERE id=? AND paid_at IS NULL");
  const bookings = [];
  let debitCents = 0;
  db.transaction(() => {
    for (const id of b.creditIds) {
      const c = credit.get(id);
      if (!c || c.paid_at) continue;
      stamp.run(ref, payer, id);
      if (c.voided_at) {
        db.prepare('UPDATE provider_credits SET voided_at=NULL WHERE id=?').run(id);
        const has = db.prepare("SELECT 1 FROM provider_credits WHERE booking_id=? AND type='debit_refund'").get(c.booking_id);
        if (!has) db.prepare("INSERT INTO provider_credits (provider_id, booking_id, type, amount_cents) VALUES (?,?, 'debit_refund', ?)").run(c.provider_id, c.booking_id, -c.amount_cents);
      }
      const bk = db.prepare('SELECT code, title, service_date FROM service_bookings WHERE id=?').get(c.booking_id);
      if (bk) bookings.push({ code: bk.code, title: bk.title, serviceDate: bk.service_date, netCents: c.amount_cents });
    }
    for (const id of b.debitIds) {
      const d = credit.get(id);
      if (!d || d.paid_at) continue;
      stamp.run(ref, payer, id);
      debitCents += d.amount_cents;
    }
    db.prepare("UPDATE provider_payout_batches SET paid_at=datetime('now'), payer_name=?, reference=? WHERE id=?").run(payer, ref, b.id);
  })();
  const p = db.prepare('SELECT p.id, p.name, u.name AS owner_name, u.email AS owner_email FROM service_providers p JOIN users u ON u.id=p.user_id WHERE p.id=?').get(providerId);
  return {
    providerId: Number(providerId), name: p ? p.name : '', owner: p ? { name: p.owner_name, email: p.owner_email } : null,
    amountCents: b.amountCents, debitCents, reference: ref, payer, bookings, rows: b.creditIds.length + b.debitIds.length,
  };
}

module.exports = { getDetails, saveDetails, releaseHold, shopWithBank, statement, hasPaidBooking, exportCsv, openBatch, closeBatch };
