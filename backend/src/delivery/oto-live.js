'use strict';
/**
 * OTO (tryoto.com) adapter — one integration, many UAE couriers, and a pickup
 * from every maker's own address. Active when OTO_REFRESH_TOKEN is set (it
 * takes precedence over Quiqup, which could only collect from one place).
 * Written against the OTO API V2 docs at apis.tryoto.com (read 2026-09-21),
 * "Manage vendors under one main account": Trove's wallet pays every
 * delivery, each maker is a pickup location.
 *
 *   POST /refreshToken           refresh_token → access_token (1 h)
 *   POST /createPickupLocation   one warehouse per maker, code trove-shop-<id>
 *   POST /updatePickupLocation   …kept in step with the shop's pickup address
 *   POST /createOrder            the order waits in OTO until the maker has packed
 *   POST /checkOTODeliveryFee    couriers + prices for the lane (OTO's own rates)
 *   POST /createShipment         books the courier (async) on "Packed · ready for collection"
 *   GET  /print/{orderId}        → printAWBURL, the label the maker prints
 *   POST /orderStatus            current status
 *   POST /createReturnShipment   return leg of a delivered order → <orderId>-R1
 *   GET|POST|PUT /webhook        orderStatus + shipmentError subscriptions
 *
 * Env: OTO_REFRESH_TOKEN       Settings → API Integrations → Connect in the OTO dashboard
 *      OTO_API_URL             default https://api.tryoto.com · sandbox https://staging-api.tryoto.com
 *      OTO_DELIVERY_OPTION_ID  pin one courier; otherwise the cheapest door-to-door
 *                              option with a courier pickup is chosen per parcel
 *      OTO_SERVICE_TYPE        prefer one OTO service type (e.g. express, sameDay)
 *      OTO_PARCEL_KG, OTO_PARCEL_CM  parcel used for pricing (default 1 kg, 30 cm cube)
 *      OTO_WEBHOOK_SECRET      HMAC key registered with OTO (see routes/delivery.routes.js)
 *
 * Failures are logged by the callers and never block the payment flow — the
 * seller stepper still works by hand.
 */
const parseShip = (json) => { try { return json ? JSON.parse(json) : null; } catch (_) { return null; } };
const base = () => {
  const host = (process.env.OTO_API_URL || 'https://api.tryoto.com').replace(/\/+$/, '');
  return /\/rest\/v2$/.test(host) ? host : host + '/rest/v2';
};
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const kg = () => num(process.env.OTO_PARCEL_KG, 1);
const cm = () => num(process.env.OTO_PARCEL_CM, 30);

/* ---- access token from the permanent refresh token, cached for ~1 h ---- */
let cached = { token: '', exp: 0 };
async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const res = await fetch(`${base()}/refreshToken`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: process.env.OTO_REFRESH_TOKEN || '' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`OTO token → ${res.status} ${j.otoErrorMessage || j.message || ''}`.trim());
  cached = { token: j.access_token, exp: Date.now() + Math.max(60, num(j.expires_in, 3600) - 120) * 1000 };
  return cached.token;
}
const resetToken = () => { cached = { token: '', exp: 0 }; };

async function call(method, path, body) {
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) resetToken();
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    const e = new Error(`OTO ${method} ${path} → ${res.status} ${j.otoErrorCode || ''} ${j.otoErrorMessage || j.message || ''}`.replace(/\s+/g, ' ').trim());
    e.otoCode = j.otoErrorCode || '';
    throw e;
  }
  return j;
}

/* ---- payload builders (pure; pinned by test/oto.test.js) ---- */
const town = (s) => (/abu\s*dhabi/i.test(String(s || '')) ? 'Abu Dhabi' : 'Dubai');
// OTO takes numbers without the plus: +971501112233 → 971501112233.
const mobile = (p) => String(p || '').replace(/\D/g, '').replace(/^00/, '');
const aed = (fils) => Math.round(Number(fils) || 0) / 100;
const locationCode = (shop) => `trove-shop-${shop.id}`;
// One OTO order per shipment (= one shop's part of a Trove order).
const orderRef = (shipment) => `${shipment.public_id || 'TRV'}-${shipment.id}`;
const sku = (orderItemId) => `OI-${orderItemId}`;

