'use strict';
/**
 * The announcement bar states the AED 30 delivery fee, not only the free
 * threshold (F155, 2026-10-02): 'Free delivery on orders over AED 200' left
 * buyers to find the fee in the basket. The default lives in src/content.js
 * (and the static copies in docs/trove.html + docs/trove-services.html); an
 * admin save is stored in site_content and would keep serving the old line,
 * so — like migrations 013, 017 and 021 — a saved promo that still carries
 * the old default wording exactly is rewritten. Anything else is left alone.
 */
const PAIRS = [
  ['Delivering across Dubai & Abu Dhabi · Free delivery on orders over AED 200', 'Delivering across Dubai & Abu Dhabi · Delivery AED 30, free on orders over AED 200'],
];

module.exports = {
  id: '024-F1-delivery-fee-copy',
  PAIRS,
  up(db) {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='site_content'").get();
    if (!has) return;
    const row = db.prepare("SELECT value FROM site_content WHERE section='site.promo'").get();
    if (!row) return;
    let v;
    try { v = JSON.parse(row.value); } catch (_) { return; }
    if (!v || typeof v.text !== 'string') return;
    const hit = PAIRS.find(([from]) => v.text === from);
    if (!hit) return;
    v.text = hit[1];
    db.prepare("UPDATE site_content SET value=?, updated_at=datetime('now') WHERE section='site.promo'").run(JSON.stringify(v));
    console.log('024-F1: announcement bar now states the delivery fee');
  },
};
