'use strict';
/**
 * Cancelling pieces before dispatch (owner, 2026-10-02: "a partial
 * cancellation option for each cart so you can select which item(s)").
 *
 * The admin picks exactly which units of which order lines to cancel — any
 * unit whose parcel the courier has not collected yet. One cancellation:
 *   - refunds those units to the card (a partial Stripe refund, tagged
 *     trove_kind=cancellation so the charge.refunded webhook knows it is
 *     Trove's), plus the original delivery fee when NOTHING is left to
 *     deliver (admin can override either way, never more than once per order);
 *   - reverses the makers' credit for just those units (unswept credits
 *     shrink, swept ones debit — same code as returns) and the VAT inside
 *     the refund, with credit note CN-<order>-C<id>;
 *   - takes the units off the parcel (order_items.cancelled_qty): the maker
 *     packs the rest, the courier order carries the rest, returns and
 *     settlement only ever see the rest;
 *   - cancels a parcel that is now empty (courier booking cancelled too),
 *     so the other makers' parcels complete the order and their payouts;
 *   - stamps orders.refunded_at when every unit on the order is gone;
 *   - emails the buyer (what was cancelled + the refund) and each maker
 *     (leave these out / do not send the parcel).
 *
 * cancelParcel() is the 'parcel never ships' action: every remaining unit
 * of one maker's parcel, in one go.
 *
 * Stripe goes first: the units are reserved in a pending row, and if the
 * card refund fails everything is put back exactly as it was.
 */
const db = require('./db');
const cfg = require('./config');

const REASONS = { buyer_request: 'The buyer asked to cancel', not_shipped: 'The maker could not send it', other: 'Other' };
const fail = (status, error) => Object.assign(new Error(error), { status });

/** Units on each line already refunded through a return. */
const refundedUnits = (orderItemId) => db.prepare(`SELECT COALESCE(SUM(ri.qty),0) AS q FROM return_request_items ri
  JOIN return_requests rr ON rr.id = ri.request_id WHERE ri.order_item_id=? AND rr.status IN ('requested','approved','collected','refunded')`).get(orderItemId).q;

/** Why this order can't take a cancellation at all (null = it can). */
function orderBlocked(order) {
  if (!order) return 'Order not found';
  if (order.refunded_at) return 'This order was already refunded';
  if (!['paid', 'fulfilled'].includes(order.status)) return 'Only paid orders can be cancelled';
  if (order.rail === 'connect') return 'Connect-rail orders need the manual refund button';
  return null;
}

/** Can the courier still be stopped for this parcel? */
function parcelOpen(sh) {
  if (!sh) return false;
  if (['cancelled', 'out_for_delivery', 'delivered'].includes(sh.status)) return false;
  return !sh.collected_at;
}

/**
 * Every line on the order with how many units can still be cancelled, and
 * why not when none can. Feeds the admin picker.
 */
function lines(order) {
  const shipStmt = db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?');
  return db.prepare(`SELECT oi.*, s.name AS shop_name FROM order_items oi JOIN shops s ON s.id = oi.shop_id
    WHERE oi.order_id=? ORDER BY s.name, oi.id`).all(order.id).map((i) => {
    const sh = shipStmt.get(order.id, i.shop_id);
    const left = i.qty - i.cancelled_qty - refundedUnits(i.id);
    const open = parcelOpen(sh);
    return {
      id: i.id, name: i.name_snapshot, shopId: i.shop_id, shop: i.shop_name, shipmentId: sh ? sh.id : null,
      qty: i.qty, cancelledQty: i.cancelled_qty, price: i.price_cents / 100, priceCents: i.price_cents,
      options: require('./options').parse(i.options),
      cancellable: open ? Math.max(0, left) : 0,
      why: open ? (left > 0 ? null : 'Nothing left to cancel')
        : !sh ? 'No parcel'
          : sh.status === 'cancelled' ? 'Parcel cancelled'
            : sh.status === 'delivered' ? 'Delivered — use a return'
              : 'With the courier — it can only come back as a return',
    };
  });
}