function location(shop) {
  const line = shop.pickup_address || shop.location || '';
  return {
    type: 'warehouse',
    code: locationCode(shop),
    name: `${shop.name} · Trove #${shop.id}`,
    mobile: mobile(shop.pickup_phone),
    contactName: shop.owner_name || shop.name,
    contactEmail: shop.owner_email || process.env.OTO_CONTACT_EMAIL || 'hello@troveathome.com',
    address: line,
    city: town(line || shop.location),
    country: 'AE',
    status: 'active',
  };
}

function customer(shipment) {
  const dest = parseShip(shipment.shipping_json) || {};
  const city = String(dest.city || '');
  // The checkout stores city as "Area, Emirate".
  const district = dest.area || (city.includes(',') ? city.split(',')[0].trim() : '');
  return {
    name: dest.name || '',
    // The buyer's number lives on the order, never in the address snapshot —
    // that snapshot is what the seller dashboard shows (see src/db.js).
    mobile: mobile(shipment.buyer_phone),
    address: [dest.line, dest.line2].filter(Boolean).join(', '),
    district,
    city: town(dest.emirate || city),
    country: 'AE',
  };
}

function order(shipment, shop, items = []) {
  const dest = parseShip(shipment.shipping_json) || {};
  const subtotal = items.reduce((t, i) => t + i.price_cents * i.qty, 0);
  return {
    orderId: orderRef(shipment),
    ref1: shipment.public_id || '',
    pickupLocationCode: locationCode(shop),
    payment_method: 'paid',   // the card was charged on Trove — nothing to collect on the doorstep
    amount: aed(subtotal),
    amount_due: 0,
    currency: 'AED',
    storeName: shop.name,
    senderName: shop.name,
    packageCount: 1,
    packageWeight: kg(),
    boxWidth: cm(), boxLength: cm(), boxHeight: cm(),
    shippingNotes: dest.notes || '',
    customer: customer(shipment),
    items: items.length
      ? items.map((i) => ({ name: i.name_snapshot, price: aed(i.price_cents), rowTotal: aed(i.price_cents * i.qty), quantity: i.qty, sku: sku(i.id) }))
      : [{ name: `Parcel · ${shipment.public_id || ''} · ${shop.name}`.trim(), quantity: 1, sku: `SH-${shipment.id}` }],
  };
}

/* Door-to-door with a courier pickup: never a locker, a counter the buyer
 * visits, or a branch the maker has to drop at — and never a specialist lane
 * (cold chain, heavy & bulky) unless asked for. Cheapest wins, after the
 * optional service-type preference; a tie goes to the cheaper return. */
const SPECIALIST = /^(coldDelivery|heavyAndBulky|electronicAndHeavy)$/;
function chooseOption(list, prefer = process.env.OTO_SERVICE_TYPE) {
  const ok = (list || []).filter((o) => o && o.deliveryOptionId
    && (!o.deliveryType || /^toCustomerDoorstep/.test(o.deliveryType))
    && !(/dropoff/i.test(String(o.pickupDropoff || '')) && !/pickup/i.test(String(o.pickupDropoff || ''))));
  const wanted = prefer && ok.some((o) => o.serviceType === prefer);
  const pool = wanted ? ok.filter((o) => o.serviceType === prefer) : ok.filter((o) => !SPECIALIST.test(String(o.serviceType || '')));
  const n = (v) => Number(v) || 0;
  return pool.sort((a, b) => n(a.price) - n(b.price) || n(a.returnFee) - n(b.returnFee))[0] || null;
}

async function pickOption(originCity, destinationCity, reverse) {
  const pinned = !reverse && process.env.OTO_DELIVERY_OPTION_ID;
  if (pinned) return { deliveryOptionId: Number(pinned), deliveryOptionName: '' };
  const j = await call('POST', '/checkOTODeliveryFee', {
    originCity, destinationCity, weight: kg(), length: cm(), width: cm(), height: cm(),
    packageCount: 1, currency: 'AED', ...(reverse ? { forReverseShipment: true } : {}),
  });
  const o = chooseOption(j.deliveryCompany);
  if (!o) throw new Error(`OTO has no door-to-door courier for ${originCity} → ${destinationCity}`);
  return o;
}

