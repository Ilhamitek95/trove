'use strict';
/**
 * 2026-08 pricing change: commission 20% -> 40% (makers keep 60%), the AED 9
 * buyer service fee is gone, and delivery is AED 30 charged on orders of
 * AED 200 and below (was AED 25, free from AED 500).
 *
 * The money rules themselves live in src/fees.js and change with the deploy.
 * This migration only fixes STORED site_content overrides: an admin-saved
 * section still carrying the old numbers would keep serving them over the new
 * defaults. Same approach as 013 — targeted phrase rewrites, anything the
 * admin has reworded beyond recognition is left alone.
 */
const SWAPS = [
  ['80% of your price', '60% of your price'],
  ['80% of that price', '60% of that price'],
  ['Free delivery on orders over AED 500', 'Free delivery on orders over AED 200'],
  ['Free on orders over AED 500', 'Free on orders over AED 200'],
  ['free on orders over AED 500', 'free on orders over AED 200'],
];

module.exports = {
  id: '014-pricing-2026-08',
  up(db) {
    const rows = db.prepare('SELECT section, value FROM site_content').all();
    const update = db.prepare("UPDATE site_content SET value=?, updated_at=datetime('now') WHERE section=?");
    let touched = 0;
    for (const r of rows) {
      let next = r.value;
      for (const [from, to] of SWAPS) next = next.split(from).join(to);
      if (next !== r.value) { update.run(next, r.section); touched++; }
    }
    if (touched) console.log(`014: pricing copy updated in ${touched} saved content section(s)`);
  },
};
