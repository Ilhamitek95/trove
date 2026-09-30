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
 *   statement      the provider's own credits with a status each: waiting,
 *                  payable (on a date) or paid (on a date, with the reference).
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
 * { useShop: true }. Returns { details } or { status, error }.
 */
function saveDetails(provider, body = {}) {
  if (body.useShop === true) {
    const shop = shopWithBank(provider.user_id);
    if (!shop) return fail(409, 'Your shop has no bank details on file yet — add them here instead');
    upsert(provider.id, {
      accountName: shop.payout_account_name, bankName: shop.payout_bank_name,
      ibanEncrypted: shop.iban_encrypted, ibanMasked: shop.iban_masked, source: 'shop',
    });
    return { details: getDetails(provider.id) };
  }
  const v = require('./validate');
  const accountName = String(body.accountName || '').trim().slice(0, 120);
  const bankName = String(body.bankName || '').trim().slice(0, 120);
  if (!accountName || !bankName) return fail(400, 'The account holder name and the bank name are both needed');
  if (v.hasMarkup(accountName) || v.hasMarkup(bankName)) return fail(400, 'Names cannot contain < or >');
  const iban = String(body.iban || '').replace(/\s+/g, '').toUpperCase();
  const ibanErr = v.ibanError(iban);
  if (ibanErr) return fail(400, ibanErr);
  if (!pcrypto.hasKey()) return fail(503, 'Bank details are temporarily unavailable (encryption key not configured)');
  upsert(provider.id, {
    accountName, bankName, ibanEncrypted: pcrypto.encrypt(iban), ibanMasked: pcrypto.maskIban(iban), source: 'own',
  });
  return { details: getDetails(provider.id) };
}

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * The provider's own statement: every fee Trove owes or has paid them, newest
 * first. Only booking code, service, date and their fee — nothing about the
 * customer.
 */
function statement(providerId) {
  const now = db.prepare("SELECT datetime('now') AS t").get().t;
  const payableIds = new Set(credits.eligibleServiceCredits(now).filter((c) => c.provider_id === providerId).map((c) => c.id));
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
    const dates = [];
    if (c.booking_status === 'completed' && c.completed_at) dates.push(c.completed_at.slice(0, 10));
    if (c.service_date) dates.push(addDays(c.service_date, credits.GRACE_DAYS));
    const payableOn = dates.sort()[0] || null;
    return { ...base, status: payableIds.has(c.id) ? 'payable' : 'waiting', payableOn };
  });
}

/** Does the provider have a paid Trove booking (so bank details are needed)? */
const hasPaidBooking = (providerId) => !!db.prepare(
  "SELECT 1 FROM service_bookings WHERE provider_id=? AND payment_method='trove' AND paid_at IS NOT NULL LIMIT 1").get(providerId);

/**
 * Bank transfer file for every provider payable now WITH bank details —
 * providers still waiting for bank details are left out. Decrypts straight
 * into the response; never logged or stored.
 */
function exportCsv(runStart) {
  const pv = credits.preview(runStart);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['provider,account_name,bank,iban,amount_aed,reference,bookings'];
  let count = 0;
  for (const r of pv.eligible) {
    const d = detailsRow(r.providerId);
    if (!d) continue;
    lines.push([esc(r.name), esc(d.account_name), esc(d.bank_name), esc(pcrypto.decrypt(d.iban_encrypted)),
      (r.netCents / 100).toFixed(2), esc(r.reference), esc(r.bookings.map((b) => b.code).join(' '))].join(','));
    count += 1;
  }
  return { csv: lines.join('\r\n') + '\r\n', count };
}

module.exports = { getDetails, saveDetails, shopWithBank, statement, hasPaidBooking, exportCsv };
