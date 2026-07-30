'use strict';
/**
 * One delivery promise everywhere. The homepage marquee and product page said
 * 2–4 days while checkout said 3–6 — the buyer agreed to the slower one, so
 * that is the honest number and the rest now match it.
 *
 * Defaults live in src/content.js, but an admin edit is stored in
 * site_content and would keep serving the old promise, so any saved override
 * carrying the old wording is rewritten too. Anything the admin has since
 * reworded around it is left alone.
 */
module.exports = {
  id: '013-delivery-promise',
  up(db) {
    const rows = db.prepare("SELECT section, value FROM site_content WHERE value LIKE '%2–4 day%'").all();
    const update = db.prepare("UPDATE site_content SET value=?, updated_at=datetime('now') WHERE section=?");
    for (const r of rows) {
      const next = r.value.split('2–4 day').join('3–6 day');
      update.run(next, r.section);
    }
    if (rows.length) console.log(`013: delivery promise updated in ${rows.length} saved content section(s)`);
  },
};