/** The delivery fee still refundable on the order. */
function deliveryLeft(order) {
  const paid = order.shipping_cents || 0;
  const given = db.prepare("SELECT COALESCE(SUM(delivery_refund_cents),0) AS s FROM order_cancellations WHERE order_id=? AND status='refunded'").get(order.id).s
    + db.prepare("SELECT COALESCE(SUM(delivery_refund_cents),0) AS s FROM return_requests WHERE order_id=? AND status IN ('approved','collected','refunded')").get(order.id).s;
  return Math.max(0, paid - given);
}

/**
 * What a cancellation of `picks` ([{ id, qty }]) would do — validated.
 * Returns { units[{ line, qty }], itemsCents, deliveryCents, refundCents, whole }.
 */
function plan(order, picks, { refundDelivery = null } = {}) {
  const blocked = orderBlocked(order);
  if (blocked) throw fail(409, blocked);
  const byId = new Map(lines(order).map((l) => [l.id, l]));
  const want = new Map();
  for (const p of Array.isArray(picks) ? picks : []) {
    const id = Number(p && p.id);
    const qty = Number(p && p.qty);
    if (!Number.isInteger(id)) continue;
    if (!Number.isInteger(qty) || qty < 0) throw fail(400, 'Choose how many of each piece to cancel');
    if (qty) want.set(id, (want.get(id) || 0) + qty);
  }
  if (!want.size) throw fail(400, 'Pick at least one piece to cancel');
  const units = [];
  for (const [id, qty] of want) {
    const l = byId.get(id);
    if (!l) throw fail(400, 'Those pieces are not on this order');
    if (qty > l.cancellable) {
      throw fail(409, l.cancellable ? `Only ${l.cancellable} of ${l.name} can still be cancelled` : `${l.name} can't be cancelled: ${l.why}`);
    }
    units.push({ line: l, qty });
  }
  const itemsCents = units.reduce((t, u) => t + u.line.priceCents * u.qty, 0);
  // Whole = after this, no unit on the order is left to deliver.
  const remaining = [...byId.values()].reduce((t, l) => t + (l.qty - l.cancelledQty - refundedUnits(l.id)), 0)
    - units.reduce((t, u) => t + u.qty, 0);
  const whole = remaining <= 0;
  const giveDelivery = refundDelivery === true ? true : refundDelivery === false ? false : whole;
  const deliveryCents = giveDelivery ? deliveryLeft(order) : 0;
  return { units, itemsCents, deliveryCents, refundCents: itemsCents + deliveryCents, whole };
}

const shopDone = (orderId, shopId) => db.prepare(`SELECT COUNT(*) AS c FROM order_items oi WHERE oi.order_id=? AND oi.shop_id=?
  AND oi.qty > oi.cancelled_qty + COALESCE((SELECT SUM(ri.qty) FROM return_request_items ri JOIN return_requests rr ON rr.id = ri.request_id
    WHERE ri.order_item_id = oi.id AND rr.status = 'refunded'), 0)`).get(orderId, shopId).c === 0;

/**
 * Cancel units before dispatch and refund them. `picks` = [{ id, qty }] of
 * order_items. Resolves { cancellation, parcels[] } once the card refund,
 * the books and the courier calls are done; throws { status } on a bad
 * request or a failed card refund (nothing changed in that case).
 */
