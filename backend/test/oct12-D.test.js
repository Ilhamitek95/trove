'use strict';
/**
 * Money fix round, 12 Oct 2026 (group D): checkout, payment effects,
 * returns, settlement and the courier webhooks. One block per finding (or a
 * few that share a flow), each pinning the new behaviour — and, where
 * practical, a mutation-style check that the OLD behaviour would fail.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ VAT_REGISTERED: '1', PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const BACKEND = path.join(__dirname, '..');
const ADDR = { name: 'Layla Haddad', line: 'Villa 4, Street 12', city: 'Jumeirah, Dubai', emirate: 'Dubai' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(15); }
  return false;
}

let ctx, db, stripe, fees, cfg;
let adminCookie, buyerCookie, otherCookie, makerACookie, buyerId;
let shopA, shopB, shopC, shopD;
const sent = []; // every email the app tried to send
let n = 0;
const uniq = (p) => `${p}${++n}`;

/* ---------------- fixtures ---------------- */
function mkProduct(shopId, { price = 10000, stock = 5, status = 'live', name } = {}) {
  return db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,?)")
    .run(shopId, name || uniq('Piece '), 'Ceramics', price, stock, status).lastInsertRowid;
}
/** A pending order as /api/checkout leaves it (with address + mobile unless told otherwise). */
function pendingOrder({ lines, ship = ADDR, phone = '+971501112233' }) {
  const pid = uniq('TRV-DP');
  const pi = `pi_${pid}`;
  const subtotal = lines.reduce((t, l) => t + l.price * (l.qty || 1), 0);
  const delivery = subtotal > 20000 ? 0 : 3000;
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,shipping_json,subtotal_cents,shipping_cents,service_fee_cents,total_cents,currency,status,rail,stripe_payment_intent_id)
    VALUES (?,?,?,?,?,?,?,0,?,'aed','pending','consignment',?)`)
    .run(pid, buyerId, 'buyer@test.local', phone, ship ? JSON.stringify(ship) : null, subtotal, delivery, subtotal + delivery, pi).lastInsertRowid;
  const itemIds = lines.map((l) => db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,options) VALUES (?,?,?,?,?,?,?)')
    .run(id, l.productId, l.shopId, l.name || 'Piece', l.price, l.qty || 1, l.options || '[]').lastInsertRowid);
  return { id, pid, pi, itemIds, total: subtotal + delivery };
}
const pay = (o, extra = {}) => ctx.postWebhook({ id: `evt_${o.pid}_${++n}`, type: 'payment_intent.succeeded', data: { object: { id: o.pi, metadata: { order_id: String(o.id) }, ...extra } } });

/** A delivered, paid order inside its return window (returns can be asked for). */
function deliveredOrder({ lines, shippingCents = null, shop = shopA, provider = null }) {
  const pid = uniq('TRV-DR');
  const subtotal = lines.reduce((t, l) => t + l.cents * (l.qty || 1), 0);
  const delivery = shippingCents != null ? shippingCents : (subtotal > 20000 ? 0 : 3000);
  const total = subtotal + delivery;
  const vat = cfg.vatFromGross(total);
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,shipping_json,subtotal_cents,service_fee_cents,shipping_cents,total_cents,status,rail,stripe_payment_intent_id,vat_amount_cents,title_transferred_at)
    VALUES (?,?, 'buyer@test.local', '+971501112233', ?, ?, 0, ?, ?, 'fulfilled', 'consignment', ?, ?, datetime('now'))`)
    .run(pid, buyerId, JSON.stringify(ADDR), subtotal, delivery, total, `pi_${pid}`, vat).lastInsertRowid;
  const itemIds = lines.map((l) => db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?)')
    .run(id, shop, l.name, l.cents, l.qty || 1).lastInsertRowid);
  const shipmentId = db.prepare("INSERT INTO shipments (order_id,shop_id,status,delivered_at) VALUES (?,?, 'delivered', datetime('now','-2 days'))").run(id, shop).lastInsertRowid;
  if (provider) db.prepare('UPDATE shipments SET delivery_provider=?, delivery_ref=? WHERE id=?').run(provider, `${pid}-${shipmentId}`, shipmentId);
  db.prepare("UPDATE orders SET delivered_at=datetime('now','-2 days') WHERE id=?").run(id);
  db.prepare("INSERT INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?, 'credit_sale', ?)").run(shop, id, fees.split(subtotal).net);
  return { id, pid, itemIds, total, vat, shipmentId };
}
/** A paid order whose one parcel OTO booked (status processing). */
function otoShipment() {
  const pid = uniq('TRV-DO');
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,shipping_json,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id,title_transferred_at)
    VALUES (?,?, 'buyer@test.local', '+971501112233', ?, 10000, 3000, 0, 13000, 'paid', 'consignment', ?, datetime('now'))`).run(pid, buyerId, JSON.stringify(ADDR), `pi_${pid}`).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,1)').run(id, shopB, 'Vase', 10000);
  const sid = db.prepare("INSERT INTO shipments (order_id,shop_id,status,delivery_provider) VALUES (?,?, 'processing', 'oto')").run(id, shopB).lastInsertRowid;
  db.prepare('UPDATE shipments SET delivery_ref=? WHERE id=?').run(`${pid}-${sid}`, sid);
  return db.prepare('SELECT * FROM shipments WHERE id=?').get(sid);
}

const row = (orderId) => db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
const stockOf = (pid) => db.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock;
const cancelledQty = (itemId) => db.prepare('SELECT cancelled_qty FROM order_items WHERE id=?').get(itemId).cancelled_qty;
const credit = (orderId, shopId) => db.prepare("SELECT amount_cents FROM seller_balances WHERE order_id=? AND shop_id=? AND type='credit_sale'").get(orderId, shopId).amount_cents;
const reqRow = (id) => db.prepare('SELECT * FROM return_requests WHERE id=?').get(id);
const refundsMade = () => stripe.calls.filter((c) => c.method === 'refunds.create');
/** The buyer asks to return (by default every unit of the order, as faulty). */
const ask = (o, body = {}, cookie = null) => ctx.api('POST', `/api/account/orders/${o.pid}/return-request`, {
  cookie: cookie || buyerCookie, body: { details: 'It arrived cracked, sorry.', images: [PNG], reason: 'damaged', itemIds: o.itemIds, ...body },
});
const approveReq = (id, body = {}) => ctx.api('POST', `/api/admin/returns/${id}/approve`, { cookie: adminCookie, body });
/** Environment for a child process that starts clean (no test-suite Stripe/env leaking in). */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['NODE_ENV', 'STRIPE_MOCK', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PAYMENTS_REQUIRED', 'SETTLEMENT_ANCHOR_DATE', 'SETTLEMENT_INTERVAL_DAYS']) delete env[k];
  return { ...env, ...extra };
}
function runChild(code, extra = {}) {
  try { return { ok: true, out: execFileSync(process.execPath, ['-e', code], { cwd: BACKEND, env: childEnv(extra), stdio: 'pipe' }).toString() }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.message) }; }
}

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  stripe = ctx.stripeMock;
  fees = require('../src/fees');
  cfg = require('../src/config');
  // Catch every email (the real sender would skip without RESEND_API_KEY anyway).
  require('../src/email').send = async (m) => { sent.push(m); return { id: 'test-email' }; };
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  const user = (email, name, role) => db.prepare('INSERT INTO users (email,password_hash,name,role,email_verified_at) VALUES (?,?,?,?,datetime(\'now\'))').run(email, pw, name, role).lastInsertRowid;
  user('admin@test.local', 'Owner', 'admin');
  buyerId = user('buyer@test.local', 'Layla Haddad', 'buyer');
  user('other@test.local', 'Someone Else', 'buyer');
  const makerA = user('makera@test.local', 'Mara Maker', 'seller');
  const makerB = user('makerb@test.local', 'Basil Maker', 'seller');
  const makerC = user('makerc@test.local', 'Cara Maker', 'seller');
  const makerD = user('makerd@test.local', 'Dina Maker', 'seller');
  const shop = (uid, name, slug, extra = '') => db.prepare(`INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved', 'consignment')`).run(uid, name, slug).lastInsertRowid;
  shopA = shop(makerA, 'Kiln Works', 'kiln-works');
  shopB = shop(makerB, 'Loom House', 'loom-house');
  shopC = shop(makerC, 'Paper Room', 'paper-room');
  // A maker who graduated to the Connect rail, fully set up for payouts —
  // with markup in the names that end up in the purchase note (F450).
  shopD = shop(makerD, 'Sable & <b>Stone</b>', 'sable-stone');
  db.prepare(`UPDATE shops SET tier='connect', iban_encrypted=?, iban_masked='AE07 •••• 0123', payout_account_name='Dina Maker', payout_bank_name='Emirates NBD',
      agreement_accepted_at=datetime('now'), agreement_version='v5', license_verified_at=datetime('now') WHERE id=?`)
    .run(require('../src/crypto').encrypt('AE070331234567890123456'), shopD);
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('buyer@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
  makerACookie = await ctx.loginAs('makera@test.local', 'testpass123');
});
after(async () => { await ctx.close(); });

