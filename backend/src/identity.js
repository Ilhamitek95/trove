'use strict';
/**
 * Maker identity — who Trove pays (October 2026 review, F006/F435).
 *
 * A maker's identity counts as established by exactly one METHOD, recorded on
 * shops.verification_method:
 *
 *   'trade_licence'  an admin verified the trade / e-Trader licence
 *                    (Admin → Graduation → Verify licence). Typing a licence
 *                    number alone proves nothing and no longer skips the
 *                    Emirates ID step.
 *   'emirates_id'    the maker gave both Emirates ID photos, the typed ID
 *                    details and a home address at payout setup, AND an
 *                    admin compared them and ticked 'ID checked'
 *                    (identity_checked_at / identity_checked_by).
 *   'uae_pass'       reserved — the owner's long-term route once Trove is
 *                    onboarded with UAE Pass. Adding it means one more entry
 *                    in METHODS and a verify endpoint that stamps it.
 *
 * Settlement pays a shop only when its identity is established and, on the
 * Emirates ID route, the ID has not expired. The payout account holder name
 * is compared with the maker's own name and the shop name; a mismatch is
 * flagged to the admin (never silently blocked — joint and business accounts
 * exist), next to the details in the Shops review and the settlement preview.
 */
const METHODS = ['trade_licence', 'emirates_id', 'uae_pass'];
const EXPIRY_WARN_DAYS = 30;

const today = (now = Date.now()) => new Date(now + 4 * 3600000).toISOString().slice(0, 10); // Dubai calendar day
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Does this shop still owe Trove the Emirates ID step (photos + address)? */
const needsEmiratesId = (shop) => !shop.is_house && !shop.license_verified_at;

/** 'expired' | 'expiring' (within 30 days) | 'ok' | null (no expiry on file). */
function eidExpiryState(shop, now = Date.now()) {
  const exp = shop && shop.emirates_id_expiry;
  if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return null;
  const d = today(now);
  if (exp < d) return 'expired';
  if (exp <= addDays(d, EXPIRY_WARN_DAYS)) return 'expiring';
  return 'ok';
}

/** Everything the maker has handed in for the Emirates ID route. */
const eidSubmitted = (shop) => !!(shop.eid_front_file && shop.eid_back_file && shop.seller_address && shop.emirates_id_last4);

/**
 * The shop's identity status, one shape for the admin view, the seller view
 * and settlement:
 *   { method, verified, reason, eidExpiry, eidState }
 * reason (when not verified): 'id_missing' (nothing handed in yet),
 * 'id_to_check' (handed in, waiting for the admin's tick) or 'id_expired'.
 */
function status(shop, now = Date.now()) {
  if (!shop) return { method: null, verified: false, reason: 'id_missing' };
  if (shop.is_house) return { method: 'house', verified: true, reason: null };
  const eidState = eidExpiryState(shop, now);
  const base = { eidExpiry: shop.emirates_id_expiry || null, eidState };
  if (shop.license_verified_at) return { ...base, method: 'trade_licence', verified: true, reason: null };
  if (shop.verification_method === 'uae_pass' && shop.identity_checked_at) return { ...base, method: 'uae_pass', verified: true, reason: null };
  if (!eidSubmitted(shop)) return { ...base, method: null, verified: false, reason: 'id_missing' };
  if (eidState === 'expired') return { ...base, method: 'emirates_id', verified: false, reason: 'id_expired' };
  if (!shop.identity_checked_at) return { ...base, method: 'emirates_id', verified: false, reason: 'id_to_check' };
  return { ...base, method: 'emirates_id', verified: true, reason: null };
}

/* ---- payout account holder vs the maker ---- */
const tokens = (s) => String(s || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
  .split(/\s+/)
  .filter((t) => t.length >= 2 && !['mr', 'mrs', 'ms', 'dr', 'llc', 'fze', 'fzc', 'fzco', 'ltd', 'the', 'and', 'bin', 'bint', 'al', 'el'].includes(t));

/** True when every word of the shorter name appears in the longer one. */
function namesMatch(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

/**
 * Does the bank account holder look like this maker? Compared with the
 * account owner's name and with the shop name (a licensed maker may be paid
 * into the business account). null when no account name is on file.
 */
function payoutNameMatches(shop, ownerName) {
  if (!shop || !shop.payout_account_name) return null;
  return namesMatch(shop.payout_account_name, ownerName) || namesMatch(shop.payout_account_name, shop.name);
}

/**
 * Daily: email makers whose Emirates ID expires within 30 days (once) and
 * again when it has expired (once) — payments pause at expiry until they add
 * the renewed ID under Payouts. Only the Emirates ID route: a verified
 * licence does not depend on it. Stamped on shops.eid_reminder_for as
 * '<expiry>:expiring' / '<expiry>:expired', so a renewed ID (a new expiry
 * date) starts afresh. Returns { reminded, expired }.
 */
function sweepIdExpiry(now = Date.now()) {
  const db = require('./db');
  const notify = require('./notify');
  const horizon = addDays(today(now), EXPIRY_WARN_DAYS);
  const rows = db.prepare(`SELECT s.*, u.email AS owner_email, u.name AS owner_name FROM shops s JOIN users u ON u.id = s.user_id
    WHERE s.is_house = 0 AND s.license_verified_at IS NULL AND s.status IN ('approved','pending')
      AND s.emirates_id_expiry IS NOT NULL AND s.emirates_id_expiry != '' AND s.emirates_id_expiry <= ?`).all(horizon);
  let reminded = 0, expired = 0;
  for (const s of rows) {
    const state = eidExpiryState(s, now);
    if (state !== 'expiring' && state !== 'expired') continue;
    const stamp = `${s.emirates_id_expiry}:${state}`;
    if (s.eid_reminder_for === stamp) continue;
    db.prepare('UPDATE shops SET eid_reminder_for=? WHERE id=?').run(stamp, s.id);
    notify.idExpiring(s, state === 'expired');
    if (state === 'expired') expired++; else reminded++;
  }
  return { reminded, expired };
}

module.exports = { sweepIdExpiry, METHODS, EXPIRY_WARN_DAYS, needsEmiratesId, eidExpiryState, eidSubmitted, status, namesMatch, payoutNameMatches, today, addDays };
