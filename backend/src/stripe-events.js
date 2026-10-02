'use strict';
/**
 * Card disputes and refunds made outside Trove (fix round 2026-10-02).
 * Until now the Stripe webhook only knew payment_intent.succeeded, so a
 * chargeback or a refund pressed in the Stripe dashboard left the order
 * 'paid' and the maker's credit payable.
 *
 *   charge.dispute.created   the order's maker credits are HELD from
 *                            settlement (orders.hold_reason='dispute'), the
 *                            order is flagged and the admin emailed with the
 *                            amount, the reason and the evidence deadline.
 *   charge.dispute.updated   the status is kept up to date.
 *   charge.dispute.closed    won → the hold lifts; lost → the money is gone,
 *                            so the order is booked as refunded (refunded_at,
 *                            settled credits debited, VAT reversed, unsent
 *                            parcels stopped — no return collection).
 *   charge.refunded          every refund on the PaymentIntent is listed;
 *                            any that Trove did not make (no trove_kind tag,
 *                            not a stored refund id) is external. External
 *                            money covering everything still paid → the order
 *                            is booked as refunded like above. A partial one
 *                            → hold + flag + email: a person decides which
 *                            pieces it was for, then releases the hold.
 *
 * Service bookings paid through Trove are flagged and the admin emailed on a
 * dispute (service_bookings.attention='dispute').
 */
const db = require('./db');

const notify = () => require('./notify');
const aed = (c) => `AED ${((c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
const sqlTime = (unix) => (unix ? new Date(Number(unix) * 1000).toISOString().replace('T', ' ').slice(0, 19) : null);
const piOf = (obj) => (typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent && obj.payment_intent.id) || null;
const orderByPi = (pi) => (pi ? db.prepare('SELECT * FROM orders WHERE stripe_payment_intent_id=?').get(pi) : null);
const bookingByPi = (pi) => (pi ? db.prepare('SELECT * FROM service_bookings WHERE stripe_payment_intent_id=?').get(pi) : null);
const dashboard = (path) => `https://dashboard.stripe.com/${path}`;

/** Book an order as refunded because the money left outside Trove. */
async function bookAsRefunded(order, why) {
  if (order.refunded_at) return [];
  return require('./returns').applyRefundEffects(order, { bookReturns: false }).then((r) => {
    console.warn(`order ${order.public_id}: booked as refunded — ${why}`);
    return r;
  });
}

async function disputeCreated(d) {
  const pi = piOf(d);
  const order = orderByPi(pi);
  const due = sqlTime(d.evidence_details && d.evidence_details.due_by);
  const lines = [
    `A card dispute for ${aed(d.amount)} was opened (reason: ${String(d.reason || 'not given').replace(/_/g, ' ')}).`,
    due ? `Evidence is due by ${due} UTC — answer it in the Stripe dashboard before then, or the dispute is lost.` : 'Answer it in the Stripe dashboard.',
  ];
  if (order) {
    db.prepare("UPDATE orders SET hold_reason='dispute', dispute_status=?, dispute_due_by=?, attention='dispute' WHERE id=?")
      .run(d.status || 'needs_response', due, order.id);
    lines.push("The makers' payment for this order is held until the dispute closes.");
    notify().adminAlert({ subject: `Card dispute on order ${order.public_id} — reply by ${due ? due.slice(0, 10) : 'the deadline'}`,
      title: 'A card dispute needs an answer', kicker: `Order ${order.public_id}`, lines, link: dashboard(`disputes/${d.id}`), cta: 'Open the dispute in Stripe' });
    return true;
  }
  const bk = bookingByPi(pi);
  if (bk) {
    db.prepare("UPDATE service_bookings SET attention='dispute' WHERE id=?").run(bk.id);
    notify().adminAlert({ subject: `Card dispute on booking ${bk.code}`, title: 'A card dispute needs an answer', kicker: `Booking ${bk.code}`,
      lines: [...lines, "Hold the provider's fee for this booking until it closes."], link: dashboard(`disputes/${d.id}`), cta: 'Open the dispute in Stripe' });
    return true;
  }
  return false;
}

async function disputeUpdated(d) {
  const order = orderByPi(piOf(d));
  if (!order) return false;
  db.prepare('UPDATE orders SET dispute_status=? WHERE id=?').run(d.status || order.dispute_status, order.id);
  return true;
}

