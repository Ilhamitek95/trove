'use strict';
/**
 * Who gets which email, and with what data. Templates live in email.js; this
 * module looks the facts up and sends. Every function is best-effort: it
 * never throws and returns a promise that always resolves, so a route can
 * fire it and move on (tests may await it).
 */
const db = require('./db');
const accounts = require('./accounts');

const email = () => require('./email');
/** The recipient account's language (users.lang) for a user row or an email address. */
const langOfUser = (user) => (user && (user.lang === 'ar' || user.lang === 'en') ? user.lang : email().langFor(user && user.id ? { userId: user.id } : { email: user && user.email }));

function deliver(label, to, msg) {
  if (!to || !msg) return Promise.resolve(null);
  return Promise.resolve()
    .then(() => email().send({ to, ...msg }))
    .catch((e) => { console.error(`${label} email failed:`, e.message); return null; });
}
function safely(label, fn) {
  try { return fn() || Promise.resolve(null); }
  catch (e) { console.error(`${label} email failed:`, e.message); return Promise.resolve(null); }
}

/* ---- account ---- */
const welcomeVerify = (user) => safely('welcome', () => {
  const token = accounts.issueToken(user, 'verify');
  const link = `${accounts.siteUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  return deliver('welcome', user.email, email().welcomeVerify({ name: user.name, link, lang: langOfUser(user) }));
});

const passwordReset = (user) => safely('password-reset', () => {
  const token = accounts.issueToken(user, 'reset');
  const link = `${accounts.siteUrl()}/reset?token=${encodeURIComponent(token)}`;
  return deliver('password-reset', user.email, email().passwordReset({ name: user.name, link, lang: langOfUser(user) }));
});

const passwordChanged = (user) => safely('password-changed', () =>
  deliver('password-changed', user.email, email().passwordChanged({ name: user.name, link: `${accounts.siteUrl()}/login?forgot=1`, lang: langOfUser(user) })));

/** The payout bank account of a shop or practice changed: tell the account owner. */
const bankDetailsChanged = (user, { kind, businessName, bankName, iban, held = true }) => safely('bank-details-changed', () =>
  deliver('bank-details-changed', user && user.email, email().bankDetailsChanged({
    name: user.name, businessName, kind, bankName, iban, held, link: `${accounts.siteUrl()}/login?forgot=1`, lang: langOfUser(user),
  })));

/* ---- applications ---- */
function shopRow(shopId) {
  return db.prepare('SELECT s.*, u.email AS owner_email, u.name AS owner_name, u.lang AS owner_lang FROM shops s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(shopId);
}
function providerRow(providerId) {
  return db.prepare('SELECT p.*, u.email AS owner_email, u.name AS owner_name, u.lang AS owner_lang FROM service_providers p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(providerId);
}
const dashboard = (kind) => `${accounts.siteUrl()}${kind === 'shop' ? '/sell' : '/provider'}`;

function applied(kind, row) {
  if (!row) return Promise.resolve(null);
  const category = kind === 'shop' ? row.category : (() => {
    try { return JSON.parse(row.categories || '[]').join(', '); } catch (_) { return ''; }
  })();
  return Promise.all([
    deliver(`${kind}-application-received`, row.owner_email,
      email().applicationReceived({ kind, name: row.owner_name, businessName: row.name, link: dashboard(kind), lang: row.owner_lang })),
    deliver(`${kind}-application-alert`, accounts.adminEmail(),
      email().applicationAlert({ kind, businessName: row.name, applicantName: row.owner_name, location: row.location, category, link: `${accounts.siteUrl()}/admin` })),
  ]);
}
const shopApplied = (shopId) => safely('shop-application', () => applied('shop', shopRow(shopId)));
const providerApplied = (providerId) => safely('provider-application', () => applied('provider', providerRow(providerId)));

function decided(kind, row, status) {
  if (!row) return Promise.resolve(null);
  if (status === 'approved') {
    return deliver(`${kind}-approved`, row.owner_email,
      email().applicationApproved({ kind, name: row.owner_name, businessName: row.name, link: dashboard(kind), lang: row.owner_lang }));
  }
  if (status === 'rejected') {
    return deliver(`${kind}-rejected`, row.owner_email,
      email().applicationRejected({ kind, name: row.owner_name, businessName: row.name, adminNote: row.review_note || '', link: accounts.siteUrl(), lang: row.owner_lang }));
  }
  return Promise.resolve(null);
}
const shopDecided = (shopId, status) => safely('shop-decision', () => decided('shop', shopRow(shopId), status));
const providerDecided = (providerId, status) => safely('provider-decision', () => decided('provider', providerRow(providerId), status));

/* ---- orders ---- */
// Fallback only: a shipment booked before per-piece make/pack times
// (2026-09-30) has no pack_by_at of its own. Everything newer carries a
// concrete date — order paid + the slowest of that shop's pieces.
const packByDays = () => Math.max(1, parseInt(process.env.PACK_BY_DAYS, 10) || 2);
/** The shop's pack-by moment on this order (SQLite UTC text). */
function packByFor(order, shopId) {
  const sh = db.prepare('SELECT pack_by_at FROM shipments WHERE order_id=? AND shop_id=?').get(order.id, shopId);
  if (sh && sh.pack_by_at) return sh.pack_by_at;
  return require('./lead-times').packByAt(order.title_transferred_at || order.created_at, packByDays());
}

/**
 * One email per shop in a paid order, to the shop owner, listing only that
 * shop's pieces. Deliberately built from order_items + products only — the
 * buyer's email, phone and address are never read here.
 */
const ordersToPack = (order) => safely('order-to-pack', () => {
  const options = require('./options');
  const extras = require('./extras');
  const shops = db.prepare(`SELECT DISTINCT s.id, s.name, u.email AS owner_email, u.name AS owner_name, u.lang AS owner_lang
    FROM order_items oi JOIN shops s ON s.id = oi.shop_id JOIN users u ON u.id = s.user_id
    WHERE oi.order_id = ?`).all(order.id);
  const itemsStmt = db.prepare(`SELECT oi.name_snapshot, oi.qty, oi.price_cents, oi.personalization, oi.options, oi.extras, p.images
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.shop_id = ? ORDER BY oi.id`);
  const meta = (i) => [options.label(i.options), extras.label(i.extras), i.personalization ? `“${i.personalization}”` : ''].filter(Boolean).join(' · ');
  return Promise.all(shops.map((s) => {
    const items = itemsStmt.all(order.id, s.id).map((i) => ({
      name: i.name_snapshot, qty: i.qty, price_cents: i.price_cents, meta: meta(i),
      image: email().productImage({ images: i.images, name: i.name_snapshot }),
    }));
    return deliver('order-to-pack', s.owner_email, email().orderToPack({
      shopName: s.name, ownerName: s.owner_name, publicId: order.public_id, items,
      packBy: email().dayLabel(s.owner_lang, packByFor(order, s.id)), link: `${accounts.siteUrl()}/sell?view=orders`, lang: s.owner_lang,
    }));
  }));
});

/* ---- pack-by reminders (hourly sweep, src/order-sweep.js) ---- */
function shipmentFacts(shipmentId) {
  return db.prepare(`SELECT sh.*, o.public_id, s.name AS shop_name, u.email AS owner_email, u.name AS owner_name, u.lang AS owner_lang
    FROM shipments sh JOIN orders o ON o.id = sh.order_id JOIN shops s ON s.id = sh.shop_id JOIN users u ON u.id = s.user_id
    WHERE sh.id = ?`).get(shipmentId);
}
const packItems = (sh) => db.prepare('SELECT name_snapshot AS name, qty - cancelled_qty AS qty FROM order_items WHERE order_id=? AND shop_id=? AND qty > cancelled_qty ORDER BY id').all(sh.order_id, sh.shop_id);
/** To the maker: the pack-by day has gone and the parcel is not marked Packed. */
const packReminder = (shipmentId) => safely('pack-reminder', () => {
  const sh = shipmentFacts(shipmentId);
  if (!sh) return null;
  return deliver('pack-reminder', sh.owner_email, email().packReminder({
    shopName: sh.shop_name, ownerName: sh.owner_name, publicId: sh.public_id, items: packItems(sh),
    packBy: email().dayLabel(sh.owner_lang, sh.pack_by_at), link: `${accounts.siteUrl()}/sell?view=orders`, lang: sh.owner_lang,
  }));
});
/** To the admin: two days past the pack-by day, still not packed. */
const packOverdueAdmin = (shipmentId) => safely('pack-overdue-admin', () => {
  const sh = shipmentFacts(shipmentId);
  if (!sh) return null;
  return deliver('pack-overdue-admin', accounts.adminEmail(), email().packOverdueAdmin({
    shopName: sh.shop_name, publicId: sh.public_id, items: packItems(sh),
    packBy: require('./lead-times').dubaiDay(sh.pack_by_at), link: `${accounts.siteUrl()}/admin`,
  }));
});

/** To a maker whose Emirates ID expires soon (or has): update it under Payouts. */
const idExpiring = (shop, expired) => safely('id-expiring', () => {
  const lang = email().langFor({ email: shop.owner_email });
  return deliver('id-expiring', shop.owner_email, email().idExpiring({
    name: shop.owner_name, shopName: shop.name, expired, lang,
    expiry: email().dayLabel(lang, `${shop.emirates_id_expiry} 08:00:00`, { year: true }),
    link: `${accounts.siteUrl()}/sell?view=payments`,
  }));
});

/* ---- operations alerts (courier, disputes, missed payments) ---- */
/** To ADMIN_EMAIL: { subject, title, lines[], link?, cta?, kicker? } — plain text lines. */
const adminAlert = (msg) => safely('admin-alert', () =>
  deliver('admin-alert', accounts.adminEmail(), email().adminAlert({ link: `${accounts.siteUrl()}/admin`, ...msg })));

/** To the maker: their fortnightly payment was sent (Admin → Mark paid). */
const makerPaid = ({ shopId, amountCents, reference, runDate }) => safely('maker-paid', () => {
  const s = shopRow(shopId);
  if (!s || s.is_house) return null;
  return deliver('maker-paid', s.owner_email, email().makerPaymentSent({
    shopName: s.name, ownerName: s.owner_name, amountCents, reference, runDate,
    payer: require('./service-credits').payerName(), link: `${accounts.siteUrl()}/sell?view=payments`, lang: s.owner_lang,
  }));
});

/**
 * A scheduled job failed (settlement, backup, courier set-up…): tell the
 * owner by email instead of leaving it in the server log. Rate-limiting (one
 * email per job per day) lives in src/job-runs.js, which calls this.
 */
const alertOwner = (subject, error, { job = '', lines = [] } = {}) => adminAlert({
  subject: `Trove: ${subject}`,
  title: subject,
  kicker: job ? `Scheduled job: ${job}` : '',
  lines: [
    ...lines,
    `What went wrong: ${String((error && error.message) || error || 'unknown error').slice(0, 400)}`,
    'The admin Overview shows when each job last worked. If this keeps happening, ask your developer to look at the server log.',
  ],
  cta: 'Open the admin',
});

/** To the maker: pieces cancelled from their parcel, or the whole parcel
 *  refunded — leave them out / do not hand it to the courier. */
const parcelCancelled = ({ shopId, publicId, items, whole }) => safely('parcel-cancelled', () => {
  const s = shopRow(shopId);
  if (!s) return null;
  return deliver('parcel-cancelled', s.owner_email, email().parcelCancelledMaker({
    shopName: s.name, ownerName: s.owner_name, publicId, items, whole, link: `${accounts.siteUrl()}/sell?view=orders`, lang: s.owner_lang,
  }));
});

/* ---- refunds, deliveries, returns and payments (third review, round 2) ---- */
const orderRow = (orderId) => db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
/** The buyer's first name only — owner alerts carry nothing more about them. */
function buyerFirstName(order) {
  let name = '';
  try { name = (JSON.parse(order.shipping_json || '{}') || {}).name || ''; } catch (_) { /* fall through */ }
  if (!name && order.buyer_id) name = (db.prepare('SELECT name FROM users WHERE id=?').get(order.buyer_id) || {}).name || '';
  return String(name).trim().split(/\s+/)[0] || 'a guest';
}
const aedText = (cents) => `AED ${((cents || 0) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
/** Units still on the order: not cancelled before dispatch, not refunded through a return. */
const LIVE_UNITS_SQL = `oi.qty - oi.cancelled_qty - COALESCE((SELECT SUM(ri.qty) FROM return_request_items ri
    JOIN return_requests r2 ON r2.id = ri.request_id WHERE ri.order_item_id = oi.id AND r2.status = 'refunded'), 0)`;

/**
 * To the buyer: Trove refunded the whole order. `parcels` = what
 * returns.applyRefundEffects did to each parcel (return collection booked,
 * already in transit, cancelled) so the email says what happens next.
 */
const orderRefunded = (orderId, parcels = []) => safely('order-refunded', () => {
  const order = orderRow(orderId);
  if (!order) return null;
  const items = db.prepare(`SELECT oi.name_snapshot, ${LIVE_UNITS_SQL} AS qty, oi.price_cents, p.images
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`).all(order.id)
    .filter((i) => i.qty > 0)
    .map((i) => ({ name: i.name_snapshot, qty: i.qty, price_cents: i.price_cents, image: email().productImage({ images: i.images, name: i.name_snapshot }) }));
  const acts = (parcels || []).map((p) => p && p.action);
  return deliver('order-refunded', order.email, email().orderRefunded({
    order, items,
    amountCents: order.whole_refund_cents != null ? order.whole_refund_cents : order.total_cents,
    collection: acts.some((a) => a === 'return_booked' || a === 'return_failed'),
    inTransit: acts.includes('in_transit'),
  }));
});

/** To the buyer: one parcel was delivered — what came, and the return deadline. */
const parcelDelivered = (shipmentId) => safely('parcel-delivered', () => {
  const sh = db.prepare('SELECT sh.*, s.name AS shop_name FROM shipments sh JOIN shops s ON s.id = sh.shop_id WHERE sh.id=?').get(shipmentId);
  if (!sh || sh.status !== 'delivered') return null;
  const order = orderRow(sh.order_id);
  if (!order || order.refunded_at) return null;
  const items = db.prepare(`SELECT oi.name_snapshot, oi.qty - oi.cancelled_qty AS qty, oi.price_cents, p.images
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.shop_id = ? AND oi.qty > oi.cancelled_qty ORDER BY oi.id`).all(order.id, sh.shop_id)
    .map((i) => ({ name: i.name_snapshot, qty: i.qty, price_cents: i.price_cents, image: email().productImage({ images: i.images, name: i.name_snapshot }) }));
  const deadline = require('./returns').parcelDeadline(order, sh);
  return deliver('parcel-delivered', order.email, email().parcelDelivered({
    order, items, shopName: sh.shop_name, deadline, account: !!order.buyer_id,
  }));
});

/** Has this shop already been paid (credit swept into a settlement) for this order? */
const alreadySettled = (orderId, shopId) => !!db.prepare(`SELECT 1 FROM seller_balances
  WHERE order_id=? AND shop_id=? AND type='credit_sale' AND settlement_id IS NOT NULL`).get(orderId, shopId);

/**
 * To each maker whose pieces are coming back: a return Trove approved
 * (`requestId`), or — with { shopId, items, refundedOrder: true } — a whole
 * order refunded after delivery. Never anything about the buyer.
 */
function returnComing({ order, shopId, items, reasonLabel = '', refundedOrder = false }) {
  const s = shopRow(shopId);
  if (!s || !items.length) return Promise.resolve(null);
  return deliver('return-coming', s.owner_email, email().returnComingMaker({
    shopName: s.name, ownerName: s.owner_name, publicId: order.public_id, items, reasonLabel, refundedOrder,
    netted: alreadySettled(order.id, shopId), link: `${accounts.siteUrl()}/sell?view=returns`, lang: s.owner_lang,
  }));
}
const returnApprovedMakers = (requestId) => safely('return-coming', () => {
  const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(requestId);
  if (!rr) return null;
  const order = orderRow(rr.order_id);
  const returns = require('./returns');
  const items = returns.requestItems(rr.id);
  return Promise.all([...new Set(items.map((i) => i.shop_id))].map((shopId) => returnComing({
    order, shopId, reasonLabel: returns.reasonLabel(rr.reason),
    items: items.filter((i) => i.shop_id === shopId).map((i) => ({ name: i.name_snapshot, qty: i.qty })),
  })));
});
const refundedParcelComing = (orderId, shopId) => safely('return-coming', () => {
  const order = orderRow(orderId);
  if (!order) return null;
  const items = db.prepare(`SELECT oi.name_snapshot AS name, ${LIVE_UNITS_SQL} AS qty FROM order_items oi WHERE oi.order_id=? AND oi.shop_id=? ORDER BY oi.id`)
    .all(orderId, shopId).filter((i) => i.qty > 0);
  return returnComing({ order, shopId, items, refundedOrder: true });
});

/** To the maker: their settlement payment has gone out. */
const payoutSent = (settlementItemId) => safely('payout-sent', () => {
  const it = db.prepare('SELECT * FROM settlement_items WHERE id=?').get(settlementItemId);
  if (!it || !(it.amount_cents > 0)) return null;
  const s = shopRow(it.shop_id);
  if (!s || s.is_house) return null;
  return deliver('payout-sent', s.owner_email, email().payoutSent({
    shopName: s.name, ownerName: s.owner_name, amountCents: it.amount_cents, reference: it.bank_reference,
    payer: require('./service-credits').payerName(), link: `${accounts.siteUrl()}/sell?view=payments`, lang: s.owner_lang,
  }));
});

/* Owner alerts (owner 2026-10-02: tell me about each new paid order, return
 * request and automatic sold-out refund — short, the buyer's first name and
 * the order number only). Always English. */
const ownerNewOrder = (orderId) => safely('owner-new-order', () => {
  const o = orderRow(orderId);
  if (!o) return null;
  const shops = db.prepare('SELECT DISTINCT s.name FROM order_items oi JOIN shops s ON s.id = oi.shop_id WHERE oi.order_id=? ORDER BY s.name').all(o.id).map((r) => r.name);
  const units = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_items WHERE order_id=?').get(o.id).n;
  return adminAlert({
    subject: `New order ${o.public_id} — ${aedText(o.total_cents)}`,
    title: 'A new order is in',
    kicker: `Order ${o.public_id}`,
    lines: [
      `${buyerFirstName(o)} paid ${aedText(o.total_cents)} for ${units} ${units === 1 ? 'piece' : 'pieces'}.`,
      `${shops.length === 1 ? 'Shop' : 'Shops'}: ${shops.join(', ')}. Each maker has been asked to pack.`,
    ],
  });
});
const ownerReturnRequested = (requestId) => safely('owner-return-requested', () => {
  const rr = db.prepare('SELECT * FROM return_requests WHERE id=?').get(requestId);
  if (!rr) return null;
  const o = orderRow(rr.order_id);
  const returns = require('./returns');
  const items = returns.requestItems(rr.id);
  return adminAlert({
    subject: `Return request on order ${o.public_id} — needs your decision`,
    title: 'A return request is waiting',
    kicker: `Order ${o.public_id}`,
    lines: [
      `${buyerFirstName(o)} asked to send back ${items.map((i) => `${i.name_snapshot}${i.qty > 1 ? ' ×' + i.qty : ''}`).join(', ')}.`,
      `Reason: ${returns.reasonLabel(rr.reason)}. Approve or decline it in the admin under Returns — the buyer was told to expect an answer within a couple of days.`,
    ],
  });
});
const ownerSoldOut = (orderId, { refunded, soldOut = true } = {}) => safely('owner-sold-out', () => {
  const o = orderRow(orderId);
  if (!o) return null;
  return adminAlert({
    subject: refunded ? `Order ${o.public_id} could not go ahead — refunded automatically` : `ACTION: order ${o.public_id} could not go ahead and the automatic refund FAILED`,
    title: refunded ? 'An order was refunded automatically' : 'An automatic refund failed',
    kicker: `Order ${o.public_id}`,
    lines: [
      soldOut
        ? `${buyerFirstName(o)} paid ${aedText(o.total_cents)}, but a piece sold out between checkout and payment, so nothing was sent.`
        : `${buyerFirstName(o)} paid ${aedText(o.total_cents)} after the checkout had already expired, so the order could not go ahead.`,
      refunded ? 'The full amount was refunded and the buyer was emailed. Nothing else to do.' : 'Refund the payment by hand in Stripe, then email the buyer.',
    ],
  });
});

module.exports = {
  orderRefunded, parcelDelivered, returnApprovedMakers, refundedParcelComing, payoutSent,
  ownerNewOrder, ownerReturnRequested, ownerSoldOut,
  idExpiring, adminAlert, alertOwner, makerPaid, parcelCancelled,
  packReminder, packOverdueAdmin, packByFor,
  welcomeVerify, passwordReset, passwordChanged, bankDetailsChanged,
  shopApplied, providerApplied, shopDecided, providerDecided, ordersToPack, packByDays,
};