/* ---------------- F211: fail closed in production ---------------- */
test('F211: production refuses to boot or take orders without Stripe, ignores STRIPE_MOCK, and has no demo completion', async () => {
  const guard = "require('./src/stripe').assertPaymentsConfigured()";
  const refused = runChild(guard, { NODE_ENV: 'production' });
  assert.equal(refused.ok, false);
  assert.match(refused.out, /Refusing to start: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set in production/);
  assert.equal(runChild(guard, { NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }).ok, true);
  assert.equal(runChild(guard, { NODE_ENV: 'development' }).ok, true, 'local dev still boots without Stripe');
  assert.match(runChild(guard, { PAYMENTS_REQUIRED: '1', STRIPE_SECRET_KEY: 'sk_test_x' }).out, /STRIPE_WEBHOOK_SECRET/);
  // The in-process mock (whose webhooks skip the signature check) is never used in production.
  assert.equal(runChild("if (require('./src/stripe').getStripe() !== null) process.exit(3)", { NODE_ENV: 'production', STRIPE_MOCK: '1' }).ok, true);
  // server.js runs the guard before it opens the database or the app.
  const srv = fs.readFileSync(path.join(BACKEND, 'src', 'server.js'), 'utf8');
  assert.ok(srv.indexOf('assertPaymentsConfigured()') > 0 && srv.indexOf('assertPaymentsConfigured()') < srv.indexOf("require('./db')"));

  const pid = mkProduct(shopB, { price: 12000 });
  const orders = () => db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
  const before = orders();
  const prev = { env: process.env.NODE_ENV, host: process.env.CANONICAL_HOST };
  process.env.NODE_ENV = 'production';
  process.env.CANONICAL_HOST = 'off';
  try {
    const co = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: pid, qty: 1 }], email: 'b@test.local', phone: '0501112233', address: ADDR } });
    assert.equal(co.status, 503);
    assert.equal(orders(), before, 'no order row at all');
    assert.equal((await ctx.api('POST', '/api/checkout/demo-complete', { body: { orderId: 'TRV-ANY' } })).status, 404);
    assert.equal((await ctx.api('GET', '/api/health')).data.ok, false);
  } finally {
    process.env.NODE_ENV = prev.env;
    if (prev.host === undefined) delete process.env.CANONICAL_HOST; else process.env.CANONICAL_HOST = prev.host;
  }
  // Mutation-style: the same checkout outside production goes through.
  assert.equal((await ctx.api('GET', '/api/health')).data.ok, true);
  const ok = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: pid, qty: 1 }], email: 'b@test.local', phone: '0501112233', address: ADDR } });
  assert.equal(ok.status, 200, ok.text);
});

/* ---------------- F212: one sold-out piece no longer sinks the basket ---------------- */
test('F212: a piece that sold out is cancelled and refunded on its own; the rest of the basket goes ahead', async () => {
  const gone = mkProduct(shopA, { price: 9000, stock: 0, name: 'One-off vase' });
  const there = mkProduct(shopB, { price: 28500, stock: 3, name: 'Weekender' });
  const o = pendingOrder({ lines: [
    { productId: gone, shopId: shopA, price: 9000, name: 'One-off vase' },
    { productId: there, shopId: shopB, price: 28500, name: 'Weekender' },
  ] });
  stripe.reset();
  sent.length = 0;
  await pay(o);
  const shB = () => db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(o.id, shopB);
  assert.ok(await waitFor(() => (shB() || {}).delivery_ref && sent.some((m) => /is confirmed/.test(m.subject))), 'the rest is booked and confirmed');

  const ord = row(o.id);
  assert.equal(ord.status, 'paid');
  assert.equal(ord.refunded_at, null);
  assert.equal(ord.attention, '');
  assert.equal(stockOf(there), 2);
  assert.equal(cancelledQty(o.itemIds[0]), 1);
  assert.equal(cancelledQty(o.itemIds[1]), 0);
  const refunds = refundsMade();
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].params.amount, 9000, 'just the sold-out piece — the delivery stays, the rest is still delivered');
  assert.match(refunds[0].opts.idempotencyKey, /^trove-cancel-\d+$/);
  const c = db.prepare('SELECT * FROM order_cancellations WHERE order_id=?').get(o.id);
  assert.equal(c.reason, 'sold_out');
  assert.equal(c.status, 'refunded');
  // The books: maker A's credit gone, maker B's whole; the refunded piece's VAT reversed with a credit note.
  assert.equal(credit(o.id, shopA), 0);
  assert.equal(credit(o.id, shopB), fees.split(28500).net);
  assert.equal(ord.vat_amount_cents, cfg.vatFromGross(o.total));
  assert.equal(ord.vat_reversed_cents, cfg.vatFromGross(9000));
  assert.equal(c.credit_note_ref, `CN-${o.pid}-C${c.id}`);
  // The emptied parcel is cancelled and never booked.
  const shA = db.prepare('SELECT * FROM shipments WHERE order_id=? AND shop_id=?').get(o.id, shopA);
  assert.equal(shA.status, 'cancelled');
  assert.ok(!shA.delivery_ref);
  // The buyer is told what sold out; the receipt lists only what is coming.
  const cancelMail = sent.find((m) => m.to === 'buyer@test.local' && /Part of your order .* is cancelled/.test(m.subject));
  assert.ok(cancelMail);
  assert.match(cancelMail.html, /sold out moments before your payment went through/);
  const receipt = sent.find((m) => m.to === 'buyer@test.local' && /is confirmed/.test(m.subject));
  assert.doesNotMatch(receipt.html, /One-off vase/);
  assert.match(receipt.html, /Weekender/);
  assert.match(receipt.html, /Refunded/);
  // Maker A is never asked to pack a piece they no longer have; maker B is.
  assert.ok(!sent.some((m) => m.to === 'makera@test.local'), 'nothing to maker A');
  assert.ok(sent.some((m) => m.to === 'makerb@test.local' && /to pack/i.test(m.subject)));
  assert.ok(sent.some((m) => m.to === 'admin@test.local' && /sold out at payment — refunded automatically/.test(m.subject)), 'the owner hears');
  // Mutation-style: the old code cancelled and refunded the whole order.
  assert.notEqual(ord.status, 'cancelled');
});

