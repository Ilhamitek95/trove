'use strict';
/**
 * 15-day returns + fortnightly maker payouts (owner, 2026-09-30):
 *   - one return-window constant (fees.RETURN_WINDOW_DAYS = 15) stamps the
 *     parcel, the buyer's deadline and the maker's hold;
 *   - a credit is payable only once the buyer's whole window has closed, and
 *     never while a return is in flight;
 *   - the settlement calendar is every other Tuesday from a fixed anchor;
 *   - migration 016 keeps money that was payable payable and honours the
 *     30-day promise on orders placed before the change.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, sellerCookie, shopId, buyerId;
let n = 0;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pcrypto = require('../src/crypto');
  const pw = hashPassword('testpass123');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer@test.local',?, 'Buyer','buyer')").run(pw).lastInsertRowid;
  shopId = db.prepare(`INSERT INTO shops (user_id,name,slug,status,payout_bank_name,payout_account_name,iban_encrypted,iban_masked,agreement_version,agreement_accepted_at)
    VALUES (?,?,?, 'approved','Test Bank','Maker LLC',?,?, 'v4', datetime('now'))`)
    .run(uid, 'Test Pots', 'test-pots', pcrypto.encrypt('AE070331234567890123456'), pcrypto.maskIban('AE070331234567890123456')).lastInsertRowid;
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

/** A paid consignment order with one AED 100 line, credit 6000, shipment processing. */
function mkOrder() {
  n += 1;
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,total_cents,status,rail,title_transferred_at)
    VALUES (?,?, 'buyer@test.local', 10000, 13000, 'paid', 'consignment', datetime('now'))`).run(`TRV-PS${n}`, buyerId).lastInsertRowid;
  const item = db.prepare("INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?, 'Bowl', 10000, 1)").run(id, shopId).lastInsertRowid;
  db.prepare("INSERT INTO seller_balances (shop_id,order_id,type,amount_cents) VALUES (?,?, 'credit_sale', 6000)").run(shopId, id);
  const sh = db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?, 'processing')").run(id, shopId).lastInsertRowid;
  return { id, item, sh };
}
/** Pretend the parcel was delivered `days` ago through the real funnel. */
function deliveredDaysAgo(o, days) {
  require('../src/shipments').markDelivered(o.sh, 'courier');
  db.prepare(`UPDATE shipments SET delivered_at=datetime('now', ?), return_window_ends_at=datetime('now', ?) WHERE id=?`)
    .run(`-${days} days`, `${15 - days} days`, o.sh);
  db.prepare(`UPDATE orders SET delivered_at=datetime('now', ?), return_window_ends_at=datetime('now', ?) WHERE id=?`)
    .run(`-${days} days`, `${15 - days} days`, o.id);
}
const payable = (orderId) => {
  const settlement = require('../src/settlement');
  return db.prepare(settlement.ELIGIBLE_CREDITS + ' AND b.order_id = @o').all({ at: db.prepare("SELECT datetime('now') AS t").get().t, o: orderId }).length > 0;
};

test('one 15-day constant: fees, config aliases and the returns module agree', () => {
  const fees = require('../src/fees');
  const cfg = require('../src/config');
  assert.equal(fees.RETURN_WINDOW_DAYS, 15);
  assert.equal(cfg.RETURN_WINDOW_DAYS, 15, 'maker hold');
  assert.equal(cfg.BUYER_RETURN_DAYS, 15, 'buyer window');
  assert.equal(require('../src/returns').BUYER_RETURN_DAYS, 15);
});

test('delivery stamps the parcel and the order with delivery + 15 days', () => {
  const o = mkOrder();
  require('../src/shipments').markDelivered(o.sh, 'courier');
  const sh = db.prepare('SELECT delivered_at, return_window_ends_at FROM shipments WHERE id=?').get(o.sh);
  const ord = db.prepare('SELECT delivered_at, return_window_ends_at FROM orders WHERE id=?').get(o.id);
  const plus15 = (t) => db.prepare("SELECT datetime(?, '+15 days') AS d").get(t).d;
  assert.equal(sh.return_window_ends_at, plus15(sh.delivered_at));
  assert.equal(ord.return_window_ends_at, plus15(ord.delivered_at), "the buyer's deadline is the same 15 days");
});

test('credit is payable only after the 15-day window: day 14 held, day 16 payable', () => {
  const early = mkOrder();
  deliveredDaysAgo(early, 14);
  const late = mkOrder();
  deliveredDaysAgo(late, 16);
  assert.equal(payable(early.id), false, 'still inside the buyer window');
  assert.equal(payable(late.id), true, 'window closed');
});

test('a return still in flight holds the credit even after the window closes', () => {
  const o = mkOrder();
  deliveredDaysAgo(o, 20);
  assert.equal(payable(o.id), true);
  const rr = db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,details,images,status) VALUES (?,?, 'damaged','Cracked','[]','approved')").run(o.id, buyerId).lastInsertRowid;
  db.prepare('INSERT INTO return_request_items (request_id, order_item_id, qty) VALUES (?,?,1)').run(rr, o.item);
  assert.equal(payable(o.id), false, 'collection booked → held');
  db.prepare("UPDATE return_requests SET status='declined' WHERE id=?").run(rr);
  assert.equal(payable(o.id), true, 'a declined return releases it');
});

test('multi-shop order: a shop waits for the buyer window, which starts at the LAST delivery', () => {
  const o = mkOrder();
  deliveredDaysAgo(o, 20);
  // A second shop's parcel on the same order is still on its way.
  const { hashPassword } = require('../src/middleware');
  const u2 = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('other@test.local',?, 'Other','seller')").run(hashPassword('x1234567')).lastInsertRowid;
  const shop2 = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?, 'Other', 'other', 'approved')").run(u2).lastInsertRowid;
  db.prepare("INSERT INTO shipments (order_id,shop_id,status) VALUES (?,?, 'processing')").run(o.id, shop2);
  db.prepare('UPDATE orders SET return_window_ends_at=NULL, delivered_at=NULL WHERE id=?').run(o.id);
  assert.equal(payable(o.id), false, 'other parcel undelivered → buyer window not even started');
});

test('fortnightly calendar: every other Tuesday from the anchor, both directions', () => {
  const s = require('../src/settlement');
  const fees = require('../src/fees');
  assert.equal(fees.SETTLEMENT_ANCHOR_DATE, '2026-10-06');
  assert.equal(fees.SETTLEMENT_INTERVAL_DAYS, 14);
  assert.equal(s.isRunDate('2026-10-06'), true, 'the anchor');
  assert.equal(s.isRunDate('2026-10-13'), false, 'the off-week Tuesday');
  assert.equal(s.isRunDate('2026-10-20'), true);
  assert.equal(s.isRunDate('2026-09-22'), true, 'before the anchor too');
  assert.equal(s.isRunDate('2026-10-07'), false, 'not a Tuesday');
  assert.equal(s.nextRunDate('2026-10-06'), '2026-10-06', 'a run day is its own next run');
  assert.equal(s.nextRunDate('2026-10-07'), '2026-10-20');
  assert.equal(s.nextRunDate('2026-10-13'), '2026-10-20');
  assert.deepEqual(s.upcomingRunDates(4, '2026-09-30'), ['2026-10-06', '2026-10-20', '2026-11-03', '2026-11-17']);
  for (const d of s.upcomingRunDates(30, '2026-09-30')) {
    assert.equal(new Date(d + 'T00:00:00Z').getUTCDay(), 2, `${d} is a Tuesday`);
  }
  // Across a year boundary the calendar stays on the same fortnight.
  assert.equal(s.nextRunDate('2026-12-30'), '2027-01-12');
  assert.equal(s.scheduleLabel(), 'Every other Tuesday');
});

test('the seller payments payload carries the schedule and the window', async () => {
  const res = await ctx.api('GET', '/api/seller/settlements', { cookie: sellerCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.schedule, 'Every other Tuesday');
  assert.equal(res.data.returnWindowDays, 15);
  assert.match(res.data.nextRunDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(require('../src/settlement').isRunDate(res.data.nextRunDate), true);
  assert.equal(res.data.upcomingRunDates.length, 3);
});

test('migration 016: payable money stays payable, open holds move to 15 days, old orders keep 30-day returns', () => {
  const mig = require('../src/migrations/016-returns-15-days');
  // An order from before the change, delivered 10 days ago: its old 7-day hold
  // already closed, so the maker could be paid — that must not change.
  const closed = mkOrder();
  db.prepare("UPDATE shipments SET status='delivered', delivered_at=datetime('now','-10 days'), return_window_ends_at=datetime('now','-3 days') WHERE id=?").run(closed.sh);
  db.prepare("UPDATE orders SET status='fulfilled', delivered_at=datetime('now','-10 days'), return_window_ends_at=datetime('now','-3 days') WHERE id=?").run(closed.id);
  // Delivered 3 days ago: still inside the old 7-day hold → moves to 15 days.
  const open = mkOrder();
  db.prepare("UPDATE shipments SET status='delivered', delivered_at=datetime('now','-3 days'), return_window_ends_at=datetime('now','+4 days') WHERE id=?").run(open.sh);
  db.prepare("UPDATE orders SET status='fulfilled', delivered_at=datetime('now','-3 days'), return_window_ends_at=datetime('now','+4 days') WHERE id=?").run(open.id);
  // An old-flow approval (refunded at approval).
  const rr = db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,details,images,status,decided_at) VALUES (?,?, 'damaged','Cracked','[]','approved', datetime('now','-1 day'))").run(closed.id, buyerId).lastInsertRowid;
  db.prepare('UPDATE orders SET return_days=NULL').run();

  mig.up(db);

  const shClosed = db.prepare('SELECT return_window_ends_at AS w, delivered_at AS d FROM shipments WHERE id=?').get(closed.sh);
  assert.equal(shClosed.w, db.prepare("SELECT datetime(?, '+7 days') AS x").get(shClosed.d).x, 'closed hold untouched');
  const shOpen = db.prepare('SELECT return_window_ends_at AS w, delivered_at AS d FROM shipments WHERE id=?').get(open.sh);
  assert.equal(shOpen.w, db.prepare("SELECT datetime(?, '+15 days') AS x").get(shOpen.d).x, 'open hold → 15 days');

  const oc = db.prepare('SELECT * FROM orders WHERE id=?').get(closed.id);
  assert.equal(oc.return_days, 30, 'bought under the 30-day promise');
  assert.equal(oc.return_window_ends_at, db.prepare("SELECT datetime(?, '+30 days') AS x").get(oc.delivered_at).x);
  const returns = require('../src/returns');
  assert.equal(returns.ineligibleReason(oc), null, 'a grandfathered buyer can still return on day 10');

  // Still payable despite the buyer's longer window (the old per-parcel hold applies).
  db.prepare("DELETE FROM return_requests WHERE id=?").run(rr);
  assert.equal(payable(closed.id), true, 'money that was payable stays payable');
  assert.equal(payable(open.id), false);

  // Replay the request conversion: approved (old flow = refunded at approval) → refunded.
  const rr2 = db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,details,images,status,decided_at) VALUES (?,?, 'damaged','Cracked','[]','approved', '2026-09-01 10:00:00')").run(open.id, buyerId).lastInsertRowid;
  mig.up(db);
  const conv = db.prepare('SELECT status, refunded_at FROM return_requests WHERE id=?').get(rr2);
  assert.equal(conv.status, 'refunded');
  assert.equal(conv.refunded_at, '2026-09-01 10:00:00');
});

test('copy: defaults say 15-day returns and fortnightly payouts; migration 017 rewrites saved overrides', () => {
  const content = require('../src/content');
  const all = JSON.stringify(content.DEFAULTS || content.defaults || require('../src/content'));
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'content.js'), 'utf8');
  for (const text of [src, all]) {
    assert.doesNotMatch(text, /30-day returns|Weekly payouts|weekly payout|paid out weekly|7-day buffer/);
  }
  assert.match(src, /15-day returns/);
  const page = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'docs', 'trove.html'), 'utf8');
  assert.doesNotMatch(page, /30-day returns|Weekly payouts|weekly payout|paid out weekly|7-day buffer/);

  db.prepare("INSERT OR REPLACE INTO site_content (section, value, updated_at) VALUES ('home.marquee', ?, datetime('now'))")
    .run(JSON.stringify({ items: [{ head: '30-day returns', sub: 'Free on orders over AED 200' }, { head: 'Our own words', sub: 'Kept' }] }));
  db.prepare("INSERT OR REPLACE INTO site_content (section, value, updated_at) VALUES ('sell.offer', ?, datetime('now'))")
    .run(JSON.stringify({ items: [{ title: 'Weekly payouts', text: "Your share lands in your bank account every week, and your Payments page shows exactly what's coming and when." }] }));
  require('../src/migrations/017-returns-payout-copy').up(db);
  const m = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='home.marquee'").get().value);
  assert.equal(m.items[0].head, '15-day returns');
  assert.equal(m.items[1].head, 'Our own words', 'unrelated admin copy untouched');
  const o = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='sell.offer'").get().value);
  assert.equal(o.items[0].title, 'Fortnightly payouts');
  assert.match(o.items[0].text, /every other Tuesday/);
});
