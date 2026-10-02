'use strict';
/**
 * Courier operations — everything that keeps a paid parcel moving when the
 * courier integration misbehaves, and makes sure a person hears about it.
 * (Fix round 2026-10-02: a booking that failed used to be a console line.)
 *
 *   book(id)          create the courier order at payment; a failure is
 *                     recorded on the shipment (booking_error) and the admin
 *                     is emailed once — the hourly sweep retries it.
 *   handOver(id)      the maker tapped Packed: book the order if it is still
 *                     missing, then book the collection (markReady). Only
 *                     when that went through does the parcel move to
 *                     'shipped' (= packed, courier booked, waiting for the
 *                     driver). On failure it stays 'processing' with
 *                     packed_at stamped, the admin is told, and it throws.
 *   retryBookings()   hourly: retry every paid parcel whose booking failed
 *                     or that is packed with no collection booked.
 *   stopParcel(id)    a refund/cancellation before the courier has the
 *                     parcel: cancel the courier booking; a refusal flags the
 *                     parcel (courier_cancel_failed) and emails the admin.
 *   collected(sh)     the courier reported the parcel collected.
 *   flagUncollected() hourly: packed + booked more than a day ago and still
 *                     not collected → flag + email once.
 *   checkWallet()     hourly: read the prepaid OTO wallet, email the owner
 *                     once when it drops below OTO_LOW_BALANCE (default 300,
 *                     in the wallet's currency — about 10 deliveries).
 *
 * shipments.attention holds what a person must look at (ATTENTION below);
 * the admin is emailed when the flag CHANGES, so a repeat never re-sends.
 */
const db = require('./db');

const delivery = () => require('./delivery');
const notify = () => require('./notify');

/** Admin-facing names for shipments.attention. */
const ATTENTION = {
  booking_failed: 'Courier not booked',
  courier_cancel_failed: 'Courier booking could not be cancelled',
  lost: 'Courier reports the parcel lost or damaged',
  returning: 'Delivery failed — the parcel is going back to the maker',
  delivered_after_cancel: 'Courier delivered a cancelled parcel',
  not_collected: 'Packed but not collected for over a day',
  refunded_in_transit: 'Refunded while the courier has the parcel',
  delivery_attempts: 'Repeated failed delivery attempts',
  // Set by Admin → Orders → Edit delivery details (src/admin-ops.js) when the
  // courier already holds the old address: change it in the OTO dashboard too.
  address_changed: 'Delivery details corrected after the courier order was made — update them with the courier too',
};

const facts = (id) => db.prepare(`SELECT sh.*, o.public_id, o.status AS order_status, o.refunded_at AS order_refunded_at,
    s.name AS shop_name, s.pickup_phone
  FROM shipments sh JOIN orders o ON o.id = sh.order_id JOIN shops s ON s.id = sh.shop_id WHERE sh.id=?`).get(id);
const event = (id, note) => db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, (SELECT status FROM shipments WHERE id=?), ?)').run(id, id, note);

/** Flag the parcel for a person; emails the admin only when the flag changes. */
function raise(shipmentId, kind, lines = []) {
  const changed = db.prepare("UPDATE shipments SET attention=?, attention_at=datetime('now') WHERE id=? AND attention != ?")
    .run(kind, shipmentId, kind).changes;
  if (!changed) return false;
  const f = facts(shipmentId);
  if (f) {
    notify().adminAlert({
      subject: `${ATTENTION[kind] || kind}: ${f.shop_name} · ${f.public_id}`,
      title: ATTENTION[kind] || kind,
      kicker: `Order ${f.public_id} · ${f.shop_name}`,
      lines: [...lines, f.pickup_phone ? `Maker's pickup phone: ${f.pickup_phone}` : ''].filter(Boolean),
    });
  }
  return true;
}
function clear(shipmentId, kinds) {
  db.prepare(`UPDATE shipments SET attention='', attention_at=NULL WHERE id=? AND attention IN (${kinds.map(() => '?').join(',')})`)
    .run(shipmentId, ...kinds);
}

