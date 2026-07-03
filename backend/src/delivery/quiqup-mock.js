'use strict';
/**
 * Mock delivery provider — the default whenever QUIQUP_API_KEY is unset
 * (local dev, tests, and the live demo until the Quiqup account exists).
 * Booking succeeds instantly with a fake job reference; delivery is
 * confirmed by hand via POST /api/delivery/mock/deliver { shipmentId }.
 */
let n = 0;
const jobs = new Map(); // ref → { shipmentId, kind, status }

module.exports = {
  name: 'Quiqup',

  async bookPickup(shipment /* row */, _shop) {
    const ref = `QMOCK-${shipment.id}-${++n}`;
    jobs.set(ref, { shipmentId: shipment.id, kind: 'pickup', status: 'booked' });
    return { ref, trackingUrl: '' };
  },

  async bookReversePickup(shipment, _shop) {
    const ref = `QMOCK-R-${shipment.id}-${++n}`;
    jobs.set(ref, { shipmentId: shipment.id, kind: 'reverse', status: 'booked' });
    return { ref, trackingUrl: '' };
  },

  async getStatus(ref) {
    return (jobs.get(ref) || {}).status || 'unknown';
  },

  // Test/dev hook, used by the mock-deliver endpoint.
  _jobs: jobs,
};
