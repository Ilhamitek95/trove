'use strict';
/**
 * Display-only demo listings (owner 2026-10-05: "disable the purchases for
 * test items"). The demo logins (seed-guard DEMO_EMAILS — on the live site
 * that is the Kiln & Clay shop and the Noor Letters provider, kept for the
 * owner's own testing until go-live) keep their pages, but nobody can buy a
 * demo piece or book a demo service with real money:
 *   - the public payloads say `forSale: false` (pieces) / `bookable: false`
 *     (services), so the storefront shows 'On display only' instead of
 *     'Add to basket' and the services page shows no booking form;
 *   - checkout and bookings refuse them (409 `display_only`) whatever the
 *     page sends.
 * On by default in production; DEMO_DISPLAY_ONLY=on|off overrides it
 * anywhere (off lets the owner test a real purchase on a demo piece). The
 * Trove Collection (the house shop) is never display-only.
 */
const db = require('./db');
const { DEMO_EMAILS } = require('./seed-guard');

const ORDER_REFUSED = 'A piece in your basket is on display only and can’t be bought — please remove it';
const BOOKING_REFUSED = 'This provider isn’t taking bookings yet';

function enabled() {
  const v = String(process.env.DEMO_DISPLAY_ONLY || '').trim().toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  return process.env.NODE_ENV === 'production';
}

const DEMO_IN = `(${DEMO_EMAILS.map(() => '?').join(',')})`;

/** True when this shop belongs to a demo login and the switch is on. */
function isDemoShop(shopId) {
  if (!enabled()) return false;
  return !!db.prepare(`SELECT 1 FROM shops s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.is_house = 0 AND lower(u.email) IN ${DEMO_IN}`).get(shopId, ...DEMO_EMAILS);
}

/** True when this services provider belongs to a demo login and the switch is on. */
function isDemoProvider(providerId) {
  if (!enabled()) return false;
  return !!db.prepare(`SELECT 1 FROM service_providers p JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND lower(u.email) IN ${DEMO_IN}`).get(providerId, ...DEMO_EMAILS);
}

module.exports = { ORDER_REFUSED, BOOKING_REFUSED, enabled, isDemoShop, isDemoProvider };
