'use strict';
/**
 * Courier webhooks fail closed in production when their secret is unset,
 * and each one only moves shipments booked with its own courier — a Quiqup
 * call can never deliver an OTO parcel (whose reference is guessable from
 * the public order id), nor the other way round.
 */
const { testEnv, startApp } = require('./helpers');
testEnv(); // no QUIQUP_WEBHOOK_SECRET, no OTO_WEBHOOK_SECRET

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, shopId, orderId;

function shipment(ref, provider) {
  return db.prepare("INSERT INTO shipments (order_id, shop_id, status, delivery_ref, delivery_provider) VALUES (?,?, 'processing', ?, ?)")
    .run(orderId, shopId, ref, provider).lastInsertRowid;
}
const statusOf = (id) => db.prepare('SELECT status FROM shipments WHERE id=?').get(id).status;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('w@test.local','x','W','seller')").run().lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(uid, 'W', 'w').lastInsertRowid;
  orderId = db.prepare(`INSERT INTO orders (public_id,email,subtotal_cents,shipping_cents,service_fee_cents,total_cents,status)
    VALUES ('TRV-WH01','b@test.local',100,0,0,100,'paid')`).run().lastInsertRowid;
});
after(async () => { await ctx.close(); });

test('in production an unset secret refuses every courier call (401)', async () => {
  const oto = shipment('TRV-WH01-901', 'oto');
  const quiq = shipment('880001', 'quiqup');
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let r = await ctx.api('POST', '/api/delivery/webhook', { body: { ref: '880001', event: 'delivered' } });
    assert.equal(r.status, 401);
    r = await ctx.api('POST', '/api/delivery/oto-webhook?t=status', { body: { orderId: 'TRV-WH01-901', status: 'delivered', timestamp: 1 } });
    assert.equal(r.status, 401);
  } finally { process.env.NODE_ENV = prev; }
  assert.equal(statusOf(oto), 'processing');
  assert.equal(statusOf(quiq), 'processing');
});

test('the Quiqup webhook cannot move an OTO parcel, and OTO cannot move a Quiqup one', async () => {
  const oto = shipment('TRV-WH01-902', 'oto');
  const quiq = shipment('880002', 'quiqup');
  let r = await ctx.api('POST', '/api/delivery/webhook', { body: { ref: 'TRV-WH01-902', event: 'delivered' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.matched, false);
  assert.equal(statusOf(oto), 'processing');

  r = await ctx.api('POST', '/api/delivery/oto-webhook?t=status', { body: { orderId: '880002', status: 'delivered', timestamp: 2 } });
  assert.equal(r.data.matched, false);
  assert.equal(statusOf(quiq), 'processing');

  // Each still moves its own.
  r = await ctx.api('POST', '/api/delivery/webhook', { body: { ref: '880002', event: 'delivered' } });
  assert.equal(r.data.matched, true);
  assert.equal(statusOf(quiq), 'delivered');
  r = await ctx.api('POST', '/api/delivery/oto-webhook?t=status', { body: { orderId: 'TRV-WH01-902', status: 'delivered', timestamp: 3 } });
  assert.equal(r.data.matched, true);
  assert.equal(statusOf(oto), 'delivered');
});

test('rows booked before the provider column are attributed from their reference', () => {
  const { providerOf } = require('../src/delivery');
  assert.equal(providerOf({ delivery_ref: 'TRV-AB1234-7', delivery_provider: '' }), 'oto');
  assert.equal(providerOf({ delivery_ref: 'QMOCK-7-1', delivery_provider: '' }), 'mock');
  assert.equal(providerOf({ delivery_ref: '275530', delivery_provider: '' }), 'quiqup');
  assert.equal(providerOf({ delivery_ref: '275530', delivery_provider: 'oto' }), 'oto', 'the stored column wins');
  assert.equal(providerOf({ delivery_ref: '' }), '');
});
