'use strict';
/**
 * Per-piece make/pack time (owner, 2026-09-30) — see src/lead-times.js.
 *
 *   products.lead_days            1–42 whole days, every existing piece gets 2
 *                                 (its old promise: 2 + courier 1–4 = 3–6 days)
 *   products.lead_days_confirmed  0 until the maker has set or confirmed the
 *                                 time themselves (drives the gentle 'confirm
 *                                 your make times' prompt in the dashboard)
 *   order_items.lead_days         the time snapshotted at checkout (NULL on
 *                                 older lines = the default 2)
 *   shipments.pack_by_at          the day the shop's parcel should be packed
 *                                 by (end of that Dubai day, UTC text)
 *   shipments.pack_reminder_at    stamped when the maker was reminded (once)
 *   shipments.pack_escalated_at   stamped when the admin was told it is two
 *                                 days late (once)
 *
 * Existing shipments get a pack-by date on the old rule (paid + 2 days) so
 * the seller and admin views can show it. Parcels that already left the
 * maker (anything but 'processing', or handed to the courier) are stamped as
 * reminded, so the new hourly sweep only ever looks at parcels genuinely
 * still waiting to be packed. Nothing else is rewritten.
 */
function addColumn(db, table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}

module.exports = {
  id: '020-lead-times',
  up(db) {
    addColumn(db, 'products', 'lead_days', 'INTEGER NOT NULL DEFAULT 2');
    addColumn(db, 'products', 'lead_days_confirmed', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'order_items', 'lead_days', 'INTEGER');
    addColumn(db, 'shipments', 'pack_by_at', 'TEXT');
    addColumn(db, 'shipments', 'pack_reminder_at', 'TEXT');
    addColumn(db, 'shipments', 'pack_escalated_at', 'TEXT');
    const { packByAt } = require('../lead-times');
    const rows = db.prepare(`SELECT sh.id, sh.status, sh.ready_at, sh.created_at, o.title_transferred_at
      FROM shipments sh JOIN orders o ON o.id = sh.order_id WHERE sh.pack_by_at IS NULL`).all();
    const set = db.prepare('UPDATE shipments SET pack_by_at=? WHERE id=?');
    const done = db.prepare("UPDATE shipments SET pack_reminder_at=datetime('now'), pack_escalated_at=datetime('now') WHERE id=?");
    for (const r of rows) {
      set.run(packByAt(r.title_transferred_at || r.created_at, 2), r.id);
      if (r.status !== 'processing' || r.ready_at) done.run(r.id);
    }
  },
};
