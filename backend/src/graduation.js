'use strict';
/**
 * Cap monitor + graduation queue (Rail B).
 *
 * Consignment suppliers whose trailing-30-day PAID settlements reach the
 * graduation threshold get flagged: a dashboard banner invites them to obtain
 * a UAE e-Trader license, and they appear in the admin queue. Once an admin
 * verifies the license — and RAIL_B_ENABLED is on — the shop gets a Stripe
 * Connect CUSTOM account (UAE platforms cannot use Express/Standard) and
 * flips to tier 'connect' when Stripe enables payouts. Suppliers who arrived
 * with a license (connect_queue=1) sit in the same queue from day one.
 */
const db = require('./db');
const cfg = require('./config');

const paid30Stmt = db.prepare(`
  SELECT COALESCE(SUM(si.amount_cents),0) AS c
  FROM settlement_items si
  JOIN settlements st ON st.id = si.settlement_id
  WHERE si.shop_id = ? AND st.status = 'paid' AND st.paid_at >= datetime('now','-30 days')`);

/** Nightly: flag consignment suppliers over the trailing-30-day cap. */
function scanCaps() {
  const shops = db.prepare("SELECT id, name FROM shops WHERE tier='consignment' AND graduation_flagged_at IS NULL").all();
  let flagged = 0;
  for (const s of shops) {
    if (paid30Stmt.get(s.id).c >= cfg.graduationThresholdCents()) {
      db.prepare("UPDATE shops SET graduation_flagged_at=datetime('now') WHERE id=?").run(s.id);
      console.log(`graduation: flagged ${s.name} (30-day paid settlements over the cap)`);
      flagged++;
    }
  }
  return flagged;
}

/** The admin queue: cap-flagged suppliers + licensed direct entries, still on consignment. */
function queue() {
  return db.prepare(`
    SELECT s.*, u.email AS owner_email, u.name AS owner_name
    FROM shops s JOIN users u ON u.id = s.user_id
    WHERE s.tier='consignment' AND (s.graduation_flagged_at IS NOT NULL OR s.connect_queue=1)
    ORDER BY COALESCE(s.graduation_flagged_at, s.created_at) DESC`).all()
    .map((s) => ({
      shopId: s.id,
      name: s.name,
      slug: s.slug,
      owner: { name: s.owner_name, email: s.owner_email },
      paid30Cents: paid30Stmt.get(s.id).c,
      licenseNumber: s.license_number || '',
      hasLicenseImage: !!s.license_image,
      licenseVerifiedAt: s.license_verified_at || null,
      graduationFlaggedAt: s.graduation_flagged_at || null,
      directEntry: !!s.connect_queue && !s.graduation_flagged_at,
      stripeAccountId: s.stripe_account_id || null,
      chargesEnabled: !!s.charges_enabled,
      payoutsEnabled: !!s.payouts_enabled,
    }));
}

module.exports = { scanCaps, queue };
