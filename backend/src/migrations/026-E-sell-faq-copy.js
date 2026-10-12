'use strict';
/**
 * Sell-page FAQ 'What does it cost?' (F317): the answer said 'that's the
 * whole arrangement. If nothing sells, you owe nothing', which overstated
 * the Seller Agreement (§6: a maker answers for goods that are not their
 * own, unsafe or not as described). The default in src/content.js and the
 * static copy in docs/trove.html now say so; like migrations 013/017/021/024,
 * a saved Site content override carrying the exact old sentence is rewritten.
 * Anything the admin reworded is left alone.
 */
const PAIRS = [
  ["customer care all included — and that's the whole arrangement. If nothing sells, you owe nothing.",
    'customer care all included. If nothing sells, you pay nothing. You do stay responsible for your pieces being your own work, safe and as described (see the Seller Agreement).'],
];

module.exports = {
  id: '026-E-sell-faq-copy',
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
    if (changed) console.log(`026-E: sell-page FAQ copy updated in ${changed} saved content section(s)`);
  },
};
