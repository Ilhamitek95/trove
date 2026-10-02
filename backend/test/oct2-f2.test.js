'use strict';
/**
 * Third review, round 2 — group F2 (buyer account, buyer returns, emails):
 *   F087/F161 returns open per parcel (a delivered parcel can go back while
 *             another maker's is late or cancelled; undelivered pieces can't)
 *   F088      unpaid checkouts closed by the sweep are not 'orders'
 *   F090      the buyer never sees internal notes, the OTO booking ref as a
 *             tracking number, Trove's refund note or raw courier errors
 *   F091      a new account's email must look like an email
 *   F094      the order payload carries its address + money breakdown
 *   F067      a whole-order refund emails the buyer (+ makers)
 *   F165      the buyer is emailed when a parcel is delivered (return date)
 *   F173      makers are emailed when a return is coming back and when paid
 *   F196      the owner is emailed on a paid order, a return request and an
 *             automatic sold-out refund — first name + order number only
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ ADMIN_EMAIL: 'owner@test.local' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let ctx, db, adminCookie, buyerCookie, makerACookie, buyerId, shopA, shopB, mug, wallet;
let sent = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mailsTo = (to) => sent.filter((m) => m.to === to);
const OWNER = 'owner@test.local';

async function paidOrder(pid, pi, lines) {
  const sub = lines.reduce((t, l) => t + l.cents, 0);
  const ship = sub > 20000 ? 0 : 3000;
  const oid = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id,shipping_json)
    VALUES (?,?,?,?,?,?,0,?,'pending','consignment',?,?)`)
    .run(pid, buyerId, 'layla@test.local', '+971501112233', sub, ship, sub + ship, pi,
      JSON.stringify({ name: 'Layla Haddad', line: '1 Marina Walk', line2: 'Apt 1203', city: 'Dubai Marina, Dubai' })).lastInsertRowid;
  for (const l of lines) {
    db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,1)').run(oid, l.product, l.shop, l.name, l.cents);
  }
  const r = await ctx.postWebhook({ id: 'evt_' + pi, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(oid) } } } });
  assert.equal(r.status, 200);
  await sleep(60);
  return { oid, sh: (shopId) => db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(oid, shopId) };
}
const acctOrder = async (pid) => (await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie })).data.orders.find((o) => o.id === pid);
const deliver = (shipmentId) => require('../src/shipments').markDelivered(shipmentId, 'courier');
const returnBody = (orderItemIds) => ({ items: orderItemIds.map((id) => ({ id, qty: 1 })), reason: 'damaged', details: 'It arrived cracked.', images: [PNG] });

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?, 'Owner','admin')").run(OWNER, pw);
  buyerId = db.prepare("INSERT INTO users (email,password_hash,name,role,email_verified_at) VALUES ('layla@test.local',?, 'Layla Haddad','buyer',datetime('now'))").run(pw).lastInsertRowid;
  const ua = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('kiln@test.local',?, 'Mara Kiln','seller')").run(pw).lastInsertRowid;
  const ub = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('ember@test.local',?, 'Eli Ember','seller')").run(pw).lastInsertRowid;
  shopA = db.prepare("INSERT INTO shops (user_id,name,slug,status,pickup_address,pickup_phone) VALUES (?,?,?,'approved','Al Quoz 3, Dubai','+971500000001')").run(ua, 'Kiln & Clay', 'kiln-clay').lastInsertRowid;
  shopB = db.prepare("INSERT INTO shops (user_id,name,slug,status,pickup_address,pickup_phone) VALUES (?,?,?,'approved','JLT, Dubai','+971500000002')").run(ub, 'Ember Goods', 'ember-goods').lastInsertRowid;
  const prod = (shop, name, cents) => db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,50,'live')").run(shop, name, 'Ceramics', cents).lastInsertRowid;
  mug = { product: prod(shopA, 'Mug', 6400), shop: shopA, name: 'Mug', cents: 6400 };
  wallet = { product: prod(shopB, 'Wallet', 19500), shop: shopB, name: 'Wallet', cents: 19500 };
  adminCookie = await ctx.loginAs(OWNER, 'testpass123');
  buyerCookie = await ctx.loginAs('layla@test.local', 'testpass123');
  makerACookie = await ctx.loginAs('kiln@test.local', 'testpass123');
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
});
after(async () => { await ctx.close(); });

test('F196: a paid order emails the owner — first name and order number, nothing else about the buyer', async () => {
  sent = [];
  await paidOrder('TRV-F2A1', 'pi_f2_a1', [mug, wallet]);
  const owner = mailsTo(OWNER).filter((m) => /New order TRV-F2A1/.test(m.subject));
  assert.equal(owner.length, 1, 'one owner alert per paid order');
  assert.match(owner[0].html, /Layla paid/);
  assert.doesNotMatch(owner[0].html, /Haddad|layla@test\.local|\+971501112233|Marina Walk/, 'no surname, email, phone or address');
  assert.match(owner[0].html, /Shops: Ember Goods, Kiln &amp; Clay\./);
});

test('F087/F161: a delivered parcel can be returned while the other maker’s is still on its way; undelivered pieces cannot be picked', async () => {
  const o = await paidOrder('TRV-F2B1', 'pi_f2_b1', [mug, wallet]);
  sent = [];
  deliver(o.sh(shopA).id);
  await sleep(30);
  // F165: the buyer hears it arrived and until when it can go back.
  const delivered = mailsTo('layla@test.local').filter((m) => /Delivered — your parcel from Kiln & Clay/.test(m.subject));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].html, /Returns are open until/);

  const acct = await acctOrder('TRV-F2B1');
  assert.equal(acct.returns.eligible, true, 'returns open on the delivered parcel');
  assert.equal(acct.returns.blocked, null);
  const mugLine = acct.returns.items.find((i) => i.name === 'Mug');
  const walletLine = acct.returns.items.find((i) => i.name === 'Wallet');
  assert.equal(mugLine.available, 1);
  assert.ok(mugLine.deadline);
  assert.equal(walletLine.available, 0);
  assert.equal(walletLine.locked, 'not_delivered');
  const shA = acct.shipments.find((s) => s.shop.name === 'Kiln & Clay');
  const shB = acct.shipments.find((s) => s.shop.name === 'Ember Goods');
  assert.ok(shA.returnUntil, 'the delivered parcel shows its own return date');
  assert.equal(shB.returnUntil, null);

  let r = await ctx.api('POST', '/api/account/orders/TRV-F2B1/return-request', { cookie: buyerCookie, body: returnBody([walletLine.id]) });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /not been delivered yet/);
  sent = [];
  r = await ctx.api('POST', '/api/account/orders/TRV-F2B1/return-request', { cookie: buyerCookie, body: returnBody([mugLine.id]) });
  assert.equal(r.status, 201, 'the broken mug can be reported straight away');
  await sleep(20);
  // F196: the owner is told a request is waiting for them.
  const alert = mailsTo(OWNER).find((m) => /Return request on order TRV-F2B1/.test(m.subject));
  assert.ok(alert, 'owner alerted to the return request');
  assert.match(alert.html, /Layla asked to send back Mug/);
  assert.doesNotMatch(alert.html, /Haddad|layla@test\.local/);

  // F173: approving it tells the maker their piece is coming back.
  sent = [];
  r = await ctx.api('POST', `/api/admin/returns/${r.data.id}/approve`, { cookie: adminCookie, body: {} });
  assert.equal(r.status, 200);
  await sleep(30);
  const maker = mailsTo('kiln@test.local').find((m) => /A return is on its way back to you — order TRV-F2B1/.test(m.subject));
  assert.ok(maker, 'maker told the return is coming');
  assert.match(maker.html, /Faulty or damaged/);
  assert.doesNotMatch(maker.html, /Layla|layla@test\.local|Marina/, 'nothing about the buyer');
  assert.equal(mailsTo('ember@test.local').length, 0, 'the other maker is not involved');
});

test('F087: when the sibling parcel is cancelled, the delivered parcel stays returnable', async () => {
  const o = await paidOrder('TRV-F2B2', 'pi_f2_b2', [mug, wallet]);
  deliver(o.sh(shopA).id);
  db.prepare("UPDATE shipments SET status='cancelled', cancelled_at=datetime('now') WHERE id=?").run(o.sh(shopB).id);
  require('../src/shipments').deriveOrderStatus(o.oid);
  const acct = await acctOrder('TRV-F2B2');
  assert.equal(acct.returns.eligible, true);
  const mugLine = acct.returns.items.find((i) => i.name === 'Mug');
  const r = await ctx.api('POST', '/api/account/orders/TRV-F2B2/return-request', { cookie: buyerCookie, body: returnBody([mugLine.id]) });
  assert.equal(r.status, 201);
});

test('F087: a parcel’s own window closes 15 days after its delivery; the footer reason is server-fed', async () => {
  const o = await paidOrder('TRV-F2B3', 'pi_f2_b3', [mug]);
  let acct = await acctOrder('TRV-F2B3');
  assert.equal(acct.returns.eligible, false);
  assert.match(acct.returns.blocked, /once the order has been delivered/);
  deliver(o.sh(shopA).id);
  db.prepare("UPDATE shipments SET delivered_at=datetime('now','-16 days') WHERE id=?").run(o.sh(shopA).id);
  db.prepare("UPDATE orders SET delivered_at=datetime('now','-16 days'), return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(o.oid);
  acct = await acctOrder('TRV-F2B3');
  assert.equal(acct.returns.eligible, false);
  assert.match(acct.returns.blocked, /15-day return window/);
  assert.equal(acct.returns.items[0].locked, 'closed');
});

test('F088: an unpaid checkout closed by the sweep is not listed; a paid order that could not go ahead is, with its refund', async () => {
  db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail)
    VALUES ('TRV-ABANDON1',?,'layla@test.local',27000,0,0,27000,'cancelled','consignment')`).run(buyerId);
  db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,attention,refunded_at)
    VALUES ('TRV-SOLDOUT1',?,'layla@test.local',6400,3000,0,9400,'cancelled','consignment','oversold',datetime('now'))`).run(buyerId);
  const { data } = await ctx.api('GET', '/api/account/orders', { cookie: buyerCookie });
  assert.ok(!data.orders.some((o) => o.id === 'TRV-ABANDON1'), 'never an order, never charged');
  const sold = data.orders.find((o) => o.id === 'TRV-SOLDOUT1');
  assert.ok(sold);
  assert.equal(sold.couldNotGoAhead, true);
});

test('F090: the buyer sees friendly steps — no OTO booking ref as tracking, no raw courier or staff notes, no refund note', async () => {
  const o = await paidOrder('TRV-F2C1', 'pi_f2_c1', [mug]);
  const sh = o.sh(shopA);
  db.prepare("UPDATE shipments SET carrier='OTO', delivery_ref='TRV-F2C1-99', tracking_number='TRV-F2C1-99' WHERE id=?").run(sh.id);
  const ev = db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)');
  ev.run(sh.id, 'processing', 'Courier booking failed (OTO1006 wallet empty) — Trove has been alerted');
  ev.run(sh.id, 'shipped', 'Ready for collection · OTO TRV-F2C1-99');
  let acct = await acctOrder('TRV-F2C1');
  const s = acct.shipments[0];
  assert.equal(s.carrier, '', 'the gateway is not a carrier the buyer can use');
  assert.equal(s.trackingNumber, '', 'the internal booking reference is not a tracking number');
  assert.equal(s.deliveryRef, undefined);
  const notes = s.timeline.map((e) => e.note);
  assert.ok(notes.every((n) => Object.values(require('../src/shipments').BUYER_NOTES).some((b) => n.startsWith(b))), notes.join(' | '));
  assert.ok(!notes.some((n) => /OTO|failed|alerted|TRV-F2C1-99/.test(n)));
  assert.equal(notes[notes.length - 1], 'Packed — waiting for the courier to collect it');

  // The real courier's number (from the webhook) is shown once it exists.
  db.prepare("UPDATE shipments SET carrier='Aramex', tracking_number='AWB123' WHERE id=?").run(sh.id);
  acct = await acctOrder('TRV-F2C1');
  assert.equal(acct.shipments[0].carrier, 'Aramex');
  assert.equal(acct.shipments[0].trackingNumber, 'AWB123');

  // A return's private admin note and raw courier errors stay with Trove.
  deliver(sh.id);
  const line = (await acctOrder('TRV-F2C1')).returns.items[0];
  const r = await ctx.api('POST', '/api/account/orders/TRV-F2C1/return-request', { cookie: buyerCookie, body: returnBody([line.id]) });
  db.prepare("UPDATE return_requests SET refund_note='Goodwill — buyer was rude on the phone' WHERE id=?").run(r.data.id);
  db.prepare("INSERT INTO return_collections (request_id, shipment_id, shop_id, status, note) VALUES (?,?,?,'failed','OTO1006: credit not enough')").run(r.data.id, sh.id, shopA);
  acct = await acctOrder('TRV-F2C1');
  const rq = acct.returns.requests[0];
  assert.equal(rq.refundNote, undefined);
  assert.ok(rq.collections.length && rq.collections.every((c) => c.note === undefined));
  assert.doesNotMatch(JSON.stringify(acct), /rude|credit not enough/);
});

test('F094: each order carries its delivery address and money breakdown', async () => {
  const acct = await acctOrder('TRV-F2A1');
  assert.deepEqual(acct.details.shipTo, { name: 'Layla Haddad', line: '1 Marina Walk', line2: 'Apt 1203', city: 'Dubai Marina, Dubai' });
  assert.equal(acct.details.subtotal, 259);
  assert.equal(acct.details.delivery, 0);
  assert.equal(acct.details.total, 259);
  assert.equal(acct.details.paidByCard, true);
});

test('F067: a whole-order refund emails the buyer; the maker whose parcel was delivered hears it is coming back, the other not to send', async () => {
  const o = await paidOrder('TRV-F2D1', 'pi_f2_d1', [mug, wallet]);
  deliver(o.sh(shopA).id);
  // Kiln & Clay was already paid for it: the email says it nets off.
  const sid = db.prepare("INSERT INTO settlements (run_date, status) VALUES (date('now'), 'paid')").run().lastInsertRowid;
  db.prepare("UPDATE seller_balances SET settlement_id=? WHERE order_id=? AND shop_id=? AND type='credit_sale'").run(sid, o.oid, shopA);
  sent = [];
  const r = await ctx.api('POST', '/api/admin/orders/TRV-F2D1/refund', { cookie: adminCookie, body: {} });
  assert.equal(r.status, 200);
  await sleep(60);
  const buyer = mailsTo('layla@test.local').find((m) => /Your order TRV-F2D1 is refunded/.test(m.subject));
  assert.ok(buyer, 'the buyer is told');
  assert.match(buyer.html, /collect the pieces you already have/, 'a collection is coming for the delivered parcel');
  const kiln = mailsTo('kiln@test.local').find((m) => /A return is on its way back to you/.test(m.subject));
  assert.ok(kiln);
  assert.match(kiln.html, /deducted from your next fortnightly payment/);
  assert.ok(mailsTo('ember@test.local').some((m) => /please do not send it/.test(m.subject)), 'the unsent parcel is stopped');
});

test('F173: a settlement marked paid emails each maker the amount and the bank reference', async () => {
  const sid = db.prepare("INSERT INTO settlements (run_date, status, total_cents) VALUES (date('now'), 'exported', 3840)").run().lastInsertRowid;
  db.prepare("INSERT INTO settlement_items (settlement_id, shop_id, amount_cents, credit_cents, item_count, bank_reference) VALUES (?,?,3840,3840,1,'Purchase of handmade goods — PO #77')").run(sid, shopA);
  sent = [];
  require('../src/settlement').markPaid(sid);
  await sleep(30);
  const m = mailsTo('kiln@test.local').find((x) => /Your Trove payment is on its way/.test(x.subject));
  assert.ok(m);
  assert.match(m.html, /AED 38\.40/);
  assert.match(m.html, /PO #77/);
});

test('F196: an automatic sold-out refund tells the owner; a failed one asks them to act', async () => {
  const pe = require('../src/paid-effects');
  const oid = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id,shipping_json,attention)
    VALUES ('TRV-F2E1',?,'layla@test.local',6400,3000,0,9400,'cancelled','consignment','pi_f2_e1',?, 'oversold')`).run(buyerId, JSON.stringify({ name: 'Layla Haddad' })).lastInsertRowid;
  sent = [];
  await pe.unavailablePostEffects(db.prepare('SELECT * FROM orders WHERE id=?').get(oid), [], require('../src/stripe').getStripe());
  await sleep(20);
  const ok = mailsTo(OWNER).find((m) => /TRV-F2E1 could not go ahead — refunded automatically/.test(m.subject));
  assert.ok(ok);
  assert.doesNotMatch(ok.html, /Haddad|layla@test\.local/);
  sent = [];
  const failing = { refunds: { create: () => Promise.reject(new Error('card declined')) } };
  await pe.unavailablePostEffects({ ...db.prepare('SELECT * FROM orders WHERE id=?').get(oid), id: oid }, [], failing);
  await sleep(20);
  assert.ok(mailsTo(OWNER).some((m) => /^ACTION: order TRV-F2E1/.test(m.subject)));
});

test('F091: sign-up and provider enrolment refuse an address that is not an email', async () => {
  for (const email of ['not-an-email', 'layla@gmailcom', 'a b@c.com']) {
    const r = await ctx.api('POST', '/api/auth/register', { body: { email, password: 'longenough1', name: 'Typo Person' } });
    assert.equal(r.status, 400, email);
    assert.match(r.data.error, /doesn't look right/);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email IN ('not-an-email','layla@gmailcom')").get().c, 0);
  const ok = await ctx.api('POST', '/api/auth/register', { body: { email: 'new.person@example.ae', password: 'longenough1', name: 'New Person' } });
  assert.equal(ok.status, 201);
  const sv = await ctx.api('POST', '/api/services/apply', { body: { email: 'nobody@nowhere', name: 'Typo Provider' } });
  assert.equal(sv.status, 400);
  assert.match(sv.data.error, /doesn't look right/);
});
