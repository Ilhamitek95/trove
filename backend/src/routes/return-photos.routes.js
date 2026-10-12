'use strict';
/**
 * GET /api/return-photos/:requestId/:n — one photo a buyer sent with a
 * return request (F227). The photos show people's homes and parcels, so
 * they live in the PRIVATE folder (src/uploads.js savePrivateImage) and are
 * streamed only to:
 *   - the admin,
 *   - the buyer who made the request,
 *   - a maker whose piece is in the request (also the admin in shop view).
 * Anyone else — signed out included — gets the same 404 as a photo that
 * does not exist. Never cached.
 */
const express = require('express');
const db = require('../db');
const uploads = require('../uploads');

const router = express.Router();

function mayView(userId, rr) {
  if (!userId) return false;
  const u = db.prepare('SELECT id, role FROM users WHERE id=?').get(userId);
  if (!u) return false;
  if (u.role === 'admin' || rr.buyer_id === u.id) return true;
  return !!db.prepare(`SELECT 1 FROM return_request_items ri JOIN order_items oi ON oi.id = ri.order_item_id
    JOIN shops s ON s.id = oi.shop_id WHERE ri.request_id = ? AND s.user_id = ? LIMIT 1`).get(rr.id, u.id);
}

router.get('/:requestId/:n', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const notFound = () => res.status(404).json({ error: 'Not found' });
  const rr = db.prepare('SELECT id, buyer_id, images FROM return_requests WHERE id=?').get(Number(req.params.requestId));
  if (!rr || !mayView(req.session && req.session.userId, rr)) return notFound();
  let images = [];
  try { images = JSON.parse(rr.images || '[]'); } catch (_) { images = []; }
  const file = uploads.privateImagePath(Array.isArray(images) ? images[Number(req.params.n)] : null);
  if (!file) return notFound();
  res.sendFile(file);
});

module.exports = router;