async function disputeClosed(d) {
  const order = orderByPi(piOf(d));
  if (!order) return false;
  const status = d.status || 'closed';
  if (status === 'won' || status === 'warning_closed') {
    db.prepare("UPDATE orders SET dispute_status=?, hold_reason=CASE WHEN hold_reason='dispute' THEN '' ELSE hold_reason END, attention=CASE WHEN attention='dispute' THEN '' ELSE attention END WHERE id=?")
      .run(status, order.id);
    notify().adminAlert({ subject: `Dispute won — order ${order.public_id}`, title: 'Dispute closed in your favour', kicker: `Order ${order.public_id}`,
      lines: [`The card dispute for ${aed(d.amount)} closed in Trove's favour. The makers' payment for this order is no longer held.`] });
    return true;
  }
  // Lost: the bank took the money back.
  db.prepare("UPDATE orders SET dispute_status=?, hold_reason='', attention='dispute_lost' WHERE id=?").run(status, order.id);
  await bookAsRefunded(order, `card dispute ${status}`);
  notify().adminAlert({ subject: `Dispute lost — order ${order.public_id}`, title: 'A card dispute was lost', kicker: `Order ${order.public_id}`,
    lines: [`The card dispute for ${aed(d.amount)} closed against Trove, so the order is now booked as refunded.`,
      "The makers' credits on it no longer pay out (any already paid are taken off their next payment), and parcels not yet sent were stopped."] });
  return true;
}

/** Refund ids Trove itself made on this order (older refunds carry no tag). */
function troveRefundIds(order) {
  const ids = new Set();
  if (order.refund_ref) ids.add(order.refund_ref);
  for (const r of db.prepare('SELECT refund_ref FROM return_requests WHERE order_id=? AND refund_ref IS NOT NULL').all(order.id)) ids.add(r.refund_ref);
  for (const r of db.prepare('SELECT refund_ref FROM order_cancellations WHERE order_id=? AND refund_ref IS NOT NULL').all(order.id)) ids.add(r.refund_ref);
  return ids;
}

async function chargeRefunded(charge, stripe) {
  const pi = piOf(charge);
  const order = orderByPi(pi);
  if (!order || !stripe || !stripe.refunds || typeof stripe.refunds.list !== 'function') return false;
  const list = await stripe.refunds.list({ payment_intent: pi, limit: 100 });
  const mine = troveRefundIds(order);
  const external = (list.data || [])
    .filter((r) => !['failed', 'canceled'].includes(r.status))
    .filter((r) => !(r.metadata && r.metadata.trove_kind) && !mine.has(r.id))
    .reduce((t, r) => t + (r.amount || 0), 0);
  const fresh = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  if (external <= (fresh.external_refund_cents || 0)) return true; // nothing new from outside Trove
  db.prepare('UPDATE orders SET external_refund_cents=? WHERE id=?').run(external, order.id);
  if (fresh.refunded_at) return true; // already booked as refunded — nothing left to reverse

  const troveRefunded = db.prepare("SELECT COALESCE(SUM(refund_cents),0) AS s FROM return_requests WHERE order_id=? AND status='refunded'").get(order.id).s
    + db.prepare("SELECT COALESCE(SUM(refund_cents),0) AS s FROM order_cancellations WHERE order_id=? AND status='refunded'").get(order.id).s;
  const stillPaid = fresh.total_cents - troveRefunded;
  if (external >= stillPaid || charge.refunded === true) {
    await bookAsRefunded(fresh, 'refunded in the Stripe dashboard');
    notify().adminAlert({ subject: `Order ${order.public_id} refunded in Stripe — recorded in Trove`, title: 'A Stripe refund was recorded',
      kicker: `Order ${order.public_id}`,
      lines: [`${aed(external)} was refunded on this order straight from the Stripe dashboard, which covers everything still paid.`,
        "Trove now books the order as refunded: the makers' credits no longer pay out and parcels not yet sent were stopped.",
        'Next time, use Refund or Cancel items in Admin → Orders so the buyer and makers are told too.'] });
    return true;
  }
  db.prepare("UPDATE orders SET hold_reason='external_refund', attention='external_refund' WHERE id=?").run(order.id);
  notify().adminAlert({ subject: `Part refund made in Stripe on order ${order.public_id} — needs sorting`, title: 'A part refund was made outside Trove',
    kicker: `Order ${order.public_id}`,
    lines: [`${aed(external)} was refunded on this order straight from the Stripe dashboard. Trove can't tell which pieces it was for.`,
      "The makers' payment for this order is held so nobody is paid for a refunded piece.",
      'Adjust the maker credit by hand if needed, then press Release hold on the order in Admin → Orders.'] });
  return true;
}

/** Dispatch one verified Stripe event. Resolves true when it was ours. */
async function handle(event, stripe) {
  const obj = event.data && event.data.object;
  if (!obj) return false;
  switch (event.type) {
    case 'charge.dispute.created': return disputeCreated(obj);
    case 'charge.dispute.updated': return disputeUpdated(obj);
    case 'charge.dispute.closed': return disputeClosed(obj);
    case 'charge.refunded': return chargeRefunded(obj, stripe);
    default: return false;
  }
}

const TYPES = ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.refunded'];

module.exports = { handle, TYPES, troveRefundIds };
