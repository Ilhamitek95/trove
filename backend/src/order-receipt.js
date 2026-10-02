'use strict';
/**
 * The order confirmation page's own address and content (F164).
 *
 * After paying, the buyer lands on /order/<TRV-…>/thanks — an address that
 * survives a refresh, a back-swipe or a phone killing the tab. The page asks
 * GET /api/checkout/receipt/<TRV-…> for what was bought: each piece with its
 * options and extras, the amounts (subtotal, delivery, total paid), the
 * delivery address and the mobile, so a wrong address is caught at once.
 *
 * Who may read it: the signed-in buyer of the order, the browser session that
 * placed it, or whoever holds its receipt key — an HMAC of the order number
 * that the checkout call hands to the buyer's browser (kept on that device,
 * never in the address, so it never reaches analytics or a referrer). Anyone
 * else gets a plain 404, the same as an order that does not exist.
 */
const crypto = require('crypto');
const db = require('./db');

const secret = () => process.env.RECEIPT_LINK_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';

/** The receipt key of an order number (url-safe, 32 characters). */
function token(publicId) {
  return crypto.createHmac('sha256', secret()).update(`order-receipt:${publicId}`).digest('base64url').slice(0, 32);
}
function validToken(publicId, t) {
  const want = Buffer.from(token(publicId));
  const got = Buffer.from(String(t || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** May this request read the order's receipt? */
function canRead(order, req) {
  if (!order) return false;
  const s = req.session || {};
  if (order.buyer_id != null && s.userId != null && order.buyer_id === s.userId) return true;
  if (s.pendingOrderId != null && s.pendingOrderId === order.id) return true;
  return validToken(order.public_id, req.query.t || req.get('x-receipt-key'));
}

const parseJson = (t) => { try { return JSON.parse(t || 'null'); } catch (_) { return null; } };

/** What the confirmation page shows. Amounts in AED (the order's own snapshot). */
function shape(order) {
  const items = db.prepare(`SELECT oi.*, s.name AS shop_name, s.color, s.is_house FROM order_items oi
    JOIN shops s ON s.id = oi.shop_id WHERE oi.order_id = ? ORDER BY oi.id`).all(order.id);
  const addr = parseJson(order.shipping_json) || {};
  const lt = require('./lead-times');
  return {
    id: order.public_id,
    // pending = the card went through in the browser and Stripe's
    // confirmation is still on its way (usually seconds)
    status: order.status,
    createdAt: order.created_at,
    subtotal: (order.subtotal_cents || 0) / 100,
    serviceFee: (order.service_fee_cents || 0) / 100,
    delivery: (order.shipping_cents || 0) / 100,
    total: (order.total_cents || 0) / 100,
    items: items.map((i) => ({
      name: i.name_snapshot,
      qty: i.qty,
      cancelledQty: i.cancelled_qty || 0,
      lineTotal: (i.price_cents * i.qty) / 100,
      options: require('./options').label(i.options),
      extras: require('./extras').parse(i.extras).map((e) => e.name),
      personalization: i.personalization || '',
      leadDays: lt.estimate(i.lead_days).leadDays,
      shop: { name: i.shop_name, color: i.color, isHouse: !!i.is_house },
    })),
    address: { name: addr.name || '', line: addr.line || '', city: addr.city || '' },
    phone: order.phone || '',
  };
}

module.exports = { token, validToken, canRead, shape };
