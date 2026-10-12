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
// What the shop keeps of a sale: a maker keeps their share after the margin;
// the Trove Collection is Trove's own line, so its "earnings" are the sale.
const isHouse = (shopId) => !!(db.prepare('SELECT is_house FROM shops WHERE id = ?').get(shopId) || {}).is_house;
const keptOf = (gross, house) => (house ? gross : fees.split(gross).net);

const KINDS = new Set(['shop_view', 'product_view', 'add_to_cart']);
const RANGES = [7, 30, 90];
const PAID = "('paid','fulfilled')";

/* The units of one order line (oi, joined to its order o) the shop still
 * sold, net of refunds — the same rule as the Overview's Revenue · 30d
 * (seller.routes.js revenueSummary): a whole-order refund drops the line, a
 * refunded return drops the units that went back, and units Trove cancelled
 * before dispatch drop too. So Analytics and the Overview never disagree. */
const KEPT_UNITS = `(CASE WHEN o.refunded_at IS NOT NULL THEN 0 ELSE MAX(0, oi.qty - oi.cancelled_qty
    - COALESCE((SELECT SUM(ri.qty) FROM return_request_items ri JOIN return_requests rr ON rr.id = ri.request_id
        WHERE ri.order_item_id = oi.id AND rr.status = 'refunded'), 0)) END)`;

/* Limits on what one source can add to a shop's numbers (F245). The beacon
 * is anonymous by design — no account, no IP, and the per-browser id only
 * with measurement consent — so a forged beacon can't be told apart from a
 * real one. What can be done without identifying anyone: a browser id counts
 * at most VISITOR_PER_DAY events a day in one shop, and beacons sent without
 * an id are capped per shop per minute and per day, so a script can no
 * longer push thousands of views onto a shop. Env-overridable; 0 = no cap. */
const intEnv = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const caps = () => ({
  visitorPerDay: intEnv('ANALYTICS_VISITOR_PER_DAY', 120),
  anonPerMinute: intEnv('ANALYTICS_ANON_PER_MINUTE', 12),
  anonPerDay: intEnv('ANALYTICS_ANON_PER_DAY', 1500),
});

/* Shop days follow the Dubai calendar (UTC+4, no daylight saving), so a sale
 * at 1am on Friday lands on Friday's bar, not Thursday's (F457). */
const DUBAI_MS = 4 * 3600000;
const dubaiDay = (offsetDays = 0) => new Date(Date.now() + DUBAI_MS + offsetDays * 86400000).toISOString().slice(0, 10);

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
 * numbers. Unknown pieces, pieces that are not on sale (drafts, hidden),
 * unapproved shops and the owner's own visits are dropped silently, and so is
 * anything over the caps above.
 */
