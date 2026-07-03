'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware');
const shipments = require('../shipments');
const { SERVICE_AREAS, isServiceable } = require('../service-area');

const router = express.Router();

/* ---------------- Orders (buyer) ---------------- */
router.get('/orders', requireAuth, (req, res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE buyer_id=? AND status!='pending' ORDER BY created_at DESC").all(req.user.id);
  const itemsStmt = db.prepare(`SELECT oi.*, s.name AS shop_name, s.color, s.is_house FROM order_items oi JOIN shops s ON s.id=oi.shop_id WHERE oi.order_id=?`);
  const shipStmt = db.prepare(`SELECT sh.*, s.name AS shop_name, s.color, s.is_house FROM shipments sh JOIN shops s ON s.id=sh.shop_id WHERE sh.order_id=? ORDER BY sh.id`);
  res.json({
    orders: orders.map((o) => ({
      id: o.public_id,
      status: o.status,
      total: o.total_cents / 100,
      createdAt: o.created_at,
      deliveredAt: o.delivered_at || null,
      returnWindowEndsAt: o.return_window_ends_at || null,
      refundedAt: o.refunded_at || null,
      items: itemsStmt.all(o.id).map((i) => ({
        name: i.name_snapshot, qty: i.qty, price: i.price_cents / 100, personalization: i.personalization || '',
        shop: { name: i.shop_name, color: i.color, isHouse: !!i.is_house },
      })),
      shipments: shipStmt.all(o.id).map((sh) => shipments.shape(sh)),
    })),
  });
});

/* ---------------- Addresses ---------------- */
router.get('/addresses', requireAuth, (req, res) => {
  res.json({ addresses: db.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id').all(req.user.id) });
});

router.post('/addresses', requireAuth, (req, res) => {
  const { label = 'Home', name, line, city, country = 'United Arab Emirates', phone = '', isDefault } = req.body || {};
  if (!name || !line || !city) return res.status(400).json({ error: 'name, line and city are required' });
  if (!isServiceable(city)) return res.status(400).json({ error: `We currently deliver in ${SERVICE_AREAS.join(' and ')} only` });
  if (isDefault) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.user.id);
  const info = db.prepare('INSERT INTO addresses (user_id,label,name,line,city,country,phone,is_default) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, label, name, line, city, country, phone, isDefault ? 1 : 0);
  res.status(201).json({ address: db.prepare('SELECT * FROM addresses WHERE id=?').get(info.lastInsertRowid) });
});

router.patch('/addresses/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM addresses WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.city !== undefined && !isServiceable(b.city)) return res.status(400).json({ error: `We currently deliver in ${SERVICE_AREAS.join(' and ')} only` });
  if (b.isDefault) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.user.id);
  db.prepare('UPDATE addresses SET label=COALESCE(?,label), name=COALESCE(?,name), line=COALESCE(?,line), city=COALESCE(?,city), country=COALESCE(?,country), phone=COALESCE(?,phone), is_default=COALESCE(?,is_default) WHERE id=?')
    .run(b.label, b.name, b.line, b.city, b.country, b.phone, b.isDefault === undefined ? a.is_default : (b.isDefault ? 1 : 0), a.id);
  res.json({ address: db.prepare('SELECT * FROM addresses WHERE id=?').get(a.id) });
});

router.delete('/addresses/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
