'use strict';
/**
 * Per-piece make/pack time and the delivery estimate built on it (owner,
 * 2026-09-30: 'handmade things take longer; a knitted scarf 2 days, a
 * sweater longer').
 *
 *   products.lead_days   whole calendar days the maker needs to make or
 *                        finish and pack the piece after it is ordered
 *                        (1–42, default 2). Snapshotted on order_items at
 *                        checkout so a later edit never moves a promise.
 *   buyer estimate       lead_days + the courier window
 *                        (fees.COURIER_TRANSIT_MIN/MAX_DAYS, 1–4) — a 2-day
 *                        piece shows 3–6 days, exactly as before.
 *   order estimate       one shop packs all its pieces in one parcel, so a
 *                        shop's parcel waits for its slowest piece; different
 *                        shops send separate parcels. The order's estimate is
 *                        the slowest parcel, and when the shops' times differ
 *                        by SEPARATE_GAP_DAYS or more the buyer is told the
 *                        pieces arrive separately as each is ready.
 *   pack-by date         per shipment: the day the order was paid + the
 *                        slowest of THAT shop's pieces, as a Dubai calendar
 *                        day; stored as the last second of that day (UTC) in
 *                        shipments.pack_by_at so 'past it' means the whole
 *                        day has gone.
 */
const fees = require('./fees');

const SEPARATE_GAP_DAYS = 3;
const DUBAI_OFFSET_MS = 4 * 3600 * 1000; // UTC+4, no daylight saving

/** 400-style message for a bad value, or null. `undefined` is allowed (not sent). */
function leadDaysError(v) {
  if (v === undefined) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < fees.LEAD_DAYS_MIN || n > fees.LEAD_DAYS_MAX) {
    return `Ready to send in must be a whole number of days from ${fees.LEAD_DAYS_MIN} to ${fees.LEAD_DAYS_MAX} (six weeks)`;
  }
  return null;
}
const leadOf = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= fees.LEAD_DAYS_MIN ? Math.min(n, fees.LEAD_DAYS_MAX) : fees.LEAD_DAYS_DEFAULT;
};
const label = (min, max) => (min === max ? `${min} days` : `${min}–${max} days`);

/** The buyer's estimate for one piece. */
function estimate(leadDays) {
  const lead = leadOf(leadDays);
  const minDays = lead + fees.COURIER_TRANSIT_MIN_DAYS;
  const maxDays = lead + fees.COURIER_TRANSIT_MAX_DAYS;
  return {
    leadDays: lead,
    transitMinDays: fees.COURIER_TRANSIT_MIN_DAYS,
    transitMaxDays: fees.COURIER_TRANSIT_MAX_DAYS,
    minDays, maxDays,
    label: label(minDays, maxDays),
  };
}

/**
 * The order's estimate from its lines [{ shopId, leadDays }]: per shop the
 * slowest piece, overall the slowest shop.
 */
function orderEstimate(lines) {
  const perShop = new Map();
  for (const l of lines || []) {
    const k = String(l.shopId ?? l.shop_id ?? '');
    perShop.set(k, Math.max(perShop.get(k) || 0, leadOf(l.leadDays ?? l.lead_days)));
  }
  const leads = [...perShop.values()];
  if (!leads.length) leads.push(fees.LEAD_DAYS_DEFAULT);
  const e = estimate(Math.max(...leads));
  return { ...e, separately: leads.length > 1 && Math.max(...leads) - Math.min(...leads) >= SEPARATE_GAP_DAYS };
}

/** 'YYYY-MM-DD HH:MM:SS' (SQLite, UTC) → Date. */
const fromSql = (s) => new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
/** The pack-by moment: end of the Dubai calendar day `paidAt` + leadDays, as SQLite UTC text. */
function packByAt(paidAtSql, leadDays) {
  const paid = paidAtSql ? fromSql(paidAtSql) : new Date();
  const local = new Date(paid.getTime() + DUBAI_OFFSET_MS);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + leadOf(leadDays)));
  // 23:59:59 Dubai = 19:59:59 UTC on the same date.
  return `${day.toISOString().slice(0, 10)} 19:59:59`;
}
/** 'Friday 2 October' for a stored moment, in Dubai. */
function dubaiDay(sql, { year = false } = {}) {
  if (!sql) return '';
  const d = fromSql(sql);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}), timeZone: 'Asia/Dubai' });
}

module.exports = { SEPARATE_GAP_DAYS, leadDaysError, leadOf, estimate, orderEstimate, packByAt, dubaiDay, fromSql };
