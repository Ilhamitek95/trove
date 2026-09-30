'use strict';
/**
 * The last piece can only be sold once. Checkout reserves nothing, so two
 * buyers can both reach payment; at payment the stock is taken with a
 * conditional decrement and the loser's order is cancelled, flagged for
 * admin, refunded in full automatically and the buyer is emailed.
 */
const { testEnv, startApp } = require('./helpers');
testEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, stripe, shopId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pendingOrder(pid, pi, productId, { qty = 1, options = '[]', price = 30000 } = {}) {
  const id = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status,rail,stripe_payment_intent_id)
    VALUES (?,?,?,0,0,?,'pending','consignment',?)`).run(pid, `${pid}@test.local`, price * qty, price * qty, pi).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,options) VALUES (?,?,?,?,?,?,?)')
    .run(id, productId, shopId, 'Only vase', price, qty, options);
  return id;
}
const pay = (evt, pi, orderId) => ctx.postWebhook({ id: evt, type: 'payment_intent.succeeded', data: { object: { id: pi, metadata: { order_id: String(orderId) } } } });

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  stripe = ctx.stripeMock;
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('m@test.local','x','M','seller')").run().lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?,'approved','consignment')").run(uid, 'Pots', 'pots').lastInsertRowid;
});
after(async () => { await ctx.close(); });

test('the second payment for the last piece is refunded automatically and flagged, never shipped', async () => {
  const vase = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,30000,1,'live')")
    .run(shopId, 'Only vase', 'Ceramics').lastInsertRowid;
  const a = pendingOrder('TRV-OS001', 'pi_os_a', vase);
  const b = pendingOrder('TRV-OS002', 'pi_os_b', vase);
  stripe.reset();

  assert.equal((await pay('evt_os_a', 'pi_os_a', a)).status, 200);
  assert.equal((await pay('evt_os_b', 'pi_os_b', b)).status, 200);
  await sleep(60);

  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(a).status, 'paid');
  const lost = db.prepare('SELECT * FROM orders WHERE id=?').get(b);
  assert.equal(lost.status, 'cancelled');
  assert.equal(lost.attention, 'oversold');
  assert.ok(lost.refunded_at, 'refund stamped');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(vase).stock, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shipments WHERE order_id=?').get(b).c, 0, 'nothing to ship');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM seller_balances WHERE order_id=?').get(b).c, 0, 'no credit for the shop');

  const refunds = stripe.calls.filter((c) => c.method === 'refunds.create');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].params.payment_intent, 'pi_os_b');

  // A redelivered event changes nothing and refunds nothing twice.
  await pay('evt_os_b', 'pi_os_b', b);
  await sleep(30);
  assert.equal(stripe.calls.filter((c) => c.method === 'refunds.create').length, 1);

  // Admin sees the flag on the order list.
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('adm@test.local',?,'A','admin')").run(hashPassword('adminpass123'));
  const cookie = await ctx.loginAs('adm@test.local', 'adminpass123');
  const list = await ctx.api('GET', '/api/admin/orders', { cookie });
  const row = list.data.orders.find((o) => o.publicId === 'TRV-OS002');
  assert.equal(row.attention, 'oversold');
  assert.equal(row.status, 'cancelled');
});

test('a failed automatic refund leaves a louder flag for a manual refund', async () => {
  const vase = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,30000,0,'live')")
    .run(shopId, 'Only vase', 'Ceramics').lastInsertRowid;
  const b = pendingOrder('TRV-OS003', 'pi_os_c', vase);
  const real = stripe.refunds.create;
  stripe.refunds.create = async () => { throw new Error('card network down'); };
  try {
    await pay('evt_os_c', 'pi_os_c', b);
    await sleep(60);
  } finally { stripe.refunds.create = real; }
  const lost = db.prepare('SELECT * FROM orders WHERE id=?').get(b);
  assert.equal(lost.attention, 'oversold_refund_failed');
  assert.equal(lost.refunded_at, null);
});

test('variants: the stock of the exact combination is what counts, and a partial order takes nothing', async () => {
  const options = JSON.stringify([{ name: 'Glaze', values: ['Ash', 'Clay'] }]);
  const variants = JSON.stringify([
    { key: 'Glaze:Ash', options: [{ name: 'Glaze', value: 'Ash' }], stock: 1, priceCents: null },
    { key: 'Glaze:Clay', options: [{ name: 'Glaze', value: 'Clay' }], stock: 5, priceCents: null },
  ]);
  const mug = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status,options,variants) VALUES (?,?,?,5000,6,'live',?,?)")
    .run(shopId, 'Glazed mug', 'Ceramics', options, variants).lastInsertRowid;
  const ash = JSON.stringify([{ name: 'Glaze', value: 'Ash' }]);
  const clay = JSON.stringify([{ name: 'Glaze', value: 'Clay' }]);
  // 2 clay (fine) + 2 ash (only 1 left) → the whole order fails and the clay
  // stock is left untouched.
  const id = pendingOrder('TRV-OS004', 'pi_os_d', mug, { qty: 2, options: clay, price: 5000 });
  db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,options) VALUES (?,?,?,?,?,?,?)')
    .run(id, mug, shopId, 'Glazed mug', 5000, 2, ash);
  await pay('evt_os_d', 'pi_os_d', id);
  await sleep(40);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status, 'cancelled');
  const p = db.prepare('SELECT stock, variants FROM products WHERE id=?').get(mug);
  assert.equal(p.stock, 6, 'nothing taken');
  assert.deepEqual(JSON.parse(p.variants).map((v) => v.stock), [1, 5]);

  // One ash alone goes through and takes exactly that combination.
  const ok = pendingOrder('TRV-OS005', 'pi_os_e', mug, { qty: 1, options: ash, price: 5000 });
  await pay('evt_os_e', 'pi_os_e', ok);
  await sleep(40);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(ok).status, 'paid');
  const after = db.prepare('SELECT stock, variants FROM products WHERE id=?').get(mug);
  assert.deepEqual(JSON.parse(after.variants).map((v) => v.stock), [0, 5]);
  assert.equal(after.stock, 5);
});

test('the refund email names the order and the amount', () => {
  const email = require('../src/email');
  const msg = email.orderUnavailable({ order: { public_id: 'TRV-X1', total_cents: 30000 }, items: [{ name: 'Only vase', qty: 1, price_cents: 30000 }] });
  assert.match(msg.subject, /TRV-X1/);
  assert.match(msg.html, /AED 300/);
  assert.match(msg.html, /Only vase/);
});
