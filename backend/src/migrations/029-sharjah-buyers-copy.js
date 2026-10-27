'use strict';
/**
 * Sharjah buyers (owner, 2026-10-27: "oto does deliver to sharjah"): Trove now
 * delivers to, and takes service bookings from, Dubai, Abu Dhabi and Sharjah.
 * The defaults in src/content.js (and the static copies in docs/) say so; like
 * migrations 013/017/021/024/026-E, a saved Site content override that still
 * carries the exact old shipped wording is rewritten. Anything the admin
 * reworded is left alone.
 */
const PAIRS = [
  ['Delivering across Dubai & Abu Dhabi · Delivery AED 30, free on orders over AED 200',
    'Delivering across Dubai, Abu Dhabi & Sharjah · Delivery AED 30, free on orders over AED 200'],
  ['independent makers in the Trove Marketplace, delivered across Dubai and Abu Dhabi. Objects worth keeping.',
    'independent makers in the Trove Marketplace, delivered across Dubai, Abu Dhabi and Sharjah. Objects worth keeping.'],
  ["and Trove delivers to buyers in Dubai and Abu Dhabi. Services are booked at customers' homes in Dubai and Abu Dhabi, so a provider based in Sharjah travels to them.",
    "and Trove delivers to buyers in all three. Services are booked at customers' homes in the same three emirates."],
];

module.exports = {
  id: '029-sharjah-buyers-copy',
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
    if (changed) console.log(`029: delivery area copy updated in ${changed} saved content section(s)`);
  },
};
