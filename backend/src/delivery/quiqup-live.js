'use strict';
/**
 * Quiqup REST adapter — active when QUIQUP_API_KEY is set. Kept deliberately
 * thin: booking failures are logged and leave the shipment unbooked (the
 * seller stepper still works by hand), never blocking the payment flow.
 *
 * Env: QUIQUP_API_KEY, QUIQUP_API_URL (e.g. https://api.quiqup.com),
 *      QUIQUP_WEBHOOK_SECRET (shared secret checked on the delivery webhook).
 *
 * NOTE: endpoint paths/payloads follow Quiqup's partner API shape but MUST be
 * confirmed against the account's actual API docs before go-live.
 */
const parseShip = (json) => { try { return json ? JSON.parse(json) : null; } catch (_) { return null; } };

async function call(method, path, body) {
  const base = (process.env.QUIQUP_API_URL || 'https://api.quiqup.com').replace(/\/+$/, '');
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.QUIQUP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Quiqup ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

function job(kind, shipment, shop) {
  const dest = parseShip(shipment.shipping_json) || {};
  const pickupPoint = { name: shop.name, address: shop.location };
  const dropPoint = { name: dest.name || '', address: [dest.line, dest.city].filter(Boolean).join(', '), phone: dest.phone || '' };
  const [from, to] = kind === 'reverse' ? [dropPoint, pickupPoint] : [pickupPoint, dropPoint];
  return {
    kind: 'partner_delivery',
    reference: `trove-${shipment.order_id}-${shipment.id}${kind === 'reverse' ? '-r' : ''}`,
    pickup: from,
    dropoff: to,
    notes: `Trove order ${shipment.public_id || ''}`.trim(),
  };
}

module.exports = {
  name: 'Quiqup',

  async bookPickup(shipment, shop) {
    const j = await call('POST', '/partner/jobs', job('pickup', shipment, shop));
    return { ref: String(j.id || j.reference), trackingUrl: j.tracking_url || '' };
  },

  async bookReversePickup(shipment, shop) {
    const j = await call('POST', '/partner/jobs', job('reverse', shipment, shop));
    return { ref: String(j.id || j.reference), trackingUrl: j.tracking_url || '' };
  },

  async getStatus(ref) {
    const j = await call('GET', `/partner/jobs/${encodeURIComponent(ref)}`);
    return j.state || j.status || 'unknown';
  },
};
