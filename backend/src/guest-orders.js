'use strict';
/**
 * Guest orders find their way into the buyer's account.
 *
 * A guest checkout writes an order with buyer_id NULL and the email the
 * buyer typed. The receipt sends them to their account to track the parcel
 * and request a return, so once someone holds an account whose email is
 * CONFIRMED (the welcome link, a password-reset link or Google sign-in all
 * prove the inbox), every guest order placed with that address is attached
 * to it. An unconfirmed account never claims anything: typing a stranger's
 * email at sign-up must not hand over the stranger's orders.
 *
 * Called whenever an account is proven or opened (verify-email, Google,
 * reset, sign-in) and by the account's order list, so an order placed while
 * signed out appears the next time the buyer looks. Pending (unpaid) orders
 * are left alone: the account only ever shows paid ones.
 */
const db = require('./db');

const norm = (e) => String(e || '').trim().toLowerCase();

/** Attach the confirmed account's guest orders. Returns how many moved. */
function claimForUser(userOrId) {
  const user = typeof userOrId === 'object' && userOrId
    ? userOrId
    : db.prepare('SELECT id, email, email_verified_at FROM users WHERE id=?').get(userOrId);
  if (!user || !user.email_verified_at || !norm(user.email)) return 0;
  const info = db.prepare(`UPDATE orders SET buyer_id=?
    WHERE buyer_id IS NULL AND status!='pending' AND lower(trim(email))=?`).run(user.id, norm(user.email));
  return info.changes;
}

/** Best-effort wrapper for sign-in paths: a failure here never blocks a sign-in. */
function claimQuietly(userOrId) {
  try { return claimForUser(userOrId); }
  catch (e) { console.warn('guest order claim failed:', e.message); return 0; }
}

module.exports = { claimForUser, claimQuietly };
