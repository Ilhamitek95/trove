'use strict';
/**
 * Move the buyer's contact number out of the shipping address snapshot and
 * onto its own orders.phone column.
 *
 * The seller order payload hands a maker the parsed shipping_json so they can
 * pack and label the parcel — anything stored in there reaches every shop in
 * the order. A phone number is a direct off-platform channel, so it lives in
 * a column the seller routes never select. Trove books the courier, so the
 * number only ever needs to reach Trove and Quiqup.
 *
 * Old orders (the seed order carries one) are moved across and stripped.
 */
module.exports = {
  id: '012-order-phone',
  up(db) {
    const rows = db.prepare("SELECT id, shipping_json FROM orders WHERE shipping_json LIKE '%phone%'").all();
    const setPhone = db.prepare('UPDATE orders SET phone=?, shipping_json=? WHERE id=?');
    for (const r of rows) {
      let ship;
      try { ship = JSON.parse(r.shipping_json); } catch (_) { continue; }
      if (!ship || typeof ship !== 'object' || !ship.phone) continue;
      const phone = String(ship.phone).slice(0, 32);
      delete ship.phone;
      setPhone.run(phone, JSON.stringify(ship), r.id);
    }
  },
};
