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
 *   provisional     until the service date has passed AND the complaint /
 *                   cancellation window (fees.SERVICE_COMPLAINT_WINDOW_DAYS)
 *                   has closed — it may still change if the booking is
 *                   cancelled or refunded. Marking a booking done does NOT
 *                   make it payable early (owner, 2026-10-02)
 *        ▼
 *   ready           window closed, never refunded: paid in the next
 *                   fortnightly run, on the same Tuesdays as makers
 *                   (settlement.isRunDate). A credit counts for the run
 *                   whose date is AFTER its window closed, so the admin's
 *                   batch is always cut at the latest run date
 *        ▼
 *   paid            paid_at + pay_reference stamped once the transfer went out
 *
 * A refund after the credit was paid out writes a negative debit_refund row
 * that nets against the provider's next payment.
 *
 * SETTLEMENT HOOK: settlement.js calls eligibleServiceCredits(runStart) (via
 * preview) so a run shows what providers are owed. The consignment run itself
 * (settlement_items, the bank CSV) is keyed on shops and never pays these.
 *
 * MANUAL PAYOUTS (owner, 2026-09-30): providers are paid by bank transfer from
 * Serein Consultancy on Trove's behalf (PROVIDER_PAYER_NAME). Each provider
 * keeps its own bank details in provider_payout_details (IBAN encrypted like a
 * shop's — see src/provider-payouts.js); admin downloads the provider transfer
 * file, sends the transfers, then closes each provider's batch with markPaid(),
 * which stamps paid_at, the reference and the payer on every row.
 */
const db = require('./db');
const fees = require('./fees');
const settlement = require('./settlement');

// The complaint / cancellation window after the service date. A fee is ready
// from the day after the window closes: service on the 10th, window 3 days →
// ready on the 14th, paid in the first run on or after that.
const GRACE_DAYS = Math.max(0, Math.round(fees.SERVICE_COMPLAINT_WINDOW_DAYS));

/** Who sends provider transfers — shown to providers and on their statement. */
const payerName = () => String(process.env.PROVIDER_PAYER_NAME || '').trim() || 'Serein Consultancy LLC'; // the company behind Trove (owner, 2026-10-02)

/** Today's date on the Dubai calendar (UTC+4, no daylight saving). */
const dubaiToday = (now = Date.now()) => new Date(now + 4 * 3600000).toISOString().slice(0, 10);

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** The first day a fee for a service on `serviceDate` is ready (window closed). */
const readyFrom = (serviceDate) => (serviceDate ? addDays(serviceDate, GRACE_DAYS + 1) : null);
/** The run a fee ready on `day` goes out in: the first run date on or after
 *  it, but never before the current fortnight's run (a fee that waited for
 *  bank details goes out with the batch being sent now). */
const payoutDateFor = (day, today = dubaiToday()) => {
  const last = settlement.lastRunDate(today);
  return settlement.nextRunDate(day > last ? day : last);
};
/** The cut-off of the current fortnight's provider batch: the latest run date
 *  on or before today (Dubai), as a runStart timestamp. */
const currentCutoff = (today = dubaiToday()) => `${settlement.lastRunDate(today)} 00:00:00`;

/** The bank reference for a provider's batch: TRV-SVC-<provider id>-<yyyymmdd>. */
const payReference = (providerId, day = dubaiToday()) => `TRV-SVC-${Number(providerId)}-${String(day).replace(/-/g, '')}`;

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

/* The one eligibility rule. `runStart` is 'YYYY-MM-DD HH:MM:SS' — the run
 * date. Payable only once the service date has passed and the complaint
 * window closed BEFORE the run day; 'completed' (marked done) changes
 * nothing about when it is paid. */
const ELIGIBLE = `
  SELECT c.id, c.provider_id, c.booking_id, c.amount_cents, bk.code, bk.title, bk.service_date, bk.completed_at,
         bk.amount_cents AS paid_cents, bk.commission_cents
  FROM provider_credits c JOIN service_bookings bk ON bk.id = c.booking_id
  WHERE c.type = 'credit_service' AND c.paid_at IS NULL AND c.voided_at IS NULL AND c.settlement_id IS NULL
    AND bk.refunded_at IS NULL AND bk.paid_at IS NOT NULL
    AND bk.status IN ('confirmed','completed') AND bk.service_date IS NOT NULL
    AND date(bk.service_date, '+${GRACE_DAYS} days') < date(?)`;
const OPEN_DEBITS = `SELECT id, provider_id, booking_id, amount_cents FROM provider_credits
  WHERE type='debit_refund' AND paid_at IS NULL AND settlement_id IS NULL`;


/** Every payable service credit as of runStart (flat rows). Default: the
 *  current fortnight's run date. */
function eligibleServiceCredits(runStart = currentCutoff()) {
  return db.prepare(ELIGIBLE).all(runStart);
}

/**
 * Grouped per provider: what each is owed now, how, and why someone is held
 * back. `payTo` is the provider's own payout details (masked IBAN only) from
 * provider_payout_details; without them the provider waits for bank details.
 */
function preview(runStart = currentCutoff()) {
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
        p.status AS provider_status, d.hold_reason,
        d.bank_name AS payout_bank_name, d.account_name AS payout_account_name, d.iban_masked, d.provider_id AS has_details
      FROM service_providers p JOIN users u ON u.id = p.user_id
      LEFT JOIN provider_payout_details d ON d.provider_id = p.id
      WHERE p.id = ?`).get(providerId);
    const row = {
      providerId, name: p ? p.name : `Provider ${providerId}`, slug: p ? p.slug : '',
      owner: p ? { name: p.owner_name, email: p.owner_email } : null,
      creditCents: b.creditCents, debitCents: b.debitCents, netCents: b.creditCents + b.debitCents,
      creditIds: b.creditIds, debitIds: b.debitIds, bookings: b.bookings,
      reference: payReference(providerId),
      payTo: p && p.has_details ? { bank: p.payout_bank_name, accountName: p.payout_account_name, iban: p.iban_masked } : null,
    };
    if (row.netCents <= 0) excluded.push({ ...row, reason: 'netted_negative' });
    else if (!row.payTo) excluded.push({ ...row, reason: 'payout_details_missing' });
    else if (p && p.provider_status === 'suspended') excluded.push({ ...row, reason: 'on_hold' });
    else if (p && p.hold_reason) excluded.push({ ...row, reason: p.hold_reason });
    else eligible.push(row);
  }
  return {
    eligible, excluded,
    runDate: String(runStart).slice(0, 10),
    nextRunDate: settlement.nextRunDate(addDays(String(runStart).slice(0, 10), 1)),
    schedule: settlement.scheduleLabel(),
    complaintWindowDays: GRACE_DAYS,
    totalNetCents: eligible.reduce((s, r) => s + r.netCents, 0),
    owedCents: [...eligible, ...excluded].reduce((s, r) => s + Math.max(0, r.netCents), 0),
  };
}

/**
 * Close a provider's currently payable rows once the bank transfer went out
 * (manual payout from /admin). Stamps exactly the rows the preview showed,
 * with the reference and who sent the money.
 */
function markPaid(providerId, reference, runStart = currentCutoff(), { payer = payerName() } = {}) {
  const pv = preview(runStart);
  const row = [...pv.eligible, ...pv.excluded]
    .find((r) => r.providerId === Number(providerId) && r.netCents > 0);
  if (!row) return null;
  const ref = String(reference || '').trim().slice(0, 120) || payReference(providerId);
  const stamp = db.prepare("UPDATE provider_credits SET paid_at=datetime('now'), pay_reference=?, payer_name=? WHERE id=? AND paid_at IS NULL");
  db.transaction(() => { for (const id of [...row.creditIds, ...row.debitIds]) stamp.run(ref, payer, id); })();
  return {
    providerId: row.providerId, name: row.name, owner: row.owner, amountCents: row.netCents, debitCents: row.debitCents,
    reference: ref, payer, bookings: row.bookings, hasBankDetails: !!row.payTo, rows: row.creditIds.length + row.debitIds.length,
  };
}

/**
 * A provider's own money view (owner, 2026-10-02):
 *   provisionalCents  fees whose service date + complaint window has not
 *                     passed yet — may change if the booking is cancelled
 *   readyCents        window closed, waiting for the fortnightly run
 *                     (net of any refund adjustment still to deduct)
 *   nextPayoutDate    the run the ready money goes out in
 * pendingCents / payableCents carry the same two figures under their old names.
 */
function providerBalances(providerId, today = dubaiToday()) {
  const open = db.prepare(`SELECT c.amount_cents, bk.service_date FROM provider_credits c JOIN service_bookings bk ON bk.id=c.booking_id
    WHERE c.provider_id=? AND c.type='credit_service' AND c.paid_at IS NULL AND c.voided_at IS NULL AND bk.refunded_at IS NULL`).all(providerId);
  let provisional = 0, ready = 0, firstReady = null;
  for (const c of open) {
    const from = readyFrom(c.service_date);
    if (from && from <= today) {
      ready += c.amount_cents;
      if (!firstReady || from < firstReady) firstReady = from;
    } else provisional += c.amount_cents;
  }
  const debits = db.prepare(OPEN_DEBITS + ' AND provider_id=?').all(providerId).reduce((s, d) => s + d.amount_cents, 0);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM provider_credits WHERE provider_id=? AND paid_at IS NOT NULL').get(providerId).t;
  const readyCents = ready + debits;
  return {
    provisionalCents: provisional,
    readyCents,
    paidCents: paid,
    nextPayoutDate: payoutDateFor(firstReady || today, today),
    schedule: settlement.scheduleLabel(),
    complaintWindowDays: GRACE_DAYS,
    pendingCents: provisional,
    payableCents: readyCents,
  };
}

module.exports = { GRACE_DAYS, readyFrom, payoutDateFor, currentCutoff, payerName, payReference, dubaiToday, creditBooking, reverseBooking, eligibleServiceCredits, preview, markPaid, providerBalances };
