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

/** To the maker: pieces cancelled from their parcel, or the whole parcel
 *  refunded — leave them out / do not hand it to the courier. */
const parcelCancelled = ({ shopId, publicId, items, whole }) => safely('parcel-cancelled', () => {
  const s = shopRow(shopId);
  if (!s) return null;
  return deliver('parcel-cancelled', s.owner_email, email().parcelCancelledMaker({
    shopName: s.name, ownerName: s.owner_name, publicId, items, whole, link: `${accounts.siteUrl()}/sell?view=orders`, lang: s.owner_lang,
  }));
});

module.exports = {
  idExpiring, adminAlert, parcelCancelled,
  packReminder, packOverdueAdmin, packByFor,
  welcomeVerify, passwordReset, passwordChanged, bankDetailsChanged,
  shopApplied, providerApplied, shopDecided, providerDecided, ordersToPack, packByDays,
};
