'use strict';
/**
 * Copy for per-piece delivery times (owner, 2026-09-30). The site no longer
 * promises 3–6 days for everything: most pieces still arrive in 3–6 days,
 * but made-to-order pieces show their own time. The defaults live in
 * src/content.js (and the static fallbacks in docs/trove.html); an admin
 * edit is stored in site_content and would keep serving the old promise, so
 * — like migrations 013 and 017 — saved overrides carrying the old wording
 * are rewritten. Only these exact phrases are touched: the marquee item as
 * the default stored it (head + sub together), then the head on its own for
 * an override whose sub was reworded. Anything else is left alone.
 */
const PAIRS = [
  ['"head":"3–6 day delivery","sub":"Dubai & Abu Dhabi"', '"head":"Delivery time shown","sub":"On every piece, most 3–6 days"'],
  ['"head":"3–6 day delivery"', '"head":"Delivery time shown"'],
];

module.exports = {
  id: '021-delivery-time-copy',
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
    if (changed) console.log(`021: delivery-time copy updated in ${changed} saved content section(s)`);
  },
};