/* ---------------- F216 + F442 ---------------- */
test('F216 + F442: a piece unlisted, a paused shop, or a piece that gained variations since checkout is not sold', async () => {
  const unlisted = mkProduct(shopA, { price: 5000, stock: 5 });
  const regrid = mkProduct(shopA, { price: 6000, stock: 5 });
  const fine = mkProduct(shopA, { price: 7000, stock: 5 });
  const o = pendingOrder({ lines: [
    { productId: unlisted, shopId: shopA, price: 5000 },
    { productId: regrid, shopId: shopA, price: 6000 },
    { productId: fine, shopId: shopA, price: 7000 },
  ] });
  // While the buyer is paying: one piece is taken off sale, another gains a Size option.
  db.prepare("UPDATE products SET status='draft' WHERE id=?").run(unlisted);
  db.prepare('UPDATE products SET options=?, variants=? WHERE id=?').run(
    JSON.stringify([{ name: 'Size', values: ['S', 'L'] }]),
    JSON.stringify([{ key: 'Size:S', options: [{ name: 'Size', value: 'S' }], stock: 2, priceCents: null }, { key: 'Size:L', options: [{ name: 'Size', value: 'L' }], stock: 3, priceCents: null }]),
    regrid);
  stripe.reset();
  await pay(o);
  assert.ok(await waitFor(() => db.prepare("SELECT COUNT(*) AS c FROM order_cancellations WHERE order_id=? AND status='refunded'").get(o.id).c === 1));
  assert.equal(row(o.id).status, 'paid');
  assert.deepEqual(o.itemIds.map(cancelledQty), [1, 1, 0]);
  assert.equal(stockOf(unlisted), 5, 'nothing taken from a piece that is off sale');
  assert.equal(stockOf(regrid), 5, 'no total-only decrement for the next save to undo');
  assert.deepEqual(JSON.parse(db.prepare('SELECT variants FROM products WHERE id=?').get(regrid).variants).map((v) => v.stock), [2, 3]);
  assert.equal(stockOf(fine), 4);
  assert.equal(refundsMade()[0].params.amount, 11000);

  // A shop suspended meanwhile: nothing on the (one-shop) order can be sold → refunded in full.
  const p = mkProduct(shopC, { price: 4000, stock: 2 });
  const o2 = pendingOrder({ lines: [{ productId: p, shopId: shopC, price: 4000 }] });
  db.prepare("UPDATE shops SET status='suspended' WHERE id=?").run(shopC);
  try {
    await pay(o2);
    assert.ok(await waitFor(() => row(o2.id).refunded_at));
  } finally { db.prepare("UPDATE shops SET status='approved' WHERE id=?").run(shopC); }
  assert.equal(row(o2.id).status, 'cancelled');
  assert.equal(row(o2.id).attention, 'oversold');
  assert.equal(stockOf(p), 2);
});

/* ---------------- F213 ---------------- */
test('F213: an order paid without a delivery address or mobile is held from the courier and flagged, then booked once fixed', async () => {
  const p = mkProduct(shopB, { price: 15000 });
  const o = pendingOrder({ lines: [{ productId: p, shopId: shopB, price: 15000 }], ship: null, phone: '' });
  sent.length = 0;
  await pay(o);
  const sh = () => db.prepare('SELECT * FROM shipments WHERE order_id=?').get(o.id);
  assert.ok(await waitFor(() => sh() && sh().attention === 'missing_address'));
  assert.equal(row(o.id).status, 'paid', 'the payment stands');
  assert.ok(!sh().delivery_ref, 'no courier order that nobody can deliver');
  assert.match(sh().booking_error, /no delivery address or mobile/);
  assert.ok(sent.some((m) => m.to === 'admin@test.local' && /No delivery address or mobile/.test(m.subject)), 'the owner is emailed');
  // The owner adds the details; the next hourly retry books the courier and clears the flag.
  const fix = await ctx.api('PATCH', `/api/admin/orders/${o.pid}/delivery`, { cookie: adminCookie, body: { address: ADDR, phone: '050 111 2233' } });
  assert.equal(fix.status, 200, fix.text);
  await require('../src/courier-ops').retryBookings();
  assert.match(sh().delivery_ref, /^QMOCK-/);
  assert.equal(sh().attention, '');
  assert.equal(sh().booking_error, null);
});

/* ---------------- F214 + F215 + F422 + F444 ---------------- */
test('F214 + F215 + F422 + F444: checkout input is checked on the server; pieces are named; Stripe calls are pinned', async () => {
  const p = mkProduct(shopB, { price: 12000, stock: 5, name: 'Botanical Room Mist' });
  const co = (body) => ctx.api('POST', '/api/checkout', { body: { items: [{ productId: p, qty: 1 }], phone: '0501112233', address: ADDR, ...body } });
  let r = await co({ email: 'not-an-email' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /doesn't look right/);
  r = await co({ email: { a: 1 } });
  assert.equal(r.status, 400, 'odd input is a clear 400, never a 500');
  r = await co({ email: 'b@test.local', address: { ...ADDR, name: 'x'.repeat(2000000) } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /too long/);
  r = await co({ email: 'b@test.local', address: 'Villa 4' });
  assert.equal(r.status, 400);
  r = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: { $gt: 1 }, qty: 1 }], email: 'b@test.local' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'unavailable');

  // A good checkout: only the known address fields are kept (never a phone), one PaymentIntent per order.
  stripe.reset();
  r = await co({ email: ' layla@test.local ', address: { ...ADDR, phone: '+971500000000', label: 'Home', notes: 'Ring twice' } });
  assert.equal(r.status, 200, r.text);
  const ord = db.prepare('SELECT * FROM orders WHERE public_id=?').get(r.data.orderId);
  assert.equal(ord.email, 'layla@test.local');
  assert.deepEqual(Object.keys(JSON.parse(ord.shipping_json)).sort(), ['city', 'emirate', 'line', 'name', 'notes']);
  const create = stripe.calls.find((c) => c.method === 'paymentIntents.create');
  assert.equal(create.opts.idempotencyKey, `trove-order-pi-${ord.id}`);

  // /update checks the email too, and a corrected one reaches Stripe's receipt.
  const secret = r.data.clientSecret;
  let u = await ctx.api('POST', '/api/checkout/update', { body: { orderId: r.data.orderId, clientSecret: secret, email: 'nope', address: ADDR } });
  assert.equal(u.status, 400);
  u = await ctx.api('POST', '/api/checkout/update', { body: { orderId: r.data.orderId, clientSecret: secret, email: 'layla.h@test.local', address: { ...ADDR, notes: 'n'.repeat(301) } } });
  assert.equal(u.status, 400, 'the same limits on /update');
  u = await ctx.api('POST', '/api/checkout/update', { body: { orderId: r.data.orderId, clientSecret: secret, email: 'layla.h@test.local', address: ADDR } });
  assert.equal(u.status, 200, u.text);
  const upd = stripe.calls.find((c) => c.method === 'paymentIntents.update');
  assert.equal(upd.params.id, ord.stripe_payment_intent_id);
  assert.equal(upd.params.receipt_email, 'layla.h@test.local');
  assert.equal(db.prepare('SELECT email FROM orders WHERE id=?').get(ord.id).email, 'layla.h@test.local');

  // F422: a piece taken off sale is named, never numbered, and the client can drop that line.
  db.prepare("UPDATE products SET status='draft' WHERE id=?").run(p);
  r = await co({ email: 'b@test.local' });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'unavailable');
  assert.equal(r.data.productId, p);
  assert.match(r.data.error, /“Botanical Room Mist” is no longer available — remove it from your basket/);
  assert.doesNotMatch(r.data.error, /Product \d+/);

  // F444: the Stripe API version is pinned to the one the SDK sends today.
  const v = runChild("process.env.STRIPE_SECRET_KEY='sk_test_x'; console.log(require('./src/stripe').getStripe().getApiField('version'))");
  assert.equal(v.ok, true, v.out);
  assert.equal(v.out.trim(), '2024-06-20');
});

