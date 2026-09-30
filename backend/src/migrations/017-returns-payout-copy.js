'use strict';
/**
 * Copy for the 2026-09-30 policy: 15-day returns and fortnightly maker
 * payouts. The defaults live in src/content.js (and the static fallbacks in
 * docs/trove.html), but an admin edit is stored in site_content and would
 * keep serving the old promise — so, like migration 013, any saved override
 * carrying the old wording is rewritten too. Only these exact phrases are
 * touched; anything the admin has since reworded around them is left alone.
 */
const PAIRS = [
  ['30-day returns', '15-day returns'],
  ['Weekly payouts, straight to your bank.', 'Fortnightly payouts, straight to your bank.'],
  ['your money arrives with the weekly payout.', 'your money arrives with the fortnightly payout.'],
  ["Your share lands in your bank account every week, and your Payments page shows exactly what's coming and when.",
    "Your share lands in your bank account every other Tuesday, and your Payments page shows exactly what's coming and when."],
  ['"title":"Weekly payouts"', '"title":"Fortnightly payouts"'],
  ['paid out weekly.', 'paid out fortnightly.'],
  ["Weekly, to the bank account you add in your dashboard. A sale becomes payable once the piece is delivered plus a 7-day buffer; if a buyer returns a piece after that, the amount is simply adjusted on a following payout.",
    "Every other Tuesday, to the bank account you add in your dashboard. A sale becomes payable once the piece is delivered and the buyer's 15-day return window has closed, so returns are settled before you are paid."],
];

module.exports = {
  id: '017-returns-payout-copy',
  PAIRS,
  up(db) {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='site_content'").get();
    if (!has) return;
    const rows = db.prepare('SELECT section, value FROM site_content').all();
    const update = db.prepare("UPDATE site_content SET value=?, updated_at=datetime('now') WHERE section=?");
    let changed = 0;
    for (const r of rows) {
      let next = String(r.value);
      for (const [from, to] of PAIRS) next = next.split(from).join(to);
      if (next !== r.value) { update.run(next, r.section); changed += 1; }
    }
    if (changed) console.log(`017: returns/payout copy updated in ${changed} saved content section(s)`);
  },
};
