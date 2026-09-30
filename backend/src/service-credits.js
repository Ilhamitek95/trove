'use strict';
/**
 * What Trove owes service providers for bookings paid through Trove.
 *
 * Trove engages the provider as an independent contractor for a 'trove'
 * booking, so the provider's fee (the amount paid minus the platform fee —
 * service_bookings.provider_net_cents) is a debt Trove pays in its regular
 * settlement run by bank transfer:
 *
 *   credit_service  written when the payment lands (one per booking)
 *        │          voided if the booking is refunded before it is paid out
 *        ▼
 *   eligible        the provider marked the booking done, or 3 days have
 *                   passed since the service date, and it was never refunded
 *        ▼
 *   paid            paid_at + pay_reference stamped once the transfer went out
 *
 * A refund after the credit was paid out writes a negative debit_refund row
 * that nets against the provider's next payment.
 *
 * SETTLEMENT HOOK: settlement.js calls eligibleServiceCredits(runStart) (via
 * preview) so a run shows what providers are owed. The consignment run itself
 * (settlement_items, the bank CSV) is keyed on shops and their encrypted IBANs;
 * providers have no payout details of their own yet, so provider credits are
 * paid by hand from /admin and closed with markPaid() — see the report.
 */
const db = require('./db');

const GRACE_DAYS = 3; // a booking nobody marked done becomes payable this long after the service date

/** Record the provider's fee for a booking that has just been paid. */
function creditBooking(bk) {
  if (!bk || bk.payment_method !== 'trove' || !bk.paid_at) return;
  db.prepare(`INSERT OR IGNORE INTO provider_credits (provider_id, booking_id, type, amount_cents)
    VALUES (?,?, 'credit_service', ?)`).run(bk.provider_id, bk.id, bk.provider_net_cents);
}

/** A refunded booking: void the credit if unpaid, else debit the next run. */
function reverseBooking(bk) {
  const credit = db.prepare("SELECT * FROM provider_credits WHERE booking_id=? AND type='credit_service'").get(bk.id);
  if (!credit || credit.voided_at) return;
  if (!credit.paid_at) {
    db.prepare("UPDATE provider_credits SET voided_at=datetime('now') WHERE id=?").run(credit.id);
    return;
  }
  const already = db.prepare("SELECT 1 FROM provider_credits WHERE booking_id=? AND type='debit_refund'").get(bk.id);
  if (!already) {
    db.prepare(`INSERT INTO provider_credits (provider_id, booking_id, type, amount_cents)
      VALUES (?,?, 'debit_refund', ?)`).run(credit.provider_id, bk.id, -credit.amount_cents);
  }
}

/* The one eligibility rule. `runStart` is 'YYYY-MM-DD HH:MM:SS'. */
const ELIGIBLE = `
  SELECT c.id, c.provider_id, c.booking_id, c.amount_cents, bk.code, bk.title, bk.service_date, bk.completed_at,
         bk.amount_cents AS paid_cents, bk.commission_cents
  FROM provider_credits c JOIN service_bookings bk ON bk.id = c.booking_id
  WHERE c.type = 'credit_service' AND c.paid_at IS NULL AND c.voided_at IS NULL AND c.settlement_id IS NULL
    AND bk.refunded_at IS NULL AND bk.paid_at IS NOT NULL
    AND (
      (bk.status = 'completed' AND bk.completed_at < ?)
      OR (bk.status IN ('confirmed','completed') AND bk.service_date IS NOT NULL
          AND date(bk.service_date, '+${GRACE_DAYS} days') <= date(?))
    )`;
const OPEN_DEBITS = `SELECT id, provider_id, booking_id, amount_cents FROM provider_credits
  WHERE type='debit_refund' AND paid_at IS NULL AND settlement_id IS NULL`;

const nowSql = () => db.prepare("SELECT datetime('now') AS t").get().t;

/** Every payable service credit as of runStart (flat rows). */
function eligibleServiceCredits(runStart = nowSql()) {
  return db.prepare(ELIGIBLE).all(runStart, runStart);
}

/**
 * Grouped per provider: what each is owed now, how, and why someone is held
 * back. `payTo` is the provider account's approved shop payout details when it
 * has them (masked IBAN only) — the consignment run's bank details.
 */
