'use strict';
/**
 * Mock delivery provider — the default whenever the Quiqup credentials are
 * unset (local dev, tests, and production until the Quiqup keys arrive).
 * Booking succeeds instantly with a fake job reference; delivery is
 * confirmed by hand via POST /api/delivery/mock/deliver { shipmentId }.
 */
let n = 0;
const jobs = new Map(); // ref → { shipmentId, kind, status }

module.exports = {
  name: 'Quiqup',

  async bookPickup(shipment /* row */, _shop) {
    const ref = `QMOCK-${shipment.id}-${++n}`;
    jobs.set(ref, { shipmentId: shipment.id, kind: 'pickup', status: 'pending' });
    return { ref, trackingUrl: '' };
  },

  async bookReversePickup(shipment, _shop) {
    const ref = `QMOCK-R-${shipment.id}-${++n}`;
    jobs.set(ref, { shipmentId: shipment.id, kind: 'reverse', status: 'ready_for_collection' });
    return { ref, trackingUrl: '' };
  },

  async markReady(ref) {
    const j = jobs.get(ref);
    if (j) j.status = 'ready_for_collection';
    return { ref, trackingUrl: '', state: 'ready_for_collection' };
  },

  async getLabel(_ref) { return null; }, // no label in mock mode

  async getStatus(ref) {
    return (jobs.get(ref) || {}).status || 'unknown';
  },

  // Test/dev hook, used by the mock-deliver endpoint and the tests.
  _jobs: jobs,
};
