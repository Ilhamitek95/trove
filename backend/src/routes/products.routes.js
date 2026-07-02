'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

function shape(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    price: p.price_cents / 100,
    compareAt: p.compare_at_cents ? p.compare_at_cents / 100 : null,
    stock: p.stock,
    imageSeed: p.image_seed,
    personalization: p.personalization_enabled
      ? { required: !!p.personalization_required, prompt: p.personalization_prompt || '', maxLen: p.personalization_char_limit || 256 }
      : null,
    shop: { id: p.shop_id, name: p.shop_name, slug: p.slug, location: p.location, color: p.color, isHouse: !!p.is_house },
  };
}

const BASE = `
  SELECT p.*, s.name AS shop_name, s.slug, s.location, s.color, s.is_house
  FROM products p JOIN shops s ON s.id = p.shop_id
  WHERE p.status = 'live'
`;

// GET /api/products?q=&category=&house=1&shop=slug
router.get('/', (req, res) => {
  const { q, category, house, shop } = req.query;
  let sql = BASE, args = [];
  if (category && category !== 'all') { sql += ' AND p.category = ?'; args.push(category); }
  if (house === '1') { sql += ' AND s.is_house = 1'; }
  if (shop) { sql += ' AND s.slug = ?'; args.push(shop); }
  if (q) { sql += ' AND (p.name LIKE ? OR p.category LIKE ? OR s.name LIKE ?)'; const like = `%${q}%`; args.push(like, like, like); }
  sql += ' ORDER BY p.created_at DESC';
  res.json({ products: db.prepare(sql).all(...args).map(shape) });
});

// GET /api/products/:id
router.get('/:id', (req, res) => {
  const p = db.prepare(BASE + ' AND p.id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({ product: shape(p) });
});

module.exports = router;