/* ---------------- F440 ---------------- */
test('F440: a payment that does not match its order is never fulfilled', async () => {
  const p = mkProduct(shopB, { price: 28500, stock: 5 });
  const o = pendingOrder({ lines: [{ productId: p, shopId: shopB, price: 28500 }] });
  sent.length = 0;
  await pay(o, { amount_received: 100, currency: 'usd' });
  await sleep(40);
  let ord = row(o.id);
  assert.equal(ord.status, 'cancelled');
  assert.equal(ord.attention, 'amount_mismatch');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shipments WHERE order_id=?').get(o.id).c, 0, 'nothing sent');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM seller_balances WHERE order_id=?').get(o.id).c, 0, 'no maker credited');
  assert.equal(stockOf(p), 5);
  assert.ok(sent.some((m) => m.to === 'admin@test.local' && /does not match the order/.test(m.subject)));
  // Redelivered: nothing changes, nothing is refunded automatically.
  stripe.reset();
  await pay(o, { amount_received: 100, currency: 'usd' });
  await sleep(30);
  assert.equal(row(o.id).status, 'cancelled');
  assert.equal(refundsMade().length, 0);
  // The hourly recovery compares the retrieved intent too.
  const o3 = pendingOrder({ lines: [{ productId: p, shopId: shopB, price: 28500 }] });
  assert.equal(require('../src/order-sweep').recoverPaid(row(o3.id), stripe, { id: o3.pi, status: 'succeeded', amount_received: o3.total, currency: 'usd' }), false);
  assert.equal(row(o3.id).attention, 'amount_mismatch', 'a wrong currency alone is caught');
  // Mutation-style: the right amount and currency complete the order.
  const o2 = pendingOrder({ lines: [{ productId: p, shopId: shopB, price: 28500 }] });
  await pay(o2, { amount_received: o2.total, currency: 'aed' });
  await sleep(30);
  assert.equal(row(o2.id).status, 'paid');
  assert.equal(stockOf(p), 4);
});

/* ---------------- F219 ---------------- */
test('F219: a courier event that names only the parcel never refunds a guessed return', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Mug', cents: 4000, qty: 2 }] });
  const a = await ask(o, { items: [{ id: o.itemIds[0], qty: 1 }] });
  assert.equal(a.status, 201, a.text);
  assert.equal((await approveReq(a.data.id)).status, 200);
  const b = await ask(o, { items: [{ id: o.itemIds[0], qty: 1 }] });
  assert.equal((await approveReq(b.data.id)).status, 200);
  // Neither collection carries a courier id we can match (OTO sent none).
  db.prepare('UPDATE return_collections SET ref=NULL WHERE request_id IN (?,?)').run(a.data.id, b.data.id);
  const returns = require('../src/returns');
  sent.length = 0;
  stripe.reset();
  assert.equal(await returns.markCollected({ shipmentId: o.shipmentId, quiet: true }), null, 'two waiting and the courier did not say which');
  assert.equal(reqRow(a.data.id).status, 'approved');
  assert.equal(reqRow(b.data.id).status, 'approved', 'the old code refunded B, the latest, here');
  assert.equal(refundsMade().length, 0);
  assert.ok(sent.some((m) => m.to === 'admin@test.local' && /Check a return collection/.test(m.subject)));
  // A comes in under its own id; then ONE return waits on the parcel, and an id-less event is that one.
  db.prepare("UPDATE return_collections SET ref='X-R1' WHERE request_id=?").run(a.data.id);
  assert.equal(await returns.markCollected({ ref: 'X-R1', quiet: true }), a.data.id);
  assert.equal(reqRow(a.data.id).status, 'refunded');
  assert.equal(await returns.markCollected({ shipmentId: o.shipmentId, quiet: true }), b.data.id);
  assert.equal(reqRow(b.data.id).status, 'refunded');
  // An event naming a return id we never stored never matches a collection that has its own id.
  const o2 = deliveredOrder({ lines: [{ name: 'Bowl', cents: 5000 }] });
  const c = await ask(o2, {});
  await approveReq(c.data.id);
  db.prepare("UPDATE return_collections SET ref='Y-R1' WHERE request_id=?").run(c.data.id);
  assert.equal(await returns.markCollected({ shipmentId: o2.shipmentId, returnRef: 'Y-R2', quiet: true }), null);
  assert.equal(reqRow(c.data.id).status, 'approved');
});

/* ---------------- F220 ---------------- */
test('F220: when the courier booking fails at approval, nobody is told a collection is booked', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Jug', cents: 7000 }] });
  const r = await ask(o, {});
  require('../src/delivery/quiqup-mock')._failNext.bookReversePickup = 'OTO1006 credit not enough';
  sent.length = 0;
  const res = await approveReq(r.data.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.collectionFailed, true);
  const mail = sent.find((m) => m.to === 'buyer@test.local' && /return is approved/.test(m.subject));
  assert.match(mail.subject, /arranging the collection/);
  assert.doesNotMatch(mail.html, /collection is booked/);
  // Mutation-style: a booking that goes through still says it is booked.
  const o2 = deliveredOrder({ lines: [{ name: 'Jug', cents: 7000 }] });
  const r2 = await ask(o2, {});
  sent.length = 0;
  const ok = await approveReq(r2.data.id);
  assert.equal(ok.data.collectionFailed, false);
  assert.match(sent.find((m) => m.to === 'buyer@test.local' && /return is approved/.test(m.subject)).subject, /collection booked/);
  // The admin's toast follows the flag.
  const admin = fs.readFileSync(path.join(BACKEND, '..', 'docs', 'trove-admin.html'), 'utf8');
  assert.match(admin, /res&&res\.collectionFailed\?'Approved, but the courier booking failed/);
});

/* ---------------- F221 ---------------- */
test('F221: a fault return charged the collection fee counts as a change of mind for the delivery refund', async () => {
  const run = async (chargeA) => {
    const o = deliveredOrder({ lines: [{ name: 'Bowl', cents: 6000 }, { name: 'Plate', cents: 4000 }] }); // AED 100 + AED 30 delivery
    const a = await ask(o, { itemIds: [o.itemIds[0]] });
    assert.equal((await approveReq(a.data.id, chargeA ? { chargeFee: true } : {})).status, 200);
    const b = await ask(o, { itemIds: [o.itemIds[1]] });
    return (await approveReq(b.data.id)).data.request;
  };
  const charged = await run(true);
  assert.equal(charged.deliveryRefund, 0, 'B completes the order, but A was treated as a change of mind');
  const free = await run(false);
  assert.equal(free.deliveryRefund, 30, 'mutation-style: without the fee on A, B carries the delivery refund');
});

