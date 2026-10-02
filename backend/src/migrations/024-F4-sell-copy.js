'use strict';
/**
 * Sell-on-Trove copy (medium-findings round 2026-10-02, group F4):
 *   F101  'No trade licence needed' → 'No trade licence to start', and the
 *         licence answer says what the Seller Agreement says (Emirates ID +
 *         home address before the first payout; an e-Trader licence may be
 *         asked for as sales grow)
 *   F146  the deal strip under the hero: 60%, paid every other Tuesday after
 *         the 15-day return window, free to join
 *   F147  each promise said once (delivery, own packaging, payouts)
 * The defaults live in src/content.js (static fallbacks in docs/trove.html),
 * but an admin edit is stored in site_content and would keep serving the old
 * wording — so, like migrations 013/017/021, saved overrides carrying these
 * exact phrases are rewritten. Anything the admin reworded is left alone.
 */
const PAIRS = [
  ['["Free to join","No trade licence needed","Courier collects from your door","A real person reviews every shop"]',
    '["You keep 60% of every sale","Paid every other Tuesday, after the 15-day return window","Free to join"]'],
  ['"title":"No trade licence needed","text":"Trove buys your pieces and resells them, so you can start selling without a licence of your own."',
    '"title":"No trade licence to start","text":"Trove buys your pieces and resells them, so most home makers can start without a licence. Before your first payout we check your Emirates ID and home address."'],
  ['No. Trove buys your pieces from you and resells them to shoppers, so you can sell here without any licence. If you do have one, mention it when you apply — it unlocks extra payout options as you grow.',
    'Most home makers can start without one: Trove buys your pieces from you and resells them to shoppers. Before your first payout we ask for your Emirates ID (front and back) and your home address to verify who you are, and if your sales grow a lot we may ask you to get an e-Trader licence. If you already have a licence, mention it when you apply — it unlocks extra payout options as you grow.'],
  ['Our courier collects the piece from your door, and your money arrives with the fortnightly payout.',
    'We email you the moment a piece sells, with the day to have it packed by. Pack it in your own packaging and mark it packed in your dashboard.'],
  ["When a piece sells, our courier collects it from your door. You pack it in your own packaging and hand it over — that's it.",
    'Our courier collects each sold piece from your door and takes it to the buyer. Trove books and pays for every delivery.'],
  ["Your share lands in your bank account every other Tuesday, and your Payments page shows exactly what's coming and when.",
    "A sale is paid in the first payout after the buyer's 15-day return window closes, so returns are settled first. Your Payments page shows the date for each sale."],
  ["so returns are settled before you are paid. Your Payments page shows exactly what's coming and when.",
    "so returns are settled before you are paid — in practice 16 to 29 days after delivery, depending on where the fortnight falls. Your Payments page shows exactly what's coming and when."],
];

module.exports = {
  id: '024-F4-sell-copy',
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
    if (changed) console.log(`024-F4: sell-page copy updated in ${changed} saved content section(s)`);
  },
};
