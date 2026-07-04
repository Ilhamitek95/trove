'use strict';
/**
 * Ratings & reviews — verified purchases only.
 *
 * A buyer may review a product (or the shop behind it) only after a
 * non-refunded order of theirs containing that product/shop has been
 * DELIVERED. One review per buyer per product, one per buyer per shop
 * (shop reviews have product_id NULL); posting again edits in place.
 * Reviews can carry up to three photos, stored via src/uploads.js.
 * Admin can hide a review (status 'hidden') without deleting it.
 */
const db = require('./db');
const uploads = require('./uploads');

const MAX_IMAGES = 3;
const MAX_BODY = 2000;

/* ---- eligibility: a delivered, non-refunded purchase ---- */
function deliveredOrderFor(buyerId, { productId, shopId }) {
  const byProduct = `
    SELECT o.id FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN shipments sh ON sh.order_id = o.id AND sh.shop_id = oi.shop_id
    WHERE o.buyer_id = ? AND oi.product_id = ? AND sh.status = 'delivered'
      AND o.refunded_at IS NULL AND o.status IN ('paid','fulfilled')
    LIMIT 1`;
  const byShop = `
    SELECT o.id FROM shipments sh
    JOIN orders o ON o.id = sh.order_id
    WHERE o.buyer_id = ? AND sh.shop_id = ? AND sh.status = 'delivered'
      AND o.refunded_at IS NULL AND o.status IN ('paid','fulfilled')
    LIMIT 1`;
  const row = productId != null
    ? db.prepare(byProduct).get(buyerId, productId)
    : db.prepare(byShop).get(buyerId, shopId);
  return row ? row.id : null;
}

/* ---- shape helpers ---- */
// "Layla Hassan" → "Layla H." — enough to feel human, no full names published.
function displayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A trove buyer';
  return parts[0] + (parts[1] ? ` ${parts[1][0].toUpperCase()}.` : '');
}
function parseImages(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
function shape(r) {
  return {
    id: r.id,
    rating: r.rating,
    body: r.body,
    images: parseImages(r.images),
    buyer: displayName(r.buyer_name),
    productId: r.product_id || null,
    productName: r.product_name || null,
    createdAt: r.created_at,
    edited: r.updated_at !== r.created_at,
  };
}

/* ---- aggregates ---- */
function productSummary(productId) {
  const row = db.prepare(`SELECT ROUND(AVG(rating),1) avg, COUNT(*) count
    FROM reviews WHERE product_id = ? AND status = 'published'`).get(productId);
  return { avg: row.count ? row.avg : null, count: row.count };
}
// A shop's rating covers everything shoppers said about it: reviews of its
// pieces AND reviews of the shop itself.
function shopSummary(shopId) {
  const row = db.prepare(`SELECT ROUND(AVG(rating),1) avg, COUNT(*) count
    FROM reviews WHERE shop_id = ? AND status = 'published'`).get(shopId);
  return { avg: row.count ? row.avg : null, count: row.count };
}

/* ---- listing ---- */
function forProduct(productId) {
  return db.prepare(`
    SELECT r.*, u.name AS buyer_name FROM reviews r JOIN users u ON u.id = r.buyer_id
    WHERE r.product_id = ? AND r.status = 'published'
    ORDER BY r.created_at DESC LIMIT 100`).all(productId).map(shape);
}
function forShop(shopId) {
  return db.prepare(`
    SELECT r.*, u.name AS buyer_name, p.name AS product_name
    FROM reviews r JOIN users u ON u.id = r.buyer_id
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.shop_id = ? AND r.status = 'published'
    ORDER BY r.created_at DESC LIMIT 100`).all(shopId).map(shape);
}

/* ---- images: keep re-sent /uploads URLs that were already ours, save new
        data URLs, delete files the edit dropped ---- */
function saveImages(list, previous, key) {
  if (!Array.isArray(list)) list = [];
  const prev = parseImages(previous);
  const kept = [];
  let n = 0;
  for (const item of list.slice(0, MAX_IMAGES)) {
    const s = String(item || '');
    if (s.startsWith('data:')) kept.push(uploads.saveDataUrl(s, 'reviews', `${key}-${Date.now()}-${n++}`));
    else if (prev.includes(s)) kept.push(s); // only URLs this review already owned
  }
  for (const old of prev) if (!kept.includes(old)) uploads.removeByUrl(old);
  return kept;
}

/* ---- create-or-update ---- */
function upsert(buyer, { productId = null, shopId = null, rating, body = '', images = [] }) {
  rating = parseInt(rating);
  if (!(rating >= 1 && rating <= 5)) return { error: 'Pick a star rating from 1 to 5', status: 400 };
  body = String(body || '').trim().slice(0, MAX_BODY);

  let product = null;
  if (productId != null) {
    product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
    if (!product) return { error: 'Product not found', status: 404 };
    shopId = product.shop_id;
  } else if (shopId == null) {
    return { error: 'productId or shopId is required', status: 400 };
  } else if (!db.prepare('SELECT id FROM shops WHERE id=?').get(shopId)) {
    return { error: 'Shop not found', status: 404 };
  }

  const orderId = deliveredOrderFor(buyer.id, { productId, shopId });
  if (!orderId) return { error: 'Reviews are for delivered purchases — this one isn’t yours yet', status: 403 };

  const existing = productId != null
    ? db.prepare('SELECT * FROM reviews WHERE buyer_id=? AND product_id=?').get(buyer.id, productId)
    : db.prepare('SELECT * FROM reviews WHERE buyer_id=? AND shop_id=? AND product_id IS NULL').get(buyer.id, shopId);

  const imgKey = `rev-${buyer.id}-${productId != null ? 'p' + productId : 's' + shopId}`;
  const imagesJson = JSON.stringify(saveImages(images, existing ? existing.images : '[]', imgKey));

  if (existing) {
    // millisecond timestamp so an edit is distinguishable from the original
    // even within the same second (created_at has second resolution)
    db.prepare(`UPDATE reviews SET rating=?, body=?, images=?, order_id=?, status='published',
      updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?`).run(rating, body, imagesJson, orderId, existing.id);
    return { id: existing.id, updated: true };
  }
  const info = db.prepare(`INSERT INTO reviews (buyer_id, shop_id, product_id, order_id, rating, body, images)
    VALUES (?,?,?,?,?,?,?)`).run(buyer.id, shopId, productId, orderId, rating, body, imagesJson);
  return { id: info.lastInsertRowid, updated: false };
}

function removeOwn(buyerId, reviewId) {
  const r = db.prepare('SELECT * FROM reviews WHERE id=? AND buyer_id=?').get(reviewId, buyerId);
  if (!r) return false;
  for (const url of parseImages(r.images)) uploads.removeByUrl(url);
  db.prepare('DELETE FROM reviews WHERE id=?').run(r.id);
  return true;
}

module.exports = {
  deliveredOrderFor, displayName, parseImages, shape,
  productSummary, shopSummary, forProduct, forShop,
  upsert, removeOwn, MAX_IMAGES, MAX_BODY,
};
