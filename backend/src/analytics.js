'use strict';
/**
 * Shop analytics — the numbers a maker sees in their dashboard.
 *
 * The storefront reports three shopper actions to POST /api/track: opening a
 * shop page, opening a piece, and adding a piece to the basket. Orders, units
 * and earnings are NOT tracked — they are read from the orders tables, which
 * are the truth about money.
 *
 * Privacy, deliberately: an event stores an anonymous per-browser id and
 * nothing else about the shopper — no user id, no email, no IP, no user agent.
 * The id exists only so repeat visits can be counted once; it is scrubbed
 * after 90 days (see hygiene()), which leaves the counts intact and the
 * identifiers gone. Sellers only ever receive aggregates for their own shop,
 * never a row that could point at a person — the same rule that keeps buyer
 * emails and phone numbers out of the seller dashboard.
 *
 * A shop owner's own visits are not counted; a maker refreshing their piece
 * should not look like demand.
 */
const db = require('./db');
const fees = require('./fees');

const KINDS = new Set(['shop_view', 'product_view', 'add_to_cart']);
const RANGES = [7, 30, 90];
const PAID = "('paid','fulfilled')";

/** Only ranges the dashboard offers, so a hand-typed ?days= can't scan the table. */
function windowDays(days) {
  const n = parseInt(days, 10);
  return RANGES.includes(n) ? n : 30;
}
const since = (days) => `-${windowDays(days)} days`;
const cleanVisitor = (v) => (/^[a-z0-9]{8,40}$/.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : '');
// Where the shopper was when they clicked: home, shop, vendor, search, …
const cleanSource = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12) || 'direct';

/**
 * Record one shopper action. Returns true when a row was written.
 *
 * The client never says which shop it is — that is resolved here from the
 * piece or the slug, so a beacon cannot post events into someone else's
 * numbers. Unknown pieces, unapproved shops and the owner's own visits are
 * dropped silently.
 */
function track({ kind, productId, shopSlug, visitor, source, userId }) {
  if (!KINDS.has(kind)) return false;

  let shopId = null;
  let pid = null;
  if (productId != null && productId !== '') {
    const row = db.prepare(`SELECT p.id, p.shop_id FROM products p
      JOIN shops s ON s.id = p.shop_id
      WHERE p.id = ? AND s.status = 'approved'`).get(parseInt(productId, 10) || 0);
    if (!row) return false;
    pid = row.id;
    shopId = row.shop_id;
  } else if (shopSlug) {
    const row = db.prepare("SELECT id FROM shops WHERE slug = ? AND status = 'approved'").get(String(shopSlug));
    if (!row) return false;
    shopId = row.id;
  }
  if (!shopId) return false;

  if (userId && db.prepare('SELECT 1 FROM shops WHERE id = ? AND user_id = ?').get(shopId, userId)) return false;

  const vis = cleanVisitor(visitor);
  // One event per visitor, per piece, per minute — a refresh, a back button or
  // a re-render must never read as fresh interest.
  if (vis) {
    const seen = db.prepare(`SELECT 1 FROM analytics_events
      WHERE kind = ? AND visitor = ? AND IFNULL(product_id, 0) = ? AND shop_id = ?
        AND created_at > datetime('now','-60 seconds') LIMIT 1`).get(kind, vis, pid || 0, shopId);
    if (seen) return false;
  }

  db.prepare('INSERT INTO analytics_events (kind, shop_id, product_id, visitor, source) VALUES (?,?,?,?,?)')
    .run(kind, shopId, pid, vis, cleanSource(source));
  return true;
}

