'use strict';
/**
 * Quiqup "Ecommerce orders" adapter (last-mile delivery only) — active when
 * QUIQUP_CLIENT_ID + QUIQUP_CLIENT_SECRET are set. Written against the
 * public docs at api-docs.quiqup.com (read 2026-09-14):
 *
 *   POST /oauth/token?grant_type=client_credentials   → bearer (7 days prod, 1 h staging)
 *   POST /orders                                       → order in `pending` (ignored by dispatch)
 *   PUT  /orders/{id}/ready_for_collection             → goes live for the next collection run
 *   GET  /order_label/{id}                             → AWB label PDF
 *
 * Env: QUIQUP_CLIENT_ID, QUIQUP_CLIENT_SECRET,
 *      QUIQUP_API_URL         https://api-ae.quiqup.com (prod) · https://api.staging.quiqup.com
 *      QUIQUP_KIND            partner_next_day (default) | partner_same_day | partner_4hr
 *      QUIQUP_WEBHOOK_SECRET  HMAC token Quiqup issues for X-Signature (see routes/delivery.routes.js)
 *
 * Flow: payment → bookPickup creates the order in `pending` (Quiqup portal
 * only) → maker packs and taps "Ready for collection" → markReady → Quiqup
 * collects from the shop's pickup address and delivers to the buyer.
 * Returns are a `partner_return` order (buyer → shop) submitted immediately.
 *
 * Failures are logged by the callers and never block the payment flow — the
 * seller stepper still works by hand.
 */
const parseShip = (json) => { try { return json ? JSON.parse(json) : null; } catch (_) { return null; } };
const base = () => (process.env.QUIQUP_API_URL || 'https://api-ae.quiqup.com').replace(/\/+$/, '');
const kind = () => process.env.QUIQUP_KIND || 'partner_next_day';

/* ---- OAuth2 client-credentials token, cached until 60 s before expiry ---- */
let cached = { token: '', exp: 0 };
async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const q = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.QUIQUP_CLIENT_ID || '',
    client_secret: process.env.QUIQUP_CLIENT_SECRET || '',
  });
  const res = await fetch(`${base()}/oauth/token?${q}`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!res.ok) throw new Error(`Quiqup token → ${res.status} ${await res.text()}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000 };
  return cached.token;
}
const resetToken = () => { cached = { token: '', exp: 0 }; };

async function call(method, path, body, raw) {
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, Accept: raw ? 'application/pdf' : 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) resetToken();
  if (!res.ok) throw new Error(`Quiqup ${method} ${path} → ${res.status} ${await res.text()}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/* ---- Payload builders (pure; pinned by test/quiqup.test.js) ---- */
const town = (s) => (/abu\s*dhabi/i.test(String(s || '')) ? 'Abu Dhabi' : 'Dubai');

function shopPoint(shop) {
  const line = shop.pickup_address || shop.seller_address || shop.location || '';
  return {
    contact_name: shop.name,
    contact_phone: shop.pickup_phone || '',
    notes: 'Collect from the maker · Trove Marketplace',
    address: { address1: line, town: town(line || shop.location), country: 'UAE' },
  };
}
function buyerPoint(shipment) {
  const dest = parseShip(shipment.shipping_json) || {};
  return {
    contact_name: dest.name || '',
    // The buyer's number lives on the order, never in the address snapshot —
    // that snapshot is what the seller dashboard shows (see src/db.js).
    contact_phone: shipment.buyer_phone || '',
    share_tracking: true,
    notes: dest.notes || '',
    address: { address1: dest.line || '', address2: dest.line2 || dest.area || '', town: town(dest.emirate || dest.city), country: 'UAE' },
  };
}

function order(kindOf, shipment, shop) {
  const reverse = kindOf === 'reverse';
  const ref = `${shipment.public_id || 'TRV'}-${shipment.id}${reverse ? '-R' : ''}`;
  const [origin, destination] = reverse ? [buyerPoint(shipment), shopPoint(shop)] : [shopPoint(shop), buyerPoint(shipment)];
  return {
    kind: reverse ? 'partner_return' : kind(),
    payment_mode: 'pre_paid',   // the card was charged on Trove — nothing to collect on the doorstep
    payment_amount: 0,
    partner_order_id: ref,
    notes: reverse ? `Trove return ${shipment.public_id || ''}`.trim() : `Trove order ${shipment.public_id || ''} · ${shop.name}`.trim(),
    origin: { ...origin, partner_order_id: ref },
    destination: { ...destination, partner_order_id: ref },
    // One parcel per shipment (a shipment = one shop's part of the order).
    items: [{ name: `${reverse ? 'Return' : 'Parcel'} · ${shipment.public_id || ref} · ${shop.name}`, quantity: 1 }],
  };
}

const shapeRes = (j) => {
  const o = (j && j.order) || j || {};
  return { ref: String(o.id || ''), trackingUrl: o.tracking_url || '', state: o.state || 'pending' };
};

module.exports = {
  name: 'Quiqup',
  _order: order,   // exported for the tests — never called by the app

  /** Creates the forward order in `pending`; goes live on markReady. */
  async bookPickup(shipment, shop) {
    return shapeRes(await call('POST', '/orders', order('pickup', shipment, shop)));
  },

  /** Return leg buyer → shop, submitted straight away (the buyer is waiting). */
  async bookReversePickup(shipment, shop) {
    const r = shapeRes(await call('POST', '/orders', order('reverse', shipment, shop)));
    if (r.ref) await call('PUT', `/orders/${encodeURIComponent(r.ref)}/ready_for_collection`);
    return r;
  },

  /** Maker has packed + labelled: hand the order to Quiqup's next collection run. */
  async markReady(ref) {
    return shapeRes(await call('PUT', `/orders/${encodeURIComponent(ref)}/ready_for_collection`));
  },

  /** AWB label PDF for the parcel (Quiqup generates the barcode). */
  async getLabel(ref) {
    return call('GET', `/order_label/${encodeURIComponent(ref)}`, null, true);
  },

  async getStatus(ref) {
    const j = await call('GET', `/orders/${encodeURIComponent(ref)}`);
    return shapeRes(j).state || 'unknown';
  },

  _resetToken: resetToken,
};