/* ---------------- F222 ---------------- */
test('F222: Refund now with the buyer keeping the piece leaves the maker paid', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Throw', cents: 25000 }] }); // over AED 200: free delivery
  const r = await ask(o, { reason: 'not-as-described' });
  await approveReq(r.data.id);
  const before = credit(o.id, shopA);
  stripe.reset();
  sent.length = 0;
  const res = await ctx.api('POST', `/api/admin/returns/${r.data.id}/refund-now`, { cookie: adminCookie, body: { note: 'goodwill — colour', buyerKeeps: true } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.request.status, 'refunded');
  assert.equal(res.data.request.makerKeptCredit, true);
  assert.equal(res.data.collectionsToCancel, 1, 'the admin is told to cancel the booked collection');
  assert.equal(credit(o.id, shopA), before, "the maker's payment is untouched");
  assert.equal(refundsMade()[0].params.amount, 25000);
  assert.equal(db.prepare('SELECT status FROM return_collections WHERE request_id=?').get(r.data.id).status, 'not_needed');
  // The piece never came back: the order is not 'fully returned', so the credit still settles after the window.
  assert.equal(row(o.id).refunded_at, null);
  db.prepare("UPDATE shipments SET return_window_ends_at=datetime('now','-1 day') WHERE order_id=?").run(o.id);
  db.prepare("UPDATE orders SET return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(o.id);
  const settlement = require('../src/settlement');
  const eligible = db.prepare(settlement.ELIGIBLE_CREDITS + ' AND b.order_id = @o').all({ at: db.prepare("SELECT datetime('now') AS t").get().t, o: o.id });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].amount_cents, before);
  // The purchase note lists it as purchased, not returned.
  assert.deepEqual(settlement.noteLines(o.pid, shopA).returned, []);
  assert.equal(settlement.noteLines(o.pid, shopA).kept[0].qty, 1);
  // The buyer is told to keep it; the maker flag never reaches the buyer's API.
  assert.match(sent.find((m) => m.to === 'buyer@test.local' && /refund is on its way/i.test(m.subject)).html, /please keep the piece/);
  assert.equal('makerKeptCredit' in require('../src/returns').shapeForBuyer(reqRow(r.data.id)), false);
  // Mutation-style: the usual Refund now (the piece is coming back) still takes the credit back.
  const o2 = deliveredOrder({ lines: [{ name: 'Throw', cents: 25000 }] });
  const r2 = await ask(o2, { reason: 'not-as-described' });
  await approveReq(r2.data.id);
  const res2 = await ctx.api('POST', `/api/admin/returns/${r2.data.id}/refund-now`, { cookie: adminCookie, body: { note: '' } });
  assert.equal(res2.data.request.makerKeptCredit, false);
  assert.equal(credit(o2.id, shopA), 0);
  assert.ok(row(o2.id).refunded_at, 'that order IS fully returned');
});

/* ---------------- F223 (already fixed) ---------------- */
test('F223 (already fixed): the buyer API never carries the internal refund note or courier messages', () => {
  const returns = require('../src/returns');
  const o = deliveredOrder({ lines: [{ name: 'Cup', cents: 3500 }] });
  const id = db.prepare("INSERT INTO return_requests (order_id,buyer_id,reason,details,images,status,refund_note) VALUES (?,?, 'damaged','Chipped rim','[]','refunded','buyer threatened a chargeback')").run(o.id, buyerId).lastInsertRowid;
  db.prepare("INSERT INTO return_collections (request_id,shipment_id,shop_id,status,note) VALUES (?,?,?, 'failed', 'OTO1006 credit not enough')").run(id, o.shipmentId, shopA);
  const mine = returns.shapeForBuyer(reqRow(id));
  assert.equal(mine.refundNote, undefined);
  assert.equal(mine.collections[0].note, undefined);
  assert.equal(returns.shape(reqRow(id)).refundNote, 'buyer threatened a chargeback', 'the admin still sees it');
});

/* ---------------- F225 ---------------- */
test('F225: a refund that reached Stripe but not the books is found again, never paid twice', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Lamp', cents: 9000 }] });
  const r = await ask(o, {});
  await approveReq(r.data.id);
  stripe.reset();
  const returns = require('../src/returns');
  // The local save fails right after Stripe said yes (a locked or read-only database).
  db.exec("CREATE TEMP TRIGGER fail_refund_save BEFORE UPDATE OF status ON return_requests WHEN NEW.status = 'refunded' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
  try {
    await assert.rejects(returns.refund(r.data.id, { by: 'admin' }), /disk I\/O error/);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_refund_save'); }
  assert.equal(reqRow(r.data.id).status, 'approved');
  assert.equal(refundsMade().length, 1);
  // Days later (the idempotency key has long expired): the retry finds that refund.
  const fresh = await returns.refund(r.data.id, { by: 'admin' });
  assert.equal(fresh.status, 'refunded');
  assert.equal(refundsMade().length, 1, 'no second card refund (the old code made one)');
  assert.match(fresh.refund_ref, /^re_mock_/);
  assert.ok(stripe.calls.some((c) => c.method === 'refunds.list' && c.params.payment_intent === `pi_${o.pid}`));
});

/* ---------------- F227 ---------------- */
test('F227: return photos are private, all checked before any is written, and served only to the right people', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Jug', cents: 7000 }] });
  const dir = path.join(process.env.PRIVATE_DIR, 'returns');
  const count = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  const publicDir = path.join(process.env.UPLOADS_DIR, 'returns');
  const publicCount = () => (fs.existsSync(publicDir) ? fs.readdirSync(publicDir).length : 0);
  const start = count();
  const startPublic = publicCount();
  let r = await ask(o, { images: [PNG, 'data:image/png;base64,AAAA'] });
  assert.equal(r.status, 400);
  assert.equal(count(), start, 'a bad second photo: nothing at all is written');
  r = await ask(o, { images: [PNG, PNG] });
  assert.equal(r.status, 201, r.text);
  assert.equal(count(), start + 2);
  assert.equal(publicCount(), startPublic, 'nothing in the public uploads folder');
  assert.ok(JSON.parse(reqRow(r.data.id).images).every((u) => u.startsWith('private:returns/')));
  const url = `/api/return-photos/${r.data.id}/0`;
  assert.equal((await ctx.api('GET', url)).status, 404, 'signed out');
  assert.equal((await ctx.api('GET', url, { cookie: otherCookie })).status, 404, 'another buyer');
  const mine = await ctx.api('GET', url, { cookie: buyerCookie });
  assert.equal(mine.status, 200);
  assert.match(mine.headers.get('content-type'), /image\/png/);
  assert.match(mine.headers.get('cache-control'), /no-store/);
  assert.equal((await ctx.api('GET', url, { cookie: adminCookie })).status, 200);
  assert.equal((await ctx.api('GET', url, { cookie: makerACookie })).status, 200, 'the maker whose piece it is');
  assert.equal((await ctx.api('GET', `/api/return-photos/${r.data.id}/7`, { cookie: adminCookie })).status, 404);
  const list = await ctx.api('GET', '/api/admin/returns', { cookie: adminCookie });
  assert.deepEqual(list.data.returns.find((x) => x.id === r.data.id).images, [url, `/api/return-photos/${r.data.id}/1`]);
  const shop = await ctx.api('GET', '/api/seller/orders', { cookie: makerACookie });
  assert.ok(JSON.stringify(shop.data).includes(url), 'the maker view hands out the private route too');
  // A withdrawn request takes its private photos with it.
  assert.equal((await ctx.api('DELETE', `/api/account/orders/${o.pid}/return-requests/${r.data.id}`, { cookie: buyerCookie })).status, 200);
  assert.equal(count(), start);
});

