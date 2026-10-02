'use strict';
/**
 * The owner's control panel helpers (medium-findings round, group F3):
 *
 *   refundedCentsSql   how much of an order has gone back to the buyer, in
 *                      one SQL expression — the Overview's Sales and each
 *                      shop's Sales are net of it (F110)
 *   needsYou()         ONE list of everything waiting on the owner, gathered
 *                      from every tab, most urgent money first (F111)
 *   listOrders()       Admin → Orders with search, filters and paging (F112)
 *   orderDetail()      one order in full: lines, address, parcels with
 *                      tracking, returns, cancellations, refunds (F112)
 *   editDelivery()     correct the delivery address / mobile after payment,
 *                      until a parcel is packed (F199)
 */
const db = require('./db');
const shipments = require('./shipments');

/* How much of order `o` has been refunded: everything on a whole-order
 * refund, else the refunded returns + cancellations + refunds made straight
 * in Stripe, never more than the order total. */
const refundedCentsSql = (o = 'o') => `(CASE WHEN ${o}.refunded_at IS NOT NULL THEN ${o}.total_cents ELSE MIN(${o}.total_cents,
    COALESCE((SELECT SUM(rr.refund_cents) FROM return_requests rr WHERE rr.order_id = ${o}.id AND rr.status = 'refunded'), 0)
  + COALESCE((SELECT SUM(oc.refund_cents) FROM order_cancellations oc WHERE oc.order_id = ${o}.id AND oc.status = 'refunded'), 0)
  + COALESCE(${o}.external_refund_cents, 0)) END)`;

/** Units of one order line that went back in a refunded return. */
const RETURNED_UNITS = `COALESCE((SELECT SUM(ri.qty) FROM return_request_items ri JOIN return_requests r2 ON r2.id = ri.request_id
    WHERE ri.order_item_id = oi.id AND r2.status = 'refunded'), 0)`;

