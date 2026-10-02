'use strict';
/**
 * A lasting record of what the admin did (F065, migration 024-F3).
 *
 * One middleware, mounted on /api before the routers, writes a row to
 * admin_actions once a WRITE request has succeeded (status < 400) when
 *   - an admin made it (any /api route: admin panel, house mode at /sell,
 *     contact messages, privacy tools), or
 *   - it was made in shop view (the session carries impersonatorId): the row
 *     names the admin AND the shop being viewed, so 'who marked this parcel
 *     delivered — the courier or the admin?' has an answer.
 * A route can say what the thing was before the change with
 * res.locals.auditBefore (shop/provider/review/product status, a parcel's
 * status…) and add res.locals.auditNote. The request body is kept as 'after'
 * with secrets, bank numbers, codes and photos stripped.
 *
 * Writing the record never fails the request: it happens after the response.
 */
const db = require('./db');

const SKIP = [/^\/api\/auth\/(login|logout|admin-code|google|register|verify-email|forgot|reset)/, /^\/api\/(track|search-log)\b/];
// Never kept: secrets and bank numbers, files, and a person's contact details
// (the privacy erasure scrubs people from every record; this log must not
// become a copy of their address or email).
const SECRET_KEY = /pass(word)?|iban|token|secret|card|code$|^code|otp|cvc|eid|emirates|licen[cs]e_?image|image|photo|file|address|ship|phone|mobile|whatsapp|email|confirm/i;

/** The request body without secrets or bulky values, capped in size. */
function sanitize(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^data:/i.test(v)) return '[file]';
    return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) {
      out[k] = SECRET_KEY.test(k) ? '[hidden]' : sanitize(x, depth + 1);
    }
    return out;
  }
  return String(v);
}
const json = (v) => {
  if (v === undefined) return null;
  const s = JSON.stringify(sanitize(v));
  return s && s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
};

/* Plain-English names for the actions the owner will look for. The key is
 * '<METHOD> <router path pattern>' (the base path + the route's own path). */
const LABELS = {
  'PATCH /api/admin/shops/:id': 'Shop status changed',
  'POST /api/admin/shops/:id/identity-check': 'Emirates ID check',
  'POST /api/admin/shops/:id/payout-hold': 'Shop payouts hold',
  'PATCH /api/admin/providers/:id': 'Provider status changed',
  'PATCH /api/admin/reviews/:id': 'Review moderated',
  'PATCH /api/admin/products/:id': 'Product moderated',
  'PUT /api/admin/content/:section': 'Site content saved',
  'DELETE /api/admin/content/:section': 'Site content reset',
  'POST /api/admin/impersonate/:shopId': 'Shop view opened',
  'POST /api/auth/stop-impersonating': 'Shop view closed',
  'POST /api/admin/orders/:publicId/refund': 'Whole order refunded',
  'POST /api/admin/orders/:publicId/cancel-items': 'Pieces cancelled and refunded',
  'POST /api/admin/orders/:publicId/parcels/:shipmentId/cancel': 'Parcel cancelled and refunded',
  'POST /api/admin/orders/:publicId/release-hold': 'Order hold released',
  'PATCH /api/admin/orders/:publicId/delivery': 'Delivery details corrected',
  'POST /api/admin/shipments/:id/retry-courier': 'Courier booking retried',
  'POST /api/admin/shipments/:id/clear-attention': 'Parcel flag cleared',
  'POST /api/admin/returns/:id/approve': 'Return approved',
  'POST /api/admin/returns/:id/decline': 'Return declined',
  'POST /api/admin/returns/:id/refund-now': 'Return refunded early',
  'POST /api/admin/returns/:id/book-collection': 'Return collection rebooked',
  'POST /api/admin/settlements/run': 'Settlement run drafted',
  'POST /api/admin/settlements/:id/paid': 'Settlement marked paid',
  'POST /api/admin/settlements/:id/cancel': 'Settlement draft cancelled',
  'POST /api/admin/settlements/:id/undo-paid': 'Settlement payment undone',
  'POST /api/admin/settlements/:id/items/:itemId/remove': 'Maker taken out of a run',
  'POST /api/admin/service-bookings/:id/refund': 'Service booking refunded',
  'POST /api/admin/service-credits/:providerId/paid': 'Provider marked paid',
  'POST /api/admin/service-credits/:providerId/release-hold': 'Provider bank hold released',
  'POST /api/admin/graduation/:shopId/verify-license': 'Licence verified',
  'POST /api/admin/graduation/:shopId/approve': 'Graduation approved',
  'PATCH /api/seller/shipments/:id': 'Parcel updated in shop view',
};