/* ---- the maker as a pickup location, created or refreshed on demand ---- */
const synced = new Map(); // shop id → JSON of the last payload OTO accepted (per process)
async function ensureLocation(shop) {
  const body = location(shop);
  const sig = JSON.stringify(body);
  if (synced.get(shop.id) === sig) return body.code;
  const first = synced.has(shop.id) ? 'update' : 'create';
  try {
    await call('POST', first === 'create' ? '/createPickupLocation' : '/updatePickupLocation', body);
  } catch (e) {
    // Already there (a restart) or gone (deleted in the dashboard): try the other verb.
    try { await call('POST', first === 'create' ? '/updatePickupLocation' : '/createPickupLocation', body); }
    catch (e2) { throw new Error(`${e.message} / ${e2.message}`); }
  }
  synced.set(shop.id, sig);
  return body.code;
}

const pretty = (dc) => {
  const k = String(dc || '').trim();
  const known = { aramex: 'Aramex', imile: 'iMile', smsa: 'SMSA', jtexpress: 'J&T Express', jt: 'J&T Express', dhl: 'DHL',
    emiratespost: 'Emirates Post', otodriverapp: 'OTO Flex', jeebly: 'Jeebly', shipa: 'Shipa' };
  return known[k.toLowerCase()] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : '');
};

module.exports = {
  name: 'OTO',
  carrierName: pretty,
  _order: order, _location: location, _chooseOption: chooseOption, _orderRef: orderRef,   // for the tests

  /** Pickup location for the maker + the order in OTO. No courier yet — that waits for markReady. */
  async bookPickup(shipment, shop, items) {
    await ensureLocation(shop);
    const body = order(shipment, shop, items);
    const j = await call('POST', '/createOrder', body);
    return { ref: body.orderId, trackingUrl: '', otoId: j.otoId };
  },

  /** Maker has packed: book the cheapest suitable courier to collect from their door. */
  async markReady(ref, shipment, shop) {
    const origin = town(shop && (shop.pickup_address || shop.location));
    const dest = customer(shipment || {}).city;
    const opt = await pickOption(origin, dest, false);
    await call('POST', '/createShipment', { orderId: ref, deliveryOptionId: opt.deliveryOptionId, pickingType: 'PICKUP_BY_DC' });
    return { ref, trackingUrl: '', state: 'searchingDriver', carrier: opt.deliveryOptionName || '' };
  },

  /** Return leg of a delivered parcel: the courier collects from the buyer and brings it to the maker. */
  async bookReversePickup(shipment, shop, _items, returnItems) {
    await ensureLocation(shop);
    const opt = await pickOption(customer(shipment).city, town(shop.pickup_address || shop.location), true);
    const body = { orderId: orderRef(shipment), pickupLocationCode: locationCode(shop), deliveryOptionId: opt.deliveryOptionId, pickingType: 'PICKUP_BY_DC' };
    if (returnItems && returnItems.length) body.items = returnItems.map((i) => ({ sku: sku(i.order_item_id), quantity: String(i.qty) }));
    const j = await call('POST', '/createReturnShipment', body);
    return { ref: j.returnOrderId || `${body.orderId}-R`, trackingUrl: '' };
  },

  /** Label: OTO hosts it; the seller route redirects the maker there. Null until the courier is booked. */
  async getLabel(ref) {
    try {
      const j = await call('GET', `/print/${encodeURIComponent(ref)}`);
      return j.printAWBURL ? { url: j.printAWBURL } : null;
    } catch (_) { return null; }
  },

  async getStatus(ref) {
    const j = await call('POST', '/orderStatus', { orderId: ref });
    return j.status || 'unknown';
  },

  async accountInfo() { return call('GET', '/accountInfo'); },

  /**
   * Point OTO's orderStatus + shipmentError webhooks at Trove, signed with
   * OTO_WEBHOOK_SECRET. Idempotent: an existing subscription on the same URL
   * is updated in place, so re-running at every boot is safe.
   */
  async ensureWebhooks(baseUrl, secret) {
    const root = String(baseUrl || '').replace(/\/+$/, '');
    const list = ((await call('GET', '/webhook')).webhooks) || [];
    const done = [];
    for (const [type, t] of [['orderStatus', 'status'], ['shipmentError', 'error']]) {
      const url = `${root}/api/delivery/oto-webhook?t=${t}`;
      const body = { method: 'post', url, secretKey: secret, authorizationKey: secret, webhookType: type };
      const have = list.find((w) => w.url === url);
      if (!have) await call('POST', '/webhook', body);
      else if (have.secretKey !== secret || have.authorizationKey !== secret) await call('PUT', '/webhook', { id: have.id, ...body });
      done.push(type);
    }
    return done;
  },

  _resetToken: resetToken,
  _synced: synced,
};