/* ---------------- F228 (already fixed) ---------------- */
test('F228 (already fixed): a settlement run dated in the future or not a date is refused', () => {
  const s = require('../src/settlement');
  assert.throws(() => s.cutoffFor('2099-01-01'), (e) => e.status === 400);
  assert.throws(() => s.cutoffFor('x'), (e) => e.status === 400);
});

/* ---------------- F230 + F231 + F232 + F450 ---------------- */
test('settlement: a graduated maker is paid what was owed (F230), money in a run shows as being transferred (F231), the bank file is no-store and audited (F232), the purchase note escapes names (F450)', async () => {
  const settlement = require('../src/settlement');
  const o = deliveredOrder({ lines: [{ name: '<img src=x onerror=alert(1)>', cents: 5000 }], shop: shopD });
  db.prepare("UPDATE shipments SET return_window_ends_at=datetime('now','-1 day') WHERE order_id=?").run(o.id);
  db.prepare("UPDATE orders SET return_window_ends_at=datetime('now','-1 day') WHERE id=?").run(o.id);
  const owed = fees.split(5000).net;
  // F230: tier 'connect' today, but the credit was written under consignment.
  const pv = settlement.preview();
  const mine = pv.eligible.find((x) => x.shopId === shopD);
  assert.ok(mine, `eligible, not '${(pv.excluded.find((x) => x.shopId === shopD) || {}).reason}'`);
  assert.equal(mine.creditCents, owed);

  const before = settlement.balances(shopD);
  assert.equal(before.payableCents, owed);
  assert.equal(before.inRunCents, 0);
  const run = await ctx.api('POST', '/api/admin/settlements/run', { cookie: adminCookie, body: {} });
  assert.equal(run.status, 201, run.text);
  // F231: swept into the draft — not payable, not settled, but visibly on its way.
  let b = settlement.balances(shopD);
  assert.equal(b.payableCents, 0);
  assert.equal(b.inRunCents, owed);
  assert.equal(b.inRunDate, run.data.runDate);
  const makerD = await ctx.loginAs('makerd@test.local', 'testpass123');
  const view = await ctx.api('GET', '/api/seller/settlements', { cookie: makerD });
  assert.equal(view.data.inRunCents, owed);
  const sellerPage = fs.readFileSync(path.join(BACKEND, '..', 'docs', 'trove-seller.html'), 'utf8');
  assert.match(sellerPage, /_t\('In this run — being transferred'\)/);

  // F232: the IBAN file is never cached, and every download is on record.
  const csv = await ctx.api('GET', `/api/admin/settlements/${run.data.settlementId}/export.csv`, { cookie: adminCookie });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /AE070331234567890123456/);
  assert.equal(csv.headers.get('cache-control'), 'no-store, private');
  const audit = db.prepare("SELECT * FROM admin_actions WHERE action='Maker bank file downloaded' ORDER BY id DESC").get();
  assert.ok(audit);
  assert.equal(audit.admin_email, 'admin@test.local');
  assert.equal(audit.target_id, String(run.data.settlementId));
  assert.doesNotMatch(String(audit.after_json || '') + String(audit.note || ''), /AE07/);

  const paid = await ctx.api('POST', `/api/admin/settlements/${run.data.settlementId}/paid`, { cookie: adminCookie });
  assert.equal(paid.status, 200, paid.text);
  b = settlement.balances(shopD);
  assert.equal(b.inRunCents, 0);
  assert.equal(b.settledCents, owed);

  // F450: the purchase note escapes every name.
  const note = db.prepare('SELECT pn.html_path FROM purchase_notes pn JOIN settlement_items si ON si.id = pn.settlement_item_id WHERE si.settlement_id=?').get(run.data.settlementId);
  const html = fs.readFileSync(note.html_path, 'utf8');
  assert.match(html, /Sable &amp; &lt;b&gt;Stone&lt;\/b&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>Stone<\/b>/);
});

/* ---------------- F236 ---------------- */
const otoSign = (orderId, status, ts) => crypto.createHmac('sha256', 'oto-secret').update(`${orderId}:${status}:${ts}`).digest('base64');
const otoHook = (body, t = 'status', headers = {}) => ctx.api('POST', `/api/delivery/oto-webhook?t=${t}`, { body, headers });
test('F236: an OTO signature proves only the orderId, its own status and the timestamp', async () => {
  process.env.OTO_WEBHOOK_SECRET = 'oto-secret';
  try {
    const sh = otoShipment();
    const ref = sh.delivery_ref;
    const statusOf = () => db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
    const ts = '1760000000001';
    const signed = otoSign(ref, 'pickedUp', ts);
    // A signature over 'pickedUp' moved into errorCode no longer passes for 'delivered'.
    let r = await otoHook({ orderId: ref, status: 'delivered', errorCode: 'pickedUp', timestamp: ts, signature: signed });
    assert.equal(r.status, 401);
    // An empty status proves nothing.
    r = await otoHook({ orderId: ref, status: 'delivered', timestamp: ts, signature: otoSign(ref, '', ts) });
    assert.equal(r.status, 401);
    assert.equal(statusOf().status, 'processing');
    // The genuine event applies once; the same signature with other fields changed is a duplicate —
    // even posted to the error hook.
    r = await otoHook({ orderId: ref, status: 'pickedUp', timestamp: ts, signature: signed });
    assert.deepEqual(r.data, { received: true, matched: true });
    assert.equal(statusOf().status, 'shipped');
    r = await otoHook({ orderId: ref, status: 'pickedUp', timestamp: ts, signature: signed, dcTrackingNumber: 'FAKE-1', brandedTrackingURL: 'https://evil.example' });
    assert.deepEqual(r.data, { received: true, duplicate: true });
    r = await otoHook({ orderId: ref, status: 'pickedUp', errorCode: '', timestamp: ts, signature: signed }, 'error');
    assert.deepEqual(r.data, { received: true, duplicate: true });
    assert.notEqual(statusOf().tracking_number, 'FAKE-1');
    assert.equal(statusOf().booking_error, null, 'the replay never reached the error handling');

    // Returns: a separate returnStatus is not covered by the signature, so it never sends a refund on its own…
    const o = deliveredOrder({ lines: [{ name: 'Vase', cents: 8000 }], shop: shopB, provider: 'oto' });
    const q = await ask(o, {});
    assert.equal((await approveReq(q.data.id)).status, 200);
    const oref = db.prepare('SELECT delivery_ref FROM shipments WHERE id=?').get(o.shipmentId).delivery_ref;
    db.prepare("UPDATE return_collections SET status='booked', ref=?, note=NULL WHERE request_id=?").run(`${oref}-R1`, q.data.id);
    stripe.reset();
    sent.length = 0;
    const ts2 = '1760000000002';
    r = await otoHook({ orderId: oref, status: 'delivered', returnStatus: 'reversePickedUp', returnOrderId: `${oref}-R1`, timestamp: ts2, signature: otoSign(oref, 'delivered', ts2) });
    assert.equal(r.status, 200);
    assert.equal(reqRow(q.data.id).status, 'approved', 'no refund on an unproven return status');
    assert.equal(refundsMade().length, 0);
    assert.ok(sent.some((m) => m.to === 'admin@test.local' && /Check a return collection/.test(m.subject)));
    // …a signed return status does,
    const ts3 = '1760000000003';
    r = await otoHook({ orderId: oref, status: 'reversePickedUp', returnOrderId: `${oref}-R1`, timestamp: ts3, signature: otoSign(oref, 'reversePickedUp', ts3) });
    assert.equal(r.status, 200);
    assert.equal(reqRow(q.data.id).status, 'refunded');
    assert.equal(refundsMade().length, 1);
    // …and the registered authorization key still proves the whole message (as OTO sends it).
    const sh2 = otoShipment();
    r = await otoHook({ orderId: sh2.delivery_ref, status: 'delivered', timestamp: '1760000000004' }, 'status', { Authorization: 'oto-secret' });
    assert.deepEqual(r.data, { received: true, matched: true });
    assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh2.id).status, 'delivered');
  } finally { delete process.env.OTO_WEBHOOK_SECRET; }
});

