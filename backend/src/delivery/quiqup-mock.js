'use strict';
/**
 * Mock delivery provider — the default whenever the Quiqup credentials are
 * unset (local dev, tests, and production until the Quiqup keys arrive).
 * Booking succeeds instantly with a fake job reference; delivery is
 * confirmed by hand via POST /api/delivery/mock/deliver { shipmentId }.
 *
 * `_failNext[call] = 'message'` makes the next call of that kind throw (the
 * tests use it to play an empty courier wallet or a courier refusing).
 */
let n = 0;
const jobs = new Map(); // ref → { shipmentId, kind, status }
const failNext = {};
function failIf(kind) {
  if (!failNext[kind]) return;
  const msg = failNext[kind];
  delete failNext[kind];
  const e = new Error(msg);
  const code = /OTO\d{4}/.exec(msg);
  if (code) e.otoCode = code[0];
  throw e;
}

module.exports = {
  name: 'Quiqup',

  async bookPickup(shipment /* row */, _shop) {
    failIf('bookPickup');
    const ref = `QMOCK-${shipment.id}-${++n}`;
    jobs.set(ref, { shipmentId: shipment.id, kind: 'pickup', status: 'pending' });
    return { ref, trackingUrl: '' };
  },

  async bookReversePickup(shipment, _shop) {
    failIf('bookReversePickup');
    const ref = `QMOCK-R-${shipment.id}-${++n}`;
    jobs.set(ref, { shipmentId: shipment.id, kind: 'reverse', status: 'ready_for_collection' });
    return { ref, trackingUrl: '' };
  },

  async cancelPickup(ref) {
    failIf('cancelPickup');
    const j = jobs.get(ref);
    if (j && ['collected', 'delivered'].includes(j.status)) throw new Error('The courier already has this parcel');
    if (j) j.status = 'cancelled';
    return { ref, cancelled: true };
  },

  async markReady(ref) {
    failIf('markReady');
    const j = jobs.get(ref);
    if (j) j.status = 'ready_for_collection';
    return { ref, trackingUrl: '', state: 'ready_for_collection' };
  },

  async getLabel(_ref) { return null; }, // no label in mock mode

  async getStatus(ref) {
    return (jobs.get(ref) || {}).status || 'unknown';
  },

  // Test/dev hooks, used by the mock-deliver endpoint and the tests.
  _jobs: jobs,
  _failNext: failNext,
};
