'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

// The same account can run a shop AND a services practice. A shop's public
// shape carries its approved provider (with live services) so the storefront
// can cross-link; nothing private crosses over.
function providerFor(userId) {
  const p = db.prepare(`SELECT p.slug, p.name,
      (SELECT COUNT(*) FROM services sv WHERE sv.provider_id = p.id AND sv.status = 'live') AS n
    FROM service_providers p WHERE p.user_id = ? AND p.status = 'approved'`).get(userId);
  return p && p.n > 0 ? { slug: p.slug, name: p.name, serviceCount: p.n } : null;
}

function shape(s) {
  return {
    provider: providerFor(s.user_id),
    id: s.id,
    name: s.name,
    slug: s.slug,
    bio: s.bio,
    location: s.location,
    color: s.color,
    image: s.image || null,
    isHouse: !!s.is_house,
    productCount: s.product_count || 0,
    since: s.created_at ? String(s.created_at).slice(0, 4) : null,
    rating: s.rating_count ? { avg: s.avg_rating, count: s.rating_count } : null,
  };
}
// A shop's rating covers reviews of its pieces AND of the shop itself.
const RATING_JOIN = `
  LEFT JOIN (SELECT shop_id, ROUND(AVG(rating),1) AS avg_rating, COUNT(*) AS rating_count
             FROM reviews WHERE status = 'published' GROUP BY shop_id) rv ON rv.shop_id = s.id`;

// GET /api/shops  → every shop with its live-product count (house brand first)
router.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COUNT(p.id) AS product_count, rv.avg_rating, rv.rating_count
    FROM shops s
    LEFT JOIN products p ON p.shop_id = s.id AND p.status = 'live'
    ${RATING_JOIN}
    WHERE s.status = 'approved'
    GROUP BY s.id
    ORDER BY s.is_house DESC, s.created_at ASC
  `).all();
  res.json({ shops: rows.map(shape) });
});

// GET /api/shops/:slug → one shop profile
router.get('/:slug', (req, res) => {
  const s = db.prepare(`SELECT s.*, rv.avg_rating, rv.rating_count FROM shops s ${RATING_JOIN}
    WHERE s.slug = ? AND s.status = 'approved'`).get(req.params.slug);
  if (!s) return res.status(404).json({ error: 'Shop not found' });
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND status = 'live'").get(s.id);
  res.json({ shop: shape({ ...s, product_count: c }) });
});

// GET /api/shops/:slug/reviews → everything shoppers said about this shop:
// the shop-level reviews plus reviews of its pieces, newest first.
router.get('/:slug/reviews', (req, res) => {
  const s = db.prepare("SELECT id FROM shops WHERE slug = ? AND status = 'approved'").get(req.params.slug);
  if (!s) return res.status(404).json({ error: 'Shop not found' });
  const reviews = require('../reviews');
  res.json({ summary: reviews.shopSummary(s.id), reviews: reviews.forShop(s.id) });
});

module.exports = router;