function track({ kind, productId, shopSlug, visitor, source, userId }) {
  if (!KINDS.has(kind)) return false;

  let shopId = null;
  let pid = null;
  if (productId != null && productId !== '') {
    const row = db.prepare(`SELECT p.id, p.shop_id FROM products p
      JOIN shops s ON s.id = p.shop_id
      WHERE p.id = ? AND p.status = 'live' AND s.status = 'approved'`).get(parseInt(productId, 10) || 0);
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
  const cap = caps();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  // One event per visitor, per piece, per minute — a refresh, a back button or
  // a re-render must never read as fresh interest.
  if (vis) {
    const seen = db.prepare(`SELECT 1 FROM analytics_events
      WHERE kind = ? AND visitor = ? AND IFNULL(product_id, 0) = ? AND shop_id = ?
        AND created_at > datetime('now','-60 seconds') LIMIT 1`).get(kind, vis, pid || 0, shopId);
    if (seen) return false;
    if (cap.visitorPerDay && count(`SELECT COUNT(*) AS n FROM analytics_events
        WHERE shop_id = ? AND visitor = ? AND created_at > datetime('now','-1 day')`, shopId, vis) >= cap.visitorPerDay) return false;
  } else {
    if (cap.anonPerMinute && count(`SELECT COUNT(*) AS n FROM analytics_events
        WHERE shop_id = ? AND visitor = '' AND created_at > datetime('now','-60 seconds')`, shopId) >= cap.anonPerMinute) return false;
    if (cap.anonPerDay && count(`SELECT COUNT(*) AS n FROM analytics_events
        WHERE shop_id = ? AND visitor = '' AND created_at > datetime('now','-1 day')`, shopId) >= cap.anonPerDay) return false;
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
  // Money from the order tables, net of refunds (KEPT_UNITS): an order that
  // came back in full is not an order, and refunded units earn nothing.
  const s = db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN kept > 0 THEN order_id END) AS orders,
      COALESCE(SUM(kept), 0) AS units,
      COALESCE(SUM(price_cents * kept), 0) AS gross
    FROM (SELECT oi.order_id, oi.price_cents, ${KEPT_UNITS} AS kept
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.shop_id = ? AND o.status IN ${PAID} AND o.created_at > datetime('now', ?))`).get(shopId, w);

  return {
    visitors: e.visitors,
    shopViews: e.shopViews,
    productViews: e.productViews,
    addToCart: e.addToCart,
    orders: s.orders,
    units: s.units,
    sales: s.gross / 100,
    earnings: keptOf(s.gross, isHouse(shopId)) / 100,
    // Rates as fractions; the dashboard formats them. Null means "not enough
    // to divide by yet" — showing 0% when nobody has visited would be a lie.
    basketRate: e.productViews ? e.addToCart / e.productViews : null,
    orderRate: e.visitors ? s.orders / e.visitors : null,
  };
}

/**
 * One row per Dubai day across the whole window, zero-filled, oldest first.
 * Two grouped range scans (events on the (shop_id, created_at) index, then
 * the shop's order lines), zero-filled here — never a sub-query per day,
 * which made a busy shop's 90-day chart scan its whole history 270 times
 * and hold up every other request while it did (F358).
 */
function daily(shopId, days) {
  const n = windowDays(days);
  const dates = [];
  for (let i = n - 1; i >= 0; i -= 1) dates.push(dubaiDay(-i));
  // Dubai midnight of the first day, as the UTC text the tables store.
  const from = `${dates[0]} 00:00:00`;
  const ev = new Map(db.prepare(`SELECT date(created_at, '+4 hours') AS d,
      COALESCE(SUM(kind = 'product_view'), 0) AS views,
      COUNT(DISTINCT CASE WHEN visitor <> '' THEN visitor END) AS visitors
    FROM analytics_events
    WHERE shop_id = ? AND created_at >= datetime(?, '-4 hours')
    GROUP BY d`).all(shopId, from).map((r) => [r.d, r]));
  const ord = new Map(db.prepare(`SELECT date(o.created_at, '+4 hours') AS d, COUNT(DISTINCT o.id) AS orders
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.shop_id = ? AND o.status IN ${PAID} AND o.created_at >= datetime(?, '-4 hours') AND ${KEPT_UNITS} > 0
    GROUP BY d`).all(shopId, from).map((r) => [r.d, r.orders]));
  return dates.map((d) => ({
    date: d,
    views: ev.has(d) ? ev.get(d).views : 0,
    visitors: ev.has(d) ? ev.get(d).visitors : 0,
    orders: ord.get(d) || 0,
  }));
}

/** Per-piece performance, busiest first. Every live or draft piece appears,
 *  so a maker can see the ones nobody is finding as clearly as the winners.
 *  Events and sales are each read in ONE grouped query and matched up here
 *  (no per-piece sub-queries, F358); sales are net of refunds (F241). */
function productRows(shopId, days) {
  const w = since(days);
  const house = isHouse(shopId);
  const ev = new Map(db.prepare(`SELECT product_id,
      COALESCE(SUM(kind = 'product_view'), 0) AS views, COALESCE(SUM(kind = 'add_to_cart'), 0) AS adds
    FROM analytics_events
    WHERE shop_id = ? AND product_id IS NOT NULL AND created_at > datetime('now', ?)
    GROUP BY product_id`).all(shopId, w).map((r) => [r.product_id, r]));
  const sold = new Map(db.prepare(`SELECT product_id, COALESCE(SUM(kept), 0) AS units, COALESCE(SUM(price_cents * kept), 0) AS gross
    FROM (SELECT oi.product_id, oi.price_cents, ${KEPT_UNITS} AS kept
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.shop_id = ? AND o.status IN ${PAID} AND o.created_at > datetime('now', ?))
    GROUP BY product_id`).all(shopId, w).map((r) => [r.product_id, r]));
  return db.prepare(`SELECT id, name, status, price_cents, stock, created_at FROM products
    WHERE shop_id = ? AND status <> 'hidden'`).all(shopId)
    .map((p) => {
      const e = ev.get(p.id) || { views: 0, adds: 0 };
      const s = sold.get(p.id) || { units: 0, gross: 0 };
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        price: p.price_cents / 100,
        stock: p.stock,
        views: e.views,
        adds: e.adds,
        units: s.units,
        sales: s.gross / 100,
        earnings: keptOf(s.gross, house) / 100,
        basketRate: e.views ? e.adds / e.views : null,
        createdAt: p.created_at,
      };
    })
    .sort((a, b) => b.views - a.views || b.units - a.units || String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(({ createdAt, ...row }) => row);
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