/** The Overview's money: gross, refunded and net sales; orders not fully refunded. */
function salesTotals() {
  const r = db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN o.refunded_at IS NULL THEN 1 ELSE 0 END), 0) AS kept,
      COALESCE(SUM(o.total_cents), 0) AS gross,
      COALESCE(SUM(${refundedCentsSql('o')}), 0) AS refunded
    FROM orders o WHERE o.status IN ('paid','fulfilled')`).get();
  return { orders: r.kept, ordersIncludingRefunded: r.orders, grossCents: r.gross, refundedCents: r.refunded, netCents: r.gross - r.refunded };
}

/** A shop's sales: pieces it sold, less cancelled and refunded-return units and fully refunded orders. */
const SHOP_SALES_SQL = `(SELECT COALESCE(SUM(oi.price_cents * MAX(0, oi.qty - oi.cancelled_qty - ${RETURNED_UNITS})), 0)
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.shop_id = s.id AND o.status IN ('paid','fulfilled') AND o.refunded_at IS NULL)`;

const dubaiToday = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);

/**
 * Everything waiting on the owner, one row per kind with a count and where
 * to go: [{ key, label, count, view, filter?, urgent, hint }]. Only kinds
 * with something in them are returned.
 */
function needsYou() {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const rows = [];
  const add = (key, count, label, view, { filter = '', urgent = false, hint = '' } = {}) => {
    if (count > 0) rows.push({ key, count, label, view, filter, urgent, hint });
  };

  // Money owed to buyers that the machine could not send.
  add('refunds_by_hand',
    n("SELECT COUNT(*) AS n FROM orders WHERE attention IN ('refund_failed','oversold_refund_failed')")
    + n("SELECT COUNT(*) AS n FROM service_bookings WHERE attention = 'refund_failed'"),
    'Refunds to make by hand in Stripe', 'orders', { filter: 'attention', urgent: true, hint: 'An automatic refund failed — the buyer is waiting for their money' });
  add('disputes', n("SELECT COUNT(*) AS n FROM orders WHERE hold_reason = 'dispute' AND attention = 'dispute'"),
    'Card disputes to answer in Stripe', 'orders', { filter: 'attention', urgent: true, hint: 'Stripe gives a deadline for the evidence' });
  add('stripe_refunds', n("SELECT COUNT(*) AS n FROM orders WHERE hold_reason = 'external_refund'"),
    'Refunds made in Stripe to reconcile', 'orders', { filter: 'attention', hint: "The makers' payment is held until you release it" });

  // Returns.
  add('returns', n("SELECT COUNT(*) AS n FROM return_requests WHERE status = 'requested'"),
    'Return requests to decide', 'returns', { urgent: true });
  add('return_collections', n(`SELECT COUNT(DISTINCT rr.id) AS n FROM return_requests rr JOIN return_collections rc ON rc.request_id = rr.id
      WHERE rr.status = 'approved' AND rc.status = 'failed'`),
    'Return collections the courier could not book', 'returns', { urgent: true });

  // Parcels.
  add('parcels_flagged', n(`SELECT COUNT(*) AS n FROM shipments sh JOIN orders o ON o.id = sh.order_id
      WHERE sh.attention <> '' AND o.status IN ('paid','fulfilled')`),
    'Parcels the courier flagged', 'orders', { filter: 'attention', urgent: true });
  const open = db.prepare(`SELECT sh.* FROM shipments sh JOIN orders o ON o.id = sh.order_id
    WHERE o.status = 'paid' AND o.refunded_at IS NULL AND sh.status = 'processing' AND sh.pack_by_at IS NOT NULL`).all();
  add('packs_overdue', open.filter((sh) => shipments.packOverdue(sh)).length,
    'Parcels past their pack-by day', 'orders', { filter: 'overdue', hint: 'The maker has been reminded; call them' });

  // Applications and identity.
  const pendingShops = db.prepare("SELECT agreement_accepted_at, pickup_address, pickup_phone, is_house FROM shops WHERE status = 'pending'").all();
  const ready = pendingShops.filter((s) => s.is_house || (s.agreement_accepted_at && s.pickup_address && s.pickup_phone)).length;
  add('shops_ready', ready, 'Shop applications ready to approve or reject', 'shops');
  add('shops_waiting', pendingShops.length - ready, 'Shop applications waiting on the maker', 'shops', { hint: 'Agreement or courier pickup details still missing' });
  add('providers', n("SELECT COUNT(*) AS n FROM service_providers WHERE status = 'pending'"), 'Service provider applications', 'providers');
  const identity = require('./identity');
  const toCheck = db.prepare(`SELECT * FROM shops WHERE is_house = 0 AND status <> 'rejected'
      AND license_verified_at IS NULL AND identity_checked_at IS NULL`).all()
    .filter((s) => identity.eidSubmitted(s) && identity.eidExpiryState(s) !== 'expired').length;
  add('ids', toCheck, 'Emirates IDs to check', 'shops', { hint: 'Makers are paid only once you tick ID checked' });

  // Paying makers and providers.
  const settlement = require('./settlement');
  const waitingRuns = db.prepare("SELECT status FROM settlements WHERE status IN ('draft','exported')").all();
  add('runs_draft', waitingRuns.filter((r) => r.status === 'draft').length, 'Settlement runs to download and send', 'payouts', { urgent: true, hint: 'Download the bank file, send the transfers, then mark paid' });
  add('runs_exported', waitingRuns.filter((r) => r.status === 'exported').length, 'Settlement runs to mark paid once the transfers went out', 'payouts', { urgent: true });
  let pv = { eligible: [], excluded: [] };
  try { pv = settlement.preview(); } catch (_) { /* shown on the Payouts tab */ }
  if (!waitingRuns.length && settlement.isRunDate(dubaiToday())) {
    add('makers_payable', pv.eligible.length, 'Makers to pay in today’s settlement run', 'payouts', { urgent: true });
  }
  add('maker_bank_changed', pv.excluded.filter((r) => r.reason === 'bank_details_changed').length,
    'Makers who changed bank details — check by phone, then release', 'payouts');
  add('makers_cant_be_paid', pv.excluded.filter((r) => ['payout_setup_incomplete', 'id_missing', 'id_to_check', 'id_expired'].includes(r.reason)).length,
    'Makers with money waiting who can’t be paid yet', 'payouts', { hint: 'Bank details, agreement or ID missing' });
  let svc = { eligible: [], excluded: [] };
  try { svc = require('./service-credits').preview(); } catch (_) { /* shown on the Providers tab */ }
  add('providers_payable', svc.eligible.length, 'Providers to pay by bank transfer', 'providers');
  add('provider_bank_changed', svc.excluded.filter((r) => r.reason === 'bank_details_changed').length,
    'Providers who changed bank details — check by phone, then release', 'providers');

  // Messages, the courier wallet, background jobs.
  add('messages', n('SELECT COUNT(*) AS n FROM contact_messages WHERE handled_at IS NULL'), 'New contact form messages', 'messages');
  const w = require('./courier-ops').walletStatus();
  if (w.mode === 'oto' && w.low) add('wallet', 1, w.empty ? 'Courier wallet is empty — top it up' : 'Courier wallet is running low — top it up', 'overview', { urgent: true });
  const failing = require('./job-runs').status().filter((j) => j.failing);
  add('jobs', failing.length, `Background jobs failing: ${failing.map((j) => j.label).join(', ')}`, 'overview', { urgent: true, hint: 'See Background jobs below' });

  rows.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  return rows;
}

/* ---------------- Admin → Orders: search, filters, paging ---------------- */

const FILTERS = {
  all: '1=1',
  attention: `(o.attention <> '' OR COALESCE(o.hold_reason,'') <> ''
    OR EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id = o.id AND (sh.attention <> '' OR COALESCE(sh.booking_error,'') <> '')))`,
  overdue: `(o.status = 'paid' AND o.refunded_at IS NULL AND EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id = o.id
    AND sh.status = 'processing' AND sh.ready_at IS NULL AND sh.packed_at IS NULL AND sh.pack_by_at IS NOT NULL AND sh.pack_by_at < datetime('now')))`,
  open: `(o.status = 'paid' AND o.refunded_at IS NULL)`,
  refunded: `(${refundedCentsSql('o')} > 0)`,
};

/**
 * Orders newest first, `limit` per page; `before` (an order id from the
 * previous page's `next`) pages back past the first page. `q` matches the
 * order number, buyer email, mobile or delivery name.
 */
function listOrders({ q = '', filter = 'all', before = null, limit = 100 } = {}) {
  const where = ["o.status != 'pending'", "NOT (o.status = 'cancelled' AND o.attention = '' AND o.title_transferred_at IS NULL)", FILTERS[filter] || FILTERS.all];
  const args = [];
  const term = String(q || '').trim().slice(0, 80);
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const digits = term.replace(/\D/g, '');
    where.push(`(o.public_id LIKE ? ESCAPE '\\' OR o.email LIKE ? ESCAPE '\\' OR o.shipping_json LIKE ? ESCAPE '\\'${digits.length >= 4 ? ' OR o.phone LIKE ?' : ''})`);
    args.push(like, like, like);
    if (digits.length >= 4) args.push(`%${digits}%`);
  }
  if (before) { where.push('o.id < ?'); args.push(Number(before)); }
  const size = Math.min(200, Math.max(1, Number(limit) || 100));
  const rows = db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
      (SELECT GROUP_CONCAT(DISTINCT s.name) FROM order_items oi JOIN shops s ON s.id = oi.shop_id WHERE oi.order_id = o.id) AS shop_names,
      ${refundedCentsSql('o')} AS refunded_cents
    FROM orders o WHERE ${where.join(' AND ')}
    ORDER BY o.id DESC LIMIT ?`).all(...args, size + 1);
  const more = rows.length > size;
  const page = rows.slice(0, size);
  return { rows: page, next: more ? page[page.length - 1].id : null };
}