/** Headline numbers for the window: interest from events, money from orders. */
function summary(shopId, days) {
  const w = since(days);
  const e = db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN visitor <> '' THEN visitor END) AS visitors,
      COALESCE(SUM(kind = 'shop_view'), 0)    AS shopViews,
      COALESCE(SUM(kind = 'product_view'), 0) AS productViews,
      COALESCE(SUM(kind = 'add_to_cart'), 0)  AS addToCart
    FROM analytics_events
    WHERE shop_id = ? AND created_at > datetime('now', ?)`).get(shopId, w);
  const s = db.prepare(`SELECT
      COUNT(DISTINCT o.id) AS orders,
      COALESCE(SUM(oi.qty), 0) AS units,
      COALESCE(SUM(oi.price_cents * oi.qty), 0) AS gross
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.shop_id = ? AND o.status IN ${PAID} AND o.created_at > datetime('now', ?)`).get(shopId, w);

  return {
    visitors: e.visitors,
    shopViews: e.shopViews,
    productViews: e.productViews,
    addToCart: e.addToCart,
    orders: s.orders,
    units: s.units,
    sales: s.gross / 100,
    earnings: fees.split(s.gross).net / 100,
    // Rates as fractions; the dashboard formats them. Null means "not enough
    // to divide by yet" — showing 0% when nobody has visited would be a lie.
    basketRate: e.productViews ? e.addToCart / e.productViews : null,
    orderRate: e.visitors ? s.orders / e.visitors : null,
  };
}

/** One row per day across the whole window, zero-filled, oldest first. */
function daily(shopId, days) {
  const n = windowDays(days);
  return db.prepare(`
    WITH RECURSIVE span(d) AS (
      SELECT date('now', ?)
      UNION ALL SELECT date(d, '+1 day') FROM span WHERE d < date('now')
    )
    SELECT span.d AS date,
      (SELECT COUNT(*) FROM analytics_events e
        WHERE e.shop_id = ? AND e.kind = 'product_view' AND date(e.created_at) = span.d) AS views,
      (SELECT COUNT(DISTINCT e.visitor) FROM analytics_events e
        WHERE e.shop_id = ? AND e.visitor <> '' AND date(e.created_at) = span.d) AS visitors,
      (SELECT COUNT(DISTINCT o.id) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.shop_id = ? AND o.status IN ${PAID} AND date(o.created_at) = span.d) AS orders
    FROM span`).all(`-${n - 1} days`, shopId, shopId, shopId);
}

/** Per-piece performance, busiest first. Every live or draft piece appears,
 *  so a maker can see the ones nobody is finding as clearly as the winners. */
function productRows(shopId, days) {
  const w = since(days);
  return db.prepare(`
    SELECT p.id, p.name, p.status, p.price_cents AS priceCents, p.stock,
      (SELECT COUNT(*) FROM analytics_events e
        WHERE e.product_id = p.id AND e.kind = 'product_view' AND e.created_at > datetime('now', ?)) AS views,
      (SELECT COUNT(*) FROM analytics_events e
        WHERE e.product_id = p.id AND e.kind = 'add_to_cart' AND e.created_at > datetime('now', ?)) AS adds,
      COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = p.id AND o.status IN ${PAID} AND o.created_at > datetime('now', ?)), 0) AS units,
      COALESCE((SELECT SUM(oi.price_cents * oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = p.id AND o.status IN ${PAID} AND o.created_at > datetime('now', ?)), 0) AS gross
    FROM products p
    WHERE p.shop_id = ? AND p.status <> 'hidden'
    ORDER BY views DESC, units DESC, p.created_at DESC`).all(w, w, w, w, shopId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      price: r.priceCents / 100,
      stock: r.stock,
      views: r.views,
      adds: r.adds,
      units: r.units,
      sales: r.gross / 100,
      earnings: fees.split(r.gross).net / 100,
      basketRate: r.views ? r.adds / r.views : null,
    }));
}

/** Which part of the storefront the piece views came from. */
function sources(shopId, days) {
  return db.prepare(`SELECT source, COUNT(*) AS n FROM analytics_events
    WHERE shop_id = ? AND kind = 'product_view' AND created_at > datetime('now', ?)
    GROUP BY source ORDER BY n DESC, source`).all(shopId, since(days));
}

/** When this shop's first event landed — the honest start of the record. */
function countingSince(shopId) {
  const row = db.prepare('SELECT MIN(created_at) AS t FROM analytics_events WHERE shop_id = ?').get(shopId);
  return row && row.t ? row.t : null;
}

/**
 * Retention. Visitor ids are scrubbed at 90 days (counts survive, the
 * identifier does not) and the rows themselves go at a year, so the log can
 * never grow without bound.
 */
function hygiene() {
  const scrubbed = db.prepare("UPDATE analytics_events SET visitor = '' WHERE visitor <> '' AND created_at < datetime('now','-90 days')").run().changes;
  const removed = db.prepare("DELETE FROM analytics_events WHERE created_at < datetime('now','-365 days')").run().changes;
  return { scrubbed, removed };
}

module.exports = { track, summary, daily, productRows, sources, countingSince, hygiene, windowDays, RANGES, KINDS };