/* ---- ops_state: tiny key/value store (wallet reading, alert stamps) ---- */
function getState(key) {
  const r = db.prepare('SELECT value FROM ops_state WHERE key=?').get(key);
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (_) { return r.value; }
}
function setState(key, value) {
  db.prepare(`INSERT INTO ops_state (key, value, updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, JSON.stringify(value));
}
const delState = (key) => db.prepare('DELETE FROM ops_state WHERE key=?').run(key);

/* ---- booking failures ---- */
const isWalletEmpty = (e) => /OTO1006/.test(`${(e && e.otoCode) || ''} ${(e && e.message) || ''}`);
// In the wallet's own currency, as OTO reports remainingCredit.
const lowThreshold = () => {
  const n = Number(process.env.OTO_LOW_BALANCE);
  return Number.isFinite(n) && n >= 0 ? n : 300;
};

function bookingFailed(shipmentId, stage, err) {
  const msg = String((err && err.message) || err || 'Booking failed').slice(0, 300);
  console.error(`Courier ${stage === 'order' ? 'booking' : 'collection booking'} failed for shipment ${shipmentId}:`, msg);
  db.prepare("UPDATE shipments SET booking_error=?, booking_error_at=datetime('now'), booking_attempts=booking_attempts+1 WHERE id=?")
    .run(msg, shipmentId);
  const wallet = isWalletEmpty(err);
  if (wallet) walletEmpty();
  raise(shipmentId, 'booking_failed', [
    stage === 'order'
      ? 'The courier order for this parcel could not be created when it was paid, so no courier is booked yet.'
      : 'The maker has packed this parcel, but booking the courier collection did not go through. No courier is coming yet.',
    wallet ? 'Reason: the OTO wallet is out of credit (OTO1006). Top it up in the OTO dashboard.' : `Reason: ${msg}`,
    'Trove retries every hour. You can also press Retry on the parcel in Admin → Orders.',
  ]);
}
function bookingOk(shipmentId) {
  db.prepare('UPDATE shipments SET booking_error=NULL, booking_error_at=NULL WHERE id=?').run(shipmentId);
  clear(shipmentId, ['booking_failed']);
}

/** Create the courier order (at payment). Never throws. */
async function book(shipmentId) {
  try {
    const r = await delivery().bookPickup(shipmentId);
    bookingOk(shipmentId);
    return r;
  } catch (e) {
    bookingFailed(shipmentId, 'order', e);
    return null;
  }
}

/**
 * The maker has packed: make sure the courier order exists and the
 * collection is booked, then (only then) move the parcel to 'shipped' =
 * packed and waiting for the courier. Throws after recording the failure.
 */
async function handOver(shipmentId) {
  db.prepare("UPDATE shipments SET packed_at=COALESCE(packed_at, datetime('now')) WHERE id=?").run(shipmentId);
  let sh = db.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
  const stage = sh.delivery_ref ? 'collection' : 'order';
  try {
    if (!sh.delivery_ref) await delivery().bookPickup(shipmentId);
    sh = db.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
    if (!sh.ready_at) await delivery().markReady(shipmentId);
  } catch (e) {
    bookingFailed(shipmentId, stage, e);
    throw e;
  }
  db.transaction(() => {
    const moved = db.prepare("UPDATE shipments SET status='shipped', updated_at=datetime('now') WHERE id=? AND status='processing'").run(shipmentId).changes;
    if (moved) {
      db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'shipped', ?)")
        .run(shipmentId, 'Packed — waiting for the courier to collect it');
      require('./shipments').deriveOrderStatus(sh.order_id);
    }
  })();
  bookingOk(shipmentId);
  return db.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
}

/** Hourly: retry failed bookings on live, paid parcels. */
async function retryBookings({ maxAttempts = 48 } = {}) {
  const live = delivery().isLive();
  const rows = db.prepare(`SELECT sh.id, sh.packed_at, sh.delivery_ref FROM shipments sh JOIN orders o ON o.id = sh.order_id
    WHERE sh.status = 'processing' AND o.status = 'paid' AND o.refunded_at IS NULL AND sh.booking_attempts < ?
      AND (sh.booking_error IS NOT NULL
        OR (sh.packed_at IS NOT NULL AND sh.ready_at IS NULL)
        OR (? = 1 AND COALESCE(sh.delivery_ref,'') = '' AND sh.created_at <= datetime('now','-10 minutes')))
    ORDER BY sh.id LIMIT 200`).all(maxAttempts, live ? 1 : 0);
  let ok = 0, failed = 0;
  for (const r of rows) {
    if (r.packed_at) {
      try { await handOver(r.id); ok++; } catch (_) { failed++; }
    } else if (await book(r.id)) ok++;
    else if (db.prepare('SELECT booking_error FROM shipments WHERE id=?').get(r.id).booking_error) failed++;
    else ok++;
  }
  return { tried: rows.length, ok, failed };
}

/**
 * Stop a parcel the courier has not collected (refund / cancellation). The
 * caller has already marked it cancelled in Trove. Resolves { stopped }.
 */
async function stopParcel(shipmentId, why = 'Order refunded') {
  const sh = db.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
  if (!sh || !sh.delivery_ref) return { stopped: true, booked: false };
  try {
    await delivery().cancelPickup(shipmentId);
    event(shipmentId, `Courier booking cancelled — ${why.toLowerCase()}`);
    return { stopped: true, booked: true };
  } catch (e) {
    console.error('Courier cancel failed for shipment', shipmentId, e.message);
    raise(shipmentId, 'courier_cancel_failed', [
      `${why}, but the courier booking for this parcel could not be cancelled (${String(e.message || '').slice(0, 200)}).`,
      'Cancel it in the OTO dashboard so no driver collects it. The maker has been emailed not to hand it over.',
    ]);
    return { stopped: false, booked: true, error: e.message };
  }
}

/** The courier has the parcel. */
function collected(shipmentId) {
  db.prepare("UPDATE shipments SET collected_at=COALESCE(collected_at, datetime('now')) WHERE id=?").run(shipmentId);
  clear(shipmentId, ['not_collected', 'booking_failed']);
}

/** Hourly: packed + collection booked over a day ago, still not collected. */
function flagUncollected({ hours = 24 } = {}) {
  const rows = db.prepare(`SELECT sh.id, sh.ready_at FROM shipments sh JOIN orders o ON o.id = sh.order_id
    WHERE sh.status = 'shipped' AND sh.ready_at IS NOT NULL AND sh.collected_at IS NULL AND sh.collect_alerted_at IS NULL
      AND sh.ready_at <= datetime('now', ?) AND o.refunded_at IS NULL AND o.status IN ('paid','fulfilled')`).all(`-${Number(hours)} hours`);
  for (const r of rows) {
    if (!db.prepare("UPDATE shipments SET collect_alerted_at=datetime('now') WHERE id=? AND collect_alerted_at IS NULL").run(r.id).changes) continue;
    raise(r.id, 'not_collected', [
      'The maker marked this parcel packed and the courier collection was booked more than a day ago, but the courier has not reported collecting it.',
      'Worth checking the booking in the OTO dashboard and calling the maker.',
    ]);
  }
  return rows.length;
}

/* ---- the prepaid OTO wallet ---- */
function walletAlert(remaining) {
  if (getState('oto_wallet_alerted')) return;
  setState('oto_wallet_alerted', new Date().toISOString());
  notify().adminAlert({
    subject: remaining == null ? 'The OTO courier wallet is empty' : `The OTO courier wallet is low — ${remaining} left`,
    title: 'Top up the courier wallet',
    lines: [
      remaining == null
        ? 'OTO refused a courier booking because the wallet is out of credit (OTO1006).'
        : `The prepaid OTO wallet has ${remaining} left, under the ${lowThreshold()} warning level.`,
      'Every courier booking is paid from this wallet: when it runs out, parcels stop being collected. Top it up in the OTO dashboard.',
    ],
  });
}
function walletEmpty() {
  const prev = getState('oto_wallet') || {};
  setState('oto_wallet', { ...prev, empty: true, emptyAt: new Date().toISOString() });
  walletAlert(null);
}
async function checkWallet() {
  if (!delivery().isOto()) return null;
  const a = await require('./delivery/oto-live').accountInfo();
  const remaining = Number(a && a.remainingCredit);
  if (!Number.isFinite(remaining)) return null;
  const low = remaining < lowThreshold();
  setState('oto_wallet', { remaining, plan: (a && a.packageName) || '', checkedAt: new Date().toISOString(), empty: false });
  if (low) walletAlert(remaining);
  else delState('oto_wallet_alerted');
  return { remaining, low };
}
function walletStatus() {
  const w = getState('oto_wallet');
  return {
    mode: delivery().mode(),
    threshold: lowThreshold(),
    remaining: w && w.remaining != null ? w.remaining : null,
    checkedAt: (w && w.checkedAt) || null,
    empty: !!(w && w.empty),
    low: !!(w && (w.empty || (w.remaining != null && w.remaining < lowThreshold()))),
  };
}

module.exports = {
  ATTENTION, raise, clear, getState, setState,
  bookingFailed, bookingOk, book, handOver, retryBookings, stopParcel, collected, flagUncollected,
  checkWallet, walletStatus, walletEmpty, lowThreshold,
};