async function cancel(order, picks, { reason = 'buyer_request', note = '', refundDelivery = null, byUserId = null } = {}) {
  const p = plan(order, picks, { refundDelivery });
  const why = REASONS[reason] ? reason : 'other';

  // 1. Reserve the units (a double click or a second admin can't cancel them twice).
  const cid = db.transaction(() => {
    const id = db.prepare(`INSERT INTO order_cancellations (order_id, status, refund_cents, items_cents, delivery_refund_cents, reason, note, by_user_id)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`).run(order.id, p.refundCents, p.itemsCents, p.deliveryCents, why, String(note || '').slice(0, 300) || null, byUserId).lastInsertRowid;
    for (const u of p.units) {
      const ok = db.prepare('UPDATE order_items SET cancelled_qty = cancelled_qty + ? WHERE id=? AND qty - cancelled_qty >= ?').run(u.qty, u.line.id, u.qty).changes;
      if (!ok) throw fail(409, `${u.line.name} changed while you were cancelling — reload and try again`);
      db.prepare('INSERT INTO order_cancellation_items (cancellation_id, order_item_id, qty) VALUES (?,?,?)').run(id, u.line.id, u.qty);
    }
    return id;
  })();
  const undo = () => db.transaction(() => {
    for (const u of p.units) db.prepare('UPDATE order_items SET cancelled_qty = cancelled_qty - ? WHERE id=?').run(u.qty, u.line.id);
    db.prepare('DELETE FROM order_cancellations WHERE id=?').run(cid);
  })();

  // 2. The card refund. If it fails, nothing local changes.
  let refundRef = null;
  const stripe = require('./stripe').getStripe();
  try {
    if (stripe && order.stripe_payment_intent_id && p.refundCents > 0) {
      const r = await stripe.refunds.create({
        payment_intent: order.stripe_payment_intent_id, amount: p.refundCents,
        metadata: { trove_kind: 'cancellation', order_id: String(order.id), cancellation_id: String(cid) },
      }, { idempotencyKey: `trove-cancel-${cid}` });
      refundRef = (r && r.id) || null;
    } else if (!stripe || !order.stripe_payment_intent_id) {
      console.warn(`cancellation ${cid} (${order.public_id}): no card refund (demo mode / no PaymentIntent)`);
    }
  } catch (e) {
    undo();
    throw fail(502, `The card refund didn't go through, so nothing was cancelled: ${e.message}`);
  }

  // 3. The books, the parcels and the order — one transaction.
  const emptied = [];
  const touched = [...new Set(p.units.map((u) => u.line.shopId))];
  db.transaction(() => {
    require('./returns').reverseCreditsFor(order, p.units.map((u) => ({ shop_id: u.line.shopId, price_cents: u.line.priceCents, qty: u.qty })));
    const o = db.prepare('SELECT vat_amount_cents, vat_reversed_cents, public_id FROM orders WHERE id=?').get(order.id);
    let vat = 0, cn = null;
    if (o.vat_amount_cents > 0) {
      vat = Math.max(0, Math.min(cfg.vatFromGross(p.refundCents), o.vat_amount_cents - (o.vat_reversed_cents || 0)));
      cn = `CN-${o.public_id}-C${cid}`;
      db.prepare('UPDATE orders SET vat_reversed_cents = vat_reversed_cents + ? WHERE id=?').run(vat, order.id);
    }
    db.prepare(`UPDATE order_cancellations SET status='refunded', refunded_at=datetime('now'), refund_ref=?, vat_reversed_cents=?, credit_note_ref=? WHERE id=?`)
      .run(refundRef, vat, cn, cid);

    for (const shopId of touched) {
      const sh = db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shopId);
      if (!sh) continue;
      const mine = p.units.filter((u) => u.line.shopId === shopId);
      const what = mine.map((u) => `${u.line.name}${u.qty > 1 ? ' ×' + u.qty : ''}`).join(', ');
      if (shopDone(order.id, shopId)) {
        db.prepare("UPDATE shipments SET status='cancelled', cancelled_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(sh.id);
        db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'cancelled', ?)").run(sh.id, `Cancelled by Trove and refunded: ${what}`);
        emptied.push(sh.id);
      } else {
        db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)').run(sh.id, sh.status, `Cancelled by Trove and refunded: ${what}`);
      }
    }
    if (require('./returns').fullyReturned(order.id)) {
      db.prepare("UPDATE orders SET refunded_at=COALESCE(refunded_at, datetime('now')) WHERE id=?").run(order.id);
    }
    require('./shipments').deriveOrderStatus(order.id);
  })();

  // 4. Couriers, then emails (best-effort — the money is already right).
  const courier = require('./courier-ops');
  const parcels = await Promise.all(emptied.map((id) => courier.stopParcel(id, 'Cancelled by Trove').then((r) => ({ shipmentId: id, ...r }))));
  const notify = require('./notify');
  for (const shopId of touched) {
    notify.parcelCancelled({ shopId, publicId: order.public_id, whole: emptied.some((id) => db.prepare('SELECT shop_id FROM shipments WHERE id=?').get(id).shop_id === shopId),
      items: p.units.filter((u) => u.line.shopId === shopId).map((u) => ({ name: u.line.name, qty: u.qty })) });
  }
  try {
    const email = require('./email');
    const imgs = db.prepare('SELECT oi.id, p.images FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id=?').all(order.id);
    const imgOf = (id, name) => email.productImage({ images: (imgs.find((x) => x.id === id) || {}).images, name });
    const msg = email.itemsCancelled({
      order, whole: p.whole,
      items: p.units.map((u) => ({ name: u.line.name, qty: u.qty, price_cents: u.line.priceCents, image: imgOf(u.line.id, u.line.name) })),
      money: { items: p.itemsCents, delivery: p.deliveryCents, refund: p.refundCents },
    });
    email.send({ to: order.email, ...msg }).catch((e) => console.error('items-cancelled email failed:', e.message));
  } catch (e) { console.error('items-cancelled email failed:', e.message); }

  return { cancellation: shape(db.prepare('SELECT * FROM order_cancellations WHERE id=?').get(cid)), parcels };
}

