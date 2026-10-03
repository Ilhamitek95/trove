'use strict';
/**
 * Blocking a customer (F199). The owner's decision (3 Oct 2026):
 *   - a blocked customer can still sign in and see their past orders,
 *     returns and bookings — nothing they already have is taken away;
 *   - checkout and service bookings refuse with a neutral message that
 *     asks them to contact us (no reason is shown to them);
 *   - the switch lives on the admin's customer lookup, is reversible, and
 *     both directions are written to the Activity log.
 *
 * A block is keyed by email (so guests can be blocked too) and remembers
 * the account id, so a blocked buyer who changes their email or checks out
 * as a guest under the same account stays blocked.
 */
const db = require('./db');

const ORDER_REFUSED = 'We can’t take this order right now — please contact us and we’ll help';
const BOOKING_REFUSED = 'We can’t take this booking right now — please contact us and we’ll help';

const clean = (email) => String(email || '').trim().toLowerCase();

/** The block row for this email and/or account, or null. */
function find({ email, userId } = {}) {
  const e = clean(email);
  const uid = Number(userId) || 0;
  if (!e && !uid) return null;
  const ids = new Set();
  if (uid) ids.add(uid);
  if (e) {
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
    if (u) ids.add(u.id);
  }
  const emails = new Set(e ? [e] : []);
  for (const id of ids) {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(id);
    if (u) emails.add(clean(u.email));
  }
  const byEmail = emails.size
    ? db.prepare(`SELECT * FROM blocked_customers WHERE email IN (${[...emails].map(() => '?').join(',')}) LIMIT 1`).get(...emails)
    : null;
  if (byEmail) return byEmail;
  return ids.size
    ? db.prepare(`SELECT * FROM blocked_customers WHERE user_id IN (${[...ids].map(() => '?').join(',')}) LIMIT 1`).get(...ids) || null
    : null;
}

const isBlocked = (who) => !!find(who);

/** Block an email address (and its account, if any). Idempotent. */
function block(email, { note = '', by = '' } = {}) {
  const e = clean(email);
  if (!/^\S+@\S+\.\S+$/.test(e)) return { error: 'Enter the customer’s email address', status: 400 };
  const u = db.prepare('SELECT id, role FROM users WHERE email = ?').get(e);
  if (u && u.role === 'admin') return { error: 'An admin account can’t be blocked', status: 400 };
  const was = find({ email: e });
  db.prepare(`INSERT INTO blocked_customers (email, user_id, note, blocked_by) VALUES (?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET note = excluded.note, blocked_by = excluded.blocked_by, user_id = COALESCE(excluded.user_id, user_id)`)
    .run(e, u ? u.id : null, String(note || '').trim().slice(0, 300), String(by || '').slice(0, 120));
  return { ok: true, already: !!was, userId: u ? u.id : null, row: find({ email: e }) };
}

/** Remove the block on an email address (and any row on its account). */
function unblock(email) {
  const e = clean(email);
  const row = find({ email: e });
  if (!row) return { ok: true, already: true };
  db.prepare('DELETE FROM blocked_customers WHERE email = ? OR (user_id IS NOT NULL AND user_id = ?)').run(row.email, row.user_id || -1);
  return { ok: true, already: false, userId: row.user_id || null };
}

/** The public shape for the admin's lookup card. */
function describe(row) {
  return row ? { at: row.blocked_at, note: row.note || '', by: row.blocked_by || '' } : null;
}

module.exports = { ORDER_REFUSED, BOOKING_REFUSED, find, isBlocked, block, unblock, describe };