function preview(runStart = nowSql()) {
  const per = new Map();
  const bucket = (id) => {
    if (!per.has(id)) per.set(id, { creditIds: [], debitIds: [], creditCents: 0, debitCents: 0, bookings: [] });
    return per.get(id);
  };
  for (const c of eligibleServiceCredits(runStart)) {
    const b = bucket(c.provider_id);
    b.creditIds.push(c.id); b.creditCents += c.amount_cents;
    b.bookings.push({ code: c.code, title: c.title, serviceDate: c.service_date, paidCents: c.paid_cents, feeCents: c.commission_cents, netCents: c.amount_cents });
  }
  for (const d of db.prepare(OPEN_DEBITS).all()) {
    const b = bucket(d.provider_id);
    b.debitIds.push(d.id); b.debitCents += d.amount_cents;
  }
  const eligible = [], excluded = [];
  for (const [providerId, b] of per) {
    const p = db.prepare(`SELECT p.id, p.name, p.slug, u.name AS owner_name, u.email AS owner_email,
        s.payout_bank_name, s.payout_account_name, s.iban_masked, s.iban_encrypted
      FROM service_providers p JOIN users u ON u.id = p.user_id
      LEFT JOIN shops s ON s.user_id = p.user_id AND s.status = 'approved'
      WHERE p.id = ?`).get(providerId);
    const row = {
      providerId, name: p ? p.name : `Provider ${providerId}`, slug: p ? p.slug : '',
      owner: p ? { name: p.owner_name, email: p.owner_email } : null,
      creditCents: b.creditCents, debitCents: b.debitCents, netCents: b.creditCents + b.debitCents,
      creditIds: b.creditIds, debitIds: b.debitIds, bookings: b.bookings,
      payTo: p && p.iban_encrypted ? { bank: p.payout_bank_name, accountName: p.payout_account_name, iban: p.iban_masked } : null,
    };
    if (row.netCents <= 0) excluded.push({ ...row, reason: 'netted_negative' });
    else if (!row.payTo) excluded.push({ ...row, reason: 'payout_details_missing' });
    else eligible.push(row);
  }
  return {
    eligible, excluded,
    totalNetCents: eligible.reduce((s, r) => s + r.netCents, 0),
    owedCents: [...eligible, ...excluded].reduce((s, r) => s + Math.max(0, r.netCents), 0),
  };
}

/**
 * Close a provider's currently payable rows once the bank transfer went out
 * (manual payout from /admin). Stamps exactly the rows the preview showed.
 */
function markPaid(providerId, reference, runStart = nowSql()) {
  const pv = preview(runStart);
  const row = [...pv.eligible, ...pv.excluded]
    .find((r) => r.providerId === Number(providerId) && r.netCents > 0);
  if (!row) return null;
  const ref = String(reference || '').trim().slice(0, 120) || `Trove service fees — provider ${providerId}`;
  const stamp = db.prepare("UPDATE provider_credits SET paid_at=datetime('now'), pay_reference=? WHERE id=? AND paid_at IS NULL");
  db.transaction(() => { for (const id of [...row.creditIds, ...row.debitIds]) stamp.run(ref, id); })();
  return { providerId: row.providerId, amountCents: row.netCents, reference: ref, rows: row.creditIds.length + row.debitIds.length };
}

/** A provider's own money view. */
function providerBalances(providerId, runStart = nowSql()) {
  const payable = eligibleServiceCredits(runStart).filter((c) => c.provider_id === providerId).reduce((s, c) => s + c.amount_cents, 0);
  const debits = db.prepare(OPEN_DEBITS + ' AND provider_id=?').all(providerId).reduce((s, d) => s + d.amount_cents, 0);
  const open = db.prepare(`SELECT COALESCE(SUM(c.amount_cents),0) AS t FROM provider_credits c JOIN service_bookings bk ON bk.id=c.booking_id
    WHERE c.provider_id=? AND c.type='credit_service' AND c.paid_at IS NULL AND c.voided_at IS NULL AND bk.refunded_at IS NULL`).get(providerId).t;
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM provider_credits WHERE provider_id=? AND paid_at IS NOT NULL').get(providerId).t;
  return { pendingCents: open - payable, payableCents: payable + debits, paidCents: paid };
}

module.exports = { GRACE_DAYS, creditBooking, reverseBooking, eligibleServiceCredits, preview, markPaid, providerBalances };