/* ---------------- F237 ---------------- */
test('F237: a courier event that fails part-way is applied on the retry, not lost as a duplicate', async () => {
  process.env.OTO_WEBHOOK_SECRET = 'oto-secret';
  const shipments = require('../src/shipments');
  const real = shipments.markDelivered;
  let failOnce = true;
  shipments.markDelivered = (...a) => { if (failOnce) { failOnce = false; throw new Error('database is locked'); } return real(...a); };
  try {
    const sh = otoShipment();
    const ts = '1760000000010';
    const body = { orderId: sh.delivery_ref, status: 'delivered', timestamp: ts, signature: otoSign(sh.delivery_ref, 'delivered', ts), deliveryCompany: 'aramex' };
    let r = await otoHook(body);
    assert.equal(r.status, 500, 'OTO is asked to retry');
    const now = db.prepare('SELECT * FROM shipments WHERE id=?').get(sh.id);
    assert.equal(now.status, 'processing');
    assert.equal(now.carrier, '', 'the half-applied event rolled back with the failure');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM webhook_events WHERE event_id LIKE ?').get(`oto:sig:${sh.delivery_ref}:%`).c, 0, "not recorded as seen");
    r = await otoHook(body);
    assert.deepEqual(r.data, { received: true, matched: true }, 'the old code answered duplicate here');
    assert.equal(db.prepare('SELECT status FROM shipments WHERE id=?').get(sh.id).status, 'delivered');
    r = await otoHook(body);
    assert.deepEqual(r.data, { received: true, duplicate: true });
  } finally {
    shipments.markDelivered = real;
    delete process.env.OTO_WEBHOOK_SECRET;
  }
});

/* ---------------- F452 ---------------- */
test('F452: the Quiqup shared-secret header is compared safely', async () => {
  process.env.QUIQUP_WEBHOOK_SECRET = 's3cret';
  try {
    const hook = (secret) => ctx.api('POST', '/api/delivery/webhook', { body: { ref: 'NOPE-1', event: 'delivered' }, headers: { 'x-webhook-secret': secret } });
    assert.equal((await hook('s3cret')).status, 200);
    assert.equal((await hook('s3creX')).status, 401);
    assert.equal((await hook('s3creé')).status, 401, 'a multi-byte guess is refused, not a crash');
  } finally { delete process.env.QUIQUP_WEBHOOK_SECRET; }
});

/* ---------------- F239 ---------------- */
test('F239: later courier calls go to the courier that booked the parcel, and fail loudly when it is gone', async () => {
  const delivery = require('../src/delivery');
  const sh = otoShipment(); // booked with OTO; OTO is not connected in this file
  await assert.rejects(delivery.markReady(sh.id), /booked with OTO, which is not connected/);
  await assert.rejects(delivery.cancelPickup(sh.id), /booked with OTO/);
  assert.equal(await delivery.getLabel(sh.id), null);
  // A test-courier parcel while a real courier is connected: refused, never a fake 'ready'.
  const mock = otoShipment();
  db.prepare("UPDATE shipments SET delivery_provider='mock', delivery_ref=? WHERE id=?").run(`QMOCK-${mock.id}-1`, mock.id);
  process.env.OTO_REFRESH_TOKEN = 'rt-not-used';
  try {
    await assert.rejects(delivery.markReady(mock.id), /test courier/);
  } finally { delete process.env.OTO_REFRESH_TOKEN; }
  assert.equal(db.prepare('SELECT ready_at FROM shipments WHERE id=?').get(mock.id).ready_at, null);
  // With no real courier connected, the test courier answers for its own parcel.
  assert.ok(await delivery.markReady(mock.id));
});

/* ---------------- F240 + F219 (OTO side) ---------------- */
test('F240 + F219: OTO gets a changed pickup address before the courier is booked; a return without an OTO id gets no made-up one', async () => {
  const calls = [];
  const known = new Set();
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const p = new URL(req.url, 'http://x').pathname.replace(/^\/rest\/v2/, '');
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ path: p, body });
      const send = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (p === '/refreshToken') return send({ access_token: 'at-d', expires_in: 3600 });
      if (p === '/createPickupLocation') { known.add(body.code); return send({ success: true }); }
      if (p === '/updatePickupLocation') return send({ success: known.has(body.code) });
      if (p === '/checkOTODeliveryFee') return send({ success: true, deliveryCompany: [{ deliveryOptionId: 22, deliveryOptionName: 'Aramex', serviceType: 'express', deliveryType: 'toCustomerDoorstep', pickupDropoff: 'freePickup', price: 18 }] });
      if (p === '/createShipment') return send({ success: true });
      if (p === '/createReturnShipment') return send({ success: true, message: 'created' }); // no returnOrderId
      return send({ success: false });
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.OTO_API_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.OTO_REFRESH_TOKEN = 'rt-d';
  const oto = require('../src/delivery/oto-live');
  oto._resetToken();
  try {
    const shop = { id: 990001, name: 'Fake Kiln', pickup_address: 'Unit 1, Al Quoz, Dubai', pickup_phone: '+971509998877', owner_name: 'Mara', owner_email: 'm@test.local' };
    const shipment = { id: 1, public_id: 'TRV-FK1', shipping_json: JSON.stringify(ADDR), buyer_phone: '+971501112233' };
    await oto.markReady('TRV-FK1-1', shipment, shop);
    // The maker moves studio after the order came in, then packs.
    shop.pickup_address = 'Studio 9, Alserkal Avenue, Dubai';
    calls.length = 0;
    await oto.markReady('TRV-FK1-2', shipment, shop);
    const paths = calls.map((c) => c.path);
    const upd = paths.indexOf('/updatePickupLocation');
    assert.ok(upd > -1 && upd < paths.indexOf('/createShipment'), `the new address goes first: ${paths.join(' → ')}`);
    assert.equal(calls[upd].body.address, 'Studio 9, Alserkal Avenue, Dubai');
    // Nothing changed: no extra call (the synced cache).
    calls.length = 0;
    await oto.markReady('TRV-FK1-3', shipment, shop);
    assert.ok(!calls.some((c) => /PickupLocation/.test(c.path)));
    // F219: OTO answered without a return id → none is stored (never the shared '<orderId>-R').
    const r = await oto.bookReversePickup(shipment, shop, [], [{ order_item_id: 5, qty: 1 }]);
    assert.equal(r.ref, null);
  } finally {
    delete process.env.OTO_REFRESH_TOKEN;
    delete process.env.OTO_API_URL;
    oto._resetToken();
    await new Promise((r) => fake.close(r));
  }
});

