'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * The confirmation page tells the buyer "a receipt is on its way" — this is
 * the receipt. It goes out from the shared paid effects, so the real Stripe
 * webhook and demo-mode completion send exactly the same email, and a mail
 * failure can never unwind a paid order.
 */

const ADDRESS = { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' };
const PHONE = '050 123 4567';

let ctx, db, buyerCookie, mugId, throwId, sent;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal@test.local',?, 'Amal Rashid','buyer')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  const pots = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  const loom = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Loom', 'test-loom').lastInsertRowid;
  mugId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status,options,variants) VALUES (?,?,?,?,?,'live',?,?)")
    .run(pots, 'Mug', 'Ceramics', 6400, 9, JSON.stringify([{ name: 'Colour', values: ['Clay'] }]),
      JSON.stringify([{ key: 'Colour:Clay', options: [{ name: 'Colour', value: 'Clay' }], stock: 9, priceCents: null }])).lastInsertRowid;
  throwId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(loom, 'Wool Throw', 'Home & Living', 36000, 4).lastInsertRowid;

  buyerCookie = await ctx.loginAs('amal@test.local', 'testpass123');

  // Capture what would have gone to Resend.
  sent = [];
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
});
after(async () => { await ctx.close(); });

test('paying sends the buyer a receipt with the order, the pieces and the money', async () => {
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: mugId, qty: 3, options: [{ name: 'Colour', value: 'Clay' }] }, { productId: throwId, qty: 1 }],
    address: ADDRESS, phone: PHONE } });
  assert.equal(res.status, 200, res.text);
  await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: res.data.orderId } });

  assert.equal(sent.length, 1, 'exactly one receipt');
  const mail = sent[0];
  assert.equal(mail.to, 'amal@test.local');
  assert.match(mail.subject, new RegExp(res.data.orderId));
  assert.match(mail.html, /Thank you, Amal/, 'greets them by name');
  assert.match(mail.html, /Mug/);
  assert.match(mail.html, /Colour: Clay/, 'says which one is coming');
  assert.match(mail.html, /Wool Throw/);
  assert.match(mail.html, /AED 552/, 'subtotal: 3 mugs at 64 plus a 360 throw');
  assert.ok(!mail.html.includes('Service fee'), 'no service fee line — there is none to charge');
  assert.match(mail.html, />Free</, 'free delivery reads as Free, not AED 0');
  assert.match(mail.html, /3–6 days/, 'the same promise the site makes');
  assert.match(mail.html, /2 parcels/, 'two shops, two parcels, one order');
  assert.match(mail.html, /Harbour Views/, 'where it is going');
  assert.ok(!mail.html.includes(PHONE), 'no need to read their own number back to them');
});

test('a receipt that fails to send never unwinds a paid order', async () => {
  require('../src/email').send = async () => { throw new Error('Resend is down'); };
  const res = await ctx.api('POST', '/api/checkout', { cookie: buyerCookie, body: {
    items: [{ productId: throwId, qty: 1 }], address: ADDRESS, phone: PHONE } });
  const done = await ctx.api('POST', '/api/checkout/demo-complete', { cookie: buyerCookie, body: { orderId: res.data.orderId } });
  assert.equal(done.status, 200, 'the order still completes');
  assert.equal(db.prepare('SELECT status FROM orders WHERE public_id=?').get(res.data.orderId).status, 'paid');
});