function shopIdOf(userId) {
  const s = db.prepare('SELECT id FROM shops WHERE user_id=? ORDER BY id LIMIT 1').get(userId);
  return s ? s.id : null;
}

function middleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (SKIP.some((re) => re.test(path))) return next();
  // Captured now: stop-impersonating removes these from the session.
  const sess = req.session || {};
  const impersonatorId = sess.impersonatorId || null;
  const userId = sess.userId || null;
  if (!impersonatorId && !userId) return next();
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400) return;
      let adminId = impersonatorId;
      let shopView = null;
      if (impersonatorId) shopView = shopIdOf(userId);
      else {
        const u = req.user && req.user.id === userId ? req.user : db.prepare('SELECT id, role FROM users WHERE id=?').get(userId);
        if (!u || u.role !== 'admin') return;
        adminId = u.id;
      }
      const admin = db.prepare('SELECT email FROM users WHERE id=?').get(adminId);
      const pattern = req.route ? `${req.baseUrl}${req.route.path}` : path;
      const key = `${req.method} ${pattern}`;
      const segs = pattern.replace(/^\/api\/(admin\/)?/, '').split('/');
      const params = req.params || {};
      record({
        adminId, adminEmail: admin ? admin.email : '', shopViewId: shopView,
        method: req.method, path, action: LABELS[key] || key,
        targetType: segs[0] || '', targetId: Object.values(params).join('/'),
        before: res.locals.auditBefore, after: req.body && Object.keys(req.body).length ? req.body : undefined,
        note: res.locals.auditNote || '', status: res.statusCode,
      });
    } catch (e) { console.error('admin activity record failed:', e.message); }
  });
  next();
}

function record({ adminId = null, adminEmail = '', shopViewId = null, method = '', path = '', action, targetType = '', targetId = '', before, after, note = '', status = null }) {
  db.prepare(`INSERT INTO admin_actions (admin_id, admin_email, impersonating_shop_id, method, path, action, target_type, target_id, before_json, after_json, note, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(adminId, adminEmail, shopViewId, method, path, String(action).slice(0, 160), targetType, String(targetId).slice(0, 120),
      json(before), json(after), String(note).slice(0, 300), status);
}

/** The latest rows, newest first, for Admin → Activity. */
function latest(limit = 100) {
  return db.prepare(`SELECT a.*, s.name AS shop_name FROM admin_actions a
    LEFT JOIN shops s ON s.id = a.impersonating_shop_id
    ORDER BY a.id DESC LIMIT ?`).all(Math.min(500, Math.max(1, limit))).map((r) => ({
    id: r.id, at: r.at, admin: r.admin_email, shopView: r.impersonating_shop_id ? (r.shop_name || `shop ${r.impersonating_shop_id}`) : null,
    action: r.action, path: r.path, target: r.target_type ? `${r.target_type}${r.target_id ? ' ' + r.target_id : ''}` : '',
    before: r.before_json ? safeParse(r.before_json) : null, after: r.after_json ? safeParse(r.after_json) : null, note: r.note,
  }));
}
const safeParse = (s) => { try { return JSON.parse(s); } catch (_) { return s; } };

module.exports = { middleware, record, latest, sanitize, LABELS };