/* ---------------- F445 ---------------- */
test('F445: a change-of-mind return worth the collection fee or less is refused before a courier is booked', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Coaster', cents: 2500 }, { name: 'Tray', cents: 9000 }] }); // AED 115: the fee applies
  let r = await ask(o, { itemIds: [o.itemIds[0]], reason: 'changed-mind' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /AED 30 collection fee for a change-of-mind return is at least what these pieces cost/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM return_requests WHERE order_id=?').get(o.id).c, 0);
  // A fault is collected free, so the same piece can come back for one…
  r = await ask(o, { itemIds: [o.itemIds[0]], reason: 'damaged' });
  assert.equal(r.status, 201, r.text);
  // …and a change of mind worth more than the fee goes through.
  r = await ask(o, { itemIds: [o.itemIds[1]], reason: 'changed-mind' });
  assert.equal(r.status, 201, r.text);
});

/* ---------------- F446 ---------------- */
test('F446: a Quiqup return collects only the units coming back', () => {
  const q = require('../src/delivery/quiqup-live');
  const shipment = { id: 7, public_id: 'TRV-QQ1', shipping_json: JSON.stringify(ADDR), buyer_phone: '+971501112233' };
  const shop = { name: 'Kiln Works', pickup_address: 'Al Quoz, Dubai', pickup_phone: '+971509998877' };
  const part = q._order('reverse', shipment, shop, [{ order_item_id: 3, qty: 1, name_snapshot: 'Mug' }]);
  assert.deepEqual(part.items, [{ name: 'Return · Mug · TRV-QQ1', quantity: 1 }]);
  assert.match(part.notes, /collect ONLY 1 item: 1 × Mug/);
  const whole = q._order('reverse', shipment, shop);
  assert.equal(whole.items.length, 1);
  assert.match(whole.items[0].name, /^Return · TRV-QQ1/);
});

/* ---------------- F447 ---------------- */
test('F447: a piece-by-piece full return reverses every fil of VAT', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Cup', cents: 1015, qty: 2 }], shippingCents: 0 });
  assert.equal(o.vat, 97);
  for (let i = 0; i < 2; i++) {
    const r = await ask(o, { items: [{ id: o.itemIds[0], qty: 1 }] });
    assert.equal(r.status, 201, r.text);
    await approveReq(r.data.id);
    await ctx.api('POST', '/api/delivery/mock/collect-return', { body: { requestId: r.data.id } });
    assert.equal(reqRow(r.data.id).status, 'refunded');
  }
  const done = row(o.id);
  assert.ok(done.refunded_at);
  assert.equal(done.vat_reversed_cents, 97, 'the old per-refund rounding left 96 of 97');
});

/* ---------------- F448 ---------------- */
test('F448: return collections are indexed by parcel', () => {
  const idx = db.prepare("PRAGMA index_list('return_collections')").all().map((i) => i.name);
  assert.ok(idx.includes('idx_retcol_shipment'));
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='026-D-money-fixes'").get());
});

/* ---------------- F449 ---------------- */
test('F449: a settlement calendar off Tuesdays falls back to the default, loudly', () => {
  const read = (extra) => JSON.parse(runChild("const f=require('./src/fees'); console.log(JSON.stringify({a:f.SETTLEMENT_ANCHOR_DATE,i:f.SETTLEMENT_INTERVAL_DAYS}))", extra).out.trim().split('\n').pop());
  assert.deepEqual(read({ SETTLEMENT_ANCHOR_DATE: '2026-10-07' }), { a: '2026-10-06', i: 14 }, 'a Wednesday anchor');
  assert.deepEqual(read({ SETTLEMENT_INTERVAL_DAYS: '10' }), { a: '2026-10-06', i: 14 }, 'not whole weeks');
  assert.deepEqual(read({ SETTLEMENT_ANCHOR_DATE: '2026-10-13', SETTLEMENT_INTERVAL_DAYS: '7' }), { a: '2026-10-13', i: 7 }, 'a valid weekly calendar is kept');
  // …and it says so in the log.
  const loud = require('child_process').spawnSync(process.execPath, ['-e', "require('./src/fees')"], { cwd: BACKEND, env: childEnv({ SETTLEMENT_ANCHOR_DATE: '2026-10-07' }) });
  assert.match(String(loud.stderr), /SETTLEMENT_ANCHOR_DATE 2026-10-07 is not a Tuesday/);
});

/* ---------------- F451 ---------------- */
test('F451: the pack-by sweep counts what it stamped and records a reminder that did not go out', async () => {
  const notify = require('../src/notify');
  const real = notify.packReminder;
  notify.packReminder = () => Promise.resolve(null); // the email provider is down
  try {
    const sh = otoShipment();
    db.prepare("UPDATE shipments SET pack_by_at=datetime('now','-1 day') WHERE id=?").run(sh.id);
    const sweeps = require('../src/order-sweep');
    const out = await sweeps.sweepPackBy();
    assert.equal(out.reminded, 1);
    assert.equal(out.failed, 1);
    const job = db.prepare("SELECT * FROM job_runs WHERE job='pack-by'").get();
    assert.equal(job.failing, 1);
    assert.match(job.last_error, /did not go out/);
    assert.ok(db.prepare('SELECT pack_reminder_at FROM shipments WHERE id=?').get(sh.id).pack_reminder_at, 'stamped, so it never double-sends');
    const again = await sweeps.sweepPackBy();
    assert.equal(again.reminded, 0, 'the count is what THIS run did');
  } finally { notify.packReminder = real; }
  const srv = fs.readFileSync(path.join(BACKEND, 'src', 'server.js'), 'utf8');
  assert.match(srv, /if \(!failed\) jobs\.ok\('pack-by'\)/, 'a failed send is not wiped by the OK record');
});

/* ---------------- F453 ---------------- */
test('F453: the mock courier is called the test courier', () => {
  assert.equal(require('../src/delivery/quiqup-mock').name, 'Test courier');
});

/* ---------------- F460 ---------------- */
test('F460: a double-clicked whole-order refund refunds and books once', async () => {
  const o = deliveredOrder({ lines: [{ name: 'Rug', cents: 30000 }] });
  // Its credit was already paid out: a refund writes a debit — exactly one.
  const sid = db.prepare("INSERT INTO settlements (run_date, status) VALUES (date('now'), 'paid')").run().lastInsertRowid;
  db.prepare("UPDATE seller_balances SET settlement_id=? WHERE order_id=? AND type='credit_sale'").run(sid, o.id);
  stripe.reset();
  sent.length = 0;
  const call = () => ctx.api('POST', `/api/admin/orders/${o.pid}/refund`, { cookie: adminCookie });
  const [a, b] = await Promise.all([call(), call()]);
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 409), `${a.status} ${b.status}`);
  assert.ok([a, b].some((r) => r.status === 200 && !r.data.alreadyRefunded));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seller_balances WHERE order_id=? AND type='debit_refund'").get(o.id).c, 1, 'one debit, not two');
  const creates = refundsMade();
  assert.ok(creates.length >= 1 && creates.length <= 2);
  assert.ok(creates.every((c) => c.opts && c.opts.idempotencyKey === `trove-order-refund-${o.id}`));
  assert.equal(sent.filter((m) => m.to === 'buyer@test.local' && /refund/i.test(m.subject)).length, 1, 'the buyer hears once');
  // Later retries are refused cleanly.
  assert.equal((await call()).status, 409);
});

/* ---------------- F433 ---------------- */
test('F433 (basis is the accountant’s call): card-booking VAT follows SERVICE_VAT_BASIS — full price by default, the platform fee when set', () => {
  const sb = require('../src/service-bookings');
  assert.equal(fees.SERVICE_VAT_BASIS, 'full');
  assert.equal(sb.serviceVat(40000, 4000), 1905);
  const prev = fees.SERVICE_VAT_BASIS;
  fees.SERVICE_VAT_BASIS = 'fee';
  try { assert.equal(sb.serviceVat(40000, 4000), 190); } finally { fees.SERVICE_VAT_BASIS = prev; }
});