/** 'This parcel never ships': cancel every remaining unit of one maker's parcel. */
async function cancelParcel(order, shipmentId, opts = {}) {
  const sh = db.prepare('SELECT * FROM shipments WHERE id=? AND order_id=?').get(shipmentId, order.id);
  if (!sh) throw fail(404, 'Parcel not found on this order');
  const mine = lines(order).filter((l) => l.shipmentId === sh.id);
  const picks = mine.filter((l) => l.cancellable > 0).map((l) => ({ id: l.id, qty: l.cancellable }));
  if (!picks.length) throw fail(409, (mine.find((l) => l.why) || {}).why || 'Nothing left to cancel on this parcel');
  return cancel(order, picks, { reason: 'not_shipped', ...opts });
}

function shape(c) {
  if (!c) return null;
  const items = db.prepare(`SELECT ci.qty, oi.id, oi.name_snapshot, oi.price_cents, s.name AS shop FROM order_cancellation_items ci
    JOIN order_items oi ON oi.id = ci.order_item_id JOIN shops s ON s.id = oi.shop_id WHERE ci.cancellation_id=?`).all(c.id);
  return {
    id: c.id, status: c.status, reason: c.reason, reasonLabel: REASONS[c.reason] || c.reason, note: c.note || null,
    refund: c.refund_cents / 100, items: items.map((i) => ({ orderItemId: i.id, name: i.name_snapshot, qty: i.qty, price: i.price_cents / 100, shop: i.shop })),
    deliveryRefund: c.delivery_refund_cents / 100, vatReversed: c.vat_reversed_cents / 100, creditNoteRef: c.credit_note_ref || null,
    createdAt: c.created_at, refundedAt: c.refunded_at || null,
  };
}
const forOrder = (orderId) => db.prepare("SELECT * FROM order_cancellations WHERE order_id=? AND status='refunded' ORDER BY id").all(orderId).map(shape);

module.exports = { REASONS, lines, plan, cancel, cancelParcel, deliveryLeft, forOrder, shape, orderBlocked, parcelOpen };