/** Counts for the Orders filter chips (and the sidebar badge). */
function orderCounts() {
  const base = "o.status != 'pending' AND NOT (o.status = 'cancelled' AND o.attention = '' AND o.title_transferred_at IS NULL)";
  const c = (f) => db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${base} AND ${FILTERS[f]}`).get().n;
  return { all: c('all'), attention: c('attention'), overdue: c('overdue'), open: c('open'), refunded: c('refunded') };
}

const parse = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };

/** One order in full, for the expandable detail row. */
function orderDetail(order) {
  const lines = db.prepare(`SELECT oi.*, s.name AS shop_name, ${RETURNED_UNITS} AS returned
    FROM order_items oi JOIN shops s ON s.id = oi.shop_id WHERE oi.order_id = ? ORDER BY oi.id`).all(order.id).map((l) => ({
    name: l.name_snapshot, shop: l.shop_name, qty: l.qty, cancelledQty: l.cancelled_qty || 0, returnedQty: l.returned,
    priceCents: l.price_cents, options: parse(l.options, []), extras: parse(l.extras, []),
    personalisation: l.personalization || '', leadDays: l.lead_days || null,
  }));
  const parcels = db.prepare(`SELECT sh.*, s.name AS shop_name FROM shipments sh JOIN shops s ON s.id = sh.shop_id WHERE sh.order_id = ? ORDER BY sh.id`).all(order.id).map((sh) => ({
    shop: sh.shop_name, status: sh.status, statusLabel: shipments.statusLabel(sh),
    carrier: sh.carrier || '', trackingNumber: sh.tracking_number || '', trackingUrl: /^https?:\/\//.test(sh.tracking_url || '') ? sh.tracking_url : '',
    courierRef: sh.delivery_ref || '', packBy: sh.pack_by_at || null, packOverdue: shipments.packOverdue(sh),
    readyAt: sh.ready_at || null, collectedAt: sh.collected_at || null, deliveredAt: sh.delivered_at || null,
    returnWindowEndsAt: sh.return_window_ends_at || null,
    events: db.prepare('SELECT status, note, created_at FROM shipment_events WHERE shipment_id=? ORDER BY id').all(sh.id)
      .map((e) => ({ status: e.status, note: e.note || '', at: e.created_at })),
  }));
  const returns = db.prepare('SELECT * FROM return_requests WHERE order_id=? ORDER BY id').all(order.id).map((r) => ({
    status: r.status, reason: r.reason, createdAt: r.created_at, decidedAt: r.decided_at || null,
    refundCents: r.refund_cents || 0, refundedAt: r.refunded_at || null, creditNote: r.credit_note_ref || '',
  }));
  const cancellations = db.prepare("SELECT * FROM order_cancellations WHERE order_id=? ORDER BY id").all(order.id).map((c) => ({
    status: c.status, reason: c.reason || '', note: c.note || '', refundCents: c.refund_cents || 0, at: c.refunded_at || c.created_at,
  }));
  const refunded = db.prepare(`SELECT ${refundedCentsSql('o')} AS c FROM orders o WHERE o.id=?`).get(order.id).c;
  return {
    publicId: order.public_id, status: order.status, createdAt: order.created_at,
    email: order.email, phone: order.phone || '', ship: parse(order.shipping_json, null),
    subtotalCents: order.subtotal_cents, deliveryCents: order.shipping_cents || 0, totalCents: order.total_cents,
    refundedCents: refunded, refundedAt: order.refunded_at || null, externalRefundCents: order.external_refund_cents || 0,
    lines, parcels, returns, cancellations,
    deliveryEditable: deliveryEditBlock(order) === null, deliveryEditBlocked: deliveryEditBlock(order),
    deliveryEditedAt: order.delivery_edited_at || null,
  };
}

/* ---------------- correcting delivery details after payment (F199) -------- */

/** Why the delivery details can no longer be changed here, or null. */
function deliveryEditBlock(order) {
  if (order.refunded_at || !['paid', 'fulfilled'].includes(order.status)) return 'Only a paid order that is not refunded can be changed';
  const parcels = db.prepare("SELECT * FROM shipments WHERE order_id=? AND status <> 'cancelled'").all(order.id);
  if (parcels.some((sh) => sh.status !== 'processing' || sh.ready_at || sh.packed_at || sh.collected_at)) {
    return 'A parcel is already packed or with the courier — change the address with the courier directly';
  }
  return null;
}

const ADDRESS_FIELDS = ['name', 'line', 'line2', 'area', 'city', 'emirate', 'notes'];

/**
 * Correct the delivery address and/or mobile of a paid order until a parcel
 * is packed. Same rules as checkout (Dubai + Abu Dhabi only, a UAE mobile, no
 * markup). A parcel whose courier order already exists (OTO books one at
 * payment) is flagged so the owner updates the courier too.
 * Returns { ok, changed, flagged } or { status, error }.
 */
function editDelivery(order, body = {}) {
  const block = deliveryEditBlock(order);
  if (block) return { status: 409, error: block };
  const cur = parse(order.shipping_json, {}) || {};
  const next = { ...cur };
  if (body.address && typeof body.address === 'object') {
    for (const f of ADDRESS_FIELDS) if (body.address[f] !== undefined) next[f] = String(body.address[f] || '').trim().slice(0, 200);
  }
  delete next.phone; // the mobile lives on orders.phone only, never in the address snapshot shops see
  if (!String(next.name || '').trim() || !String(next.line || '').trim()) return { status: 400, error: 'A delivery name and address are required' };
  if (require('./validate').markupField(next, ADDRESS_FIELDS)) return { status: 400, error: "The delivery address can't contain < or >" };
  const area = require('./service-area');
  if (!area.isServiceable(next.emirate || next.city)) return { status: 400, error: `We currently deliver in ${area.SERVICE_AREAS.join(' and ')} only` };
  let phone = order.phone || '';
  if (body.phone !== undefined) {
    phone = require('./phone').normalizeUAEMobile(String(body.phone || '').trim());
    if (!phone) return { status: 400, error: 'Enter a UAE mobile number so the courier can reach the buyer' };
  }
  const changed = JSON.stringify(next) !== JSON.stringify(cur) || phone !== (order.phone || '');
  if (!changed) return { ok: true, changed: false, flagged: 0 };
  let flagged = 0;
  db.transaction(() => {
    db.prepare("UPDATE orders SET shipping_json=?, phone=?, delivery_edited_at=datetime('now') WHERE id=?").run(JSON.stringify(next), phone, order.id);
    for (const sh of db.prepare("SELECT * FROM shipments WHERE order_id=? AND status <> 'cancelled'").all(order.id)) {
      db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)').run(sh.id, sh.status, 'Delivery details corrected by Trove');
      if (sh.delivery_ref && require('./delivery').isLive()) {
        db.prepare("UPDATE shipments SET attention='address_changed', attention_at=datetime('now') WHERE id=?").run(sh.id);
        flagged += 1;
      }
    }
  })();
  return { ok: true, changed: true, flagged };
}

module.exports = { refundedCentsSql, salesTotals, SHOP_SALES_SQL, needsYou, listOrders, orderCounts, orderDetail, deliveryEditBlock, editDelivery, FILTERS };
