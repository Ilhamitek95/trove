'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({ STRIPE_MOCK: '' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Emails go out in the recipient's language (src/email.js langFor):
 * an account's users.lang, a guest order's orders.lang (the checkout page's
 * language), a services booking's lang. Arabic emails are right-to-left,
 * link to the /ar pages and keep prices and order numbers in left-to-right
 * isolates. Emails to the person who runs Trove stay English.
 */

const ADDRESS = { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' };
const PHONE = '050 123 4567';
const LRI = '⁦';

let ctx, db, sent, arCookie, enCookie, mugId;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role,lang) VALUES ('amal@test.local',?, 'Amal Rashid','buyer','ar')").run(pw);
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('ella@test.local',?, 'Ella Stone','buyer')").run(pw);
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role,lang) VALUES ('maker@test.local',?, 'Mira Maker','seller','ar')").run(pw).lastInsertRowid;
  const shop = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?, 'approved','consignment')").run(seller, 'Test Pots', 'test-pots').lastInsertRowid;
  mugId = db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,?,'live')").run(shop, 'Mug', 'Ceramics', 6400, 50).lastInsertRowid;
  // The piece's name has a current Arabic translation (src/translate.js).
  db.prepare(`INSERT INTO translations (entity, entity_id, field, lang, text, source_hash, source_text)
    VALUES ('product', ?, 'name', 'ar', 'كوب', ?, 'Mug')`).run(String(mugId), require('../src/translate').sha('Mug'));

  arCookie = await ctx.loginAs('amal@test.local', 'testpass123');
  enCookie = await ctx.loginAs('ella@test.local', 'testpass123');
  sent = [];
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
});
after(async () => { await ctx.close(); });

async function buy(cookie, extra = {}, headers) {
  const res = await ctx.api('POST', '/api/checkout', { cookie, headers, body: { items: [{ productId: mugId, qty: 1 }], address: ADDRESS, phone: PHONE, ...extra } });
  assert.equal(res.status, 200, res.text);
  const done = await ctx.api('POST', '/api/checkout/demo-complete', { cookie, headers, body: { orderId: res.data.orderId } });
  assert.equal(done.status, 200, done.text);
  await new Promise((r) => setTimeout(r, 30));
  return res.data.orderId;
}

test('a buyer whose account is in Arabic gets an Arabic, right-to-left receipt with /ar links and isolated prices', async () => {
  sent.length = 0;
  const id = await buy(arCookie);
  const mail = sent.find((m) => m.to === 'amal@test.local');
  assert.ok(mail, 'a receipt went out');
  assert.match(mail.subject, /تم تأكيد طلبك/);
  assert.ok(mail.subject.includes(id));
  assert.match(mail.html, /<html lang="ar" dir="rtl">/);
  assert.match(mail.html, /https:\/\/troveathome\.com\/ar\/account/, 'links point at the Arabic pages');
  assert.ok(mail.html.includes(`${LRI}AED 64`), 'the price sits in a left-to-right isolate');
  assert.match(mail.html, /كوب/, 'the piece is named in Arabic');
  assert.match(mail.html, /شكراً لك، Amal/);
  assert.doesNotMatch(mail.html, /Your order is confirmed|<i>|font-style:\s*italic/);
});

test('a maker whose account is in Arabic gets the new order to pack in Arabic; the English buyer stays English', async () => {
  sent.length = 0;
  const id = await buy(enCookie);
  const buyerMail = sent.find((m) => m.to === 'ella@test.local');
  assert.equal(buyerMail.subject, `Your Trove order ${id} is confirmed`, 'English subject, unchanged');
  assert.match(buyerMail.html, /<html lang="en"><head>/);
  assert.match(buyerMail.html, /Thank you, Amal\. Test Pots is preparing your piece now/);
  assert.doesNotMatch(buyerMail.html, /⁦|\/ar\//);
  const maker = sent.find((m) => m.to === 'maker@test.local');
  assert.ok(maker, 'the maker heard');
  assert.match(maker.subject, /طلب جديد للتغليف/);
  assert.match(maker.html, /dir="rtl"/);
  assert.match(maker.html, /يُرجى التغليف قبل/);
  assert.match(maker.html, /https:\/\/[^"]*\/ar\/sell\?view=orders|\/ar\/sell/, 'the dashboard link is the Arabic one');
});

test('a guest checkout from an Arabic page stores orders.lang = ar and gets Arabic email', async () => {
  sent.length = 0;
  const res = await ctx.api('POST', '/api/checkout', { headers: { 'X-Trove-Lang': 'ar' }, body: { items: [{ productId: mugId, qty: 1 }], email: 'guest@test.local', address: ADDRESS, phone: PHONE } });
  assert.equal(res.status, 200, res.text);
  assert.equal(db.prepare('SELECT lang FROM orders WHERE public_id=?').get(res.data.orderId).lang, 'ar');
  const order = db.prepare('SELECT * FROM orders WHERE public_id=?').get(res.data.orderId);
  require('../src/paid-effects').sendConfirmation
    ? require('../src/paid-effects').sendConfirmation(order)
    : await ctx.api('POST', '/api/checkout/demo-complete', { headers: { 'X-Trove-Lang': 'ar' }, body: { orderId: res.data.orderId } });
  const email = require('../src/email');
  const msg = email.orderConfirmation({ order, items: [{ name: 'Mug', qty: 1, price_cents: 6400 }], shops: ['Test Pots'], ship: ADDRESS });
  assert.match(msg.html, /dir="rtl"/);
  assert.match(msg.html, /أتممت الطلب كزائر/, 'the guest note, in Arabic');
  // and an English page's guest order stays English
  const en = await ctx.api('POST', '/api/checkout', { body: { items: [{ productId: mugId, qty: 1 }], email: 'guest2@test.local', address: ADDRESS, phone: PHONE } });
  assert.equal(db.prepare('SELECT lang FROM orders WHERE public_id=?').get(en.data.orderId).lang, 'en');
});

test('emails to the person who runs Trove stay English even when the admin reads Arabic', () => {
  const email = require('../src/email');
  const alert = email.adminAlert({ subject: 'Courier booking failed', lines: ['Order TRV-1'], link: 'https://troveathome.com/admin' });
  assert.match(alert.html, /<html lang="en">/);
  assert.doesNotMatch(alert.html, /dir="rtl"/);
  const app = email.applicationAlert({ kind: 'shop', businessName: 'Pots', applicantName: 'Mira', link: 'https://troveathome.com/admin' });
  assert.equal(app.subject, 'New shop application: Pots');
  const overdue = email.packOverdueAdmin({ shopName: 'Pots', publicId: 'TRV-1', items: [{ name: 'Mug', qty: 1 }], packBy: 'Friday 2 October', link: 'x' });
  assert.match(overdue.subject, /^Overdue: Pots/);
});

test('account and services emails follow the recipient language; English output is unchanged', () => {
  const email = require('../src/email');
  const ar = email.passwordReset({ name: 'Amal Rashid', link: 'https://troveathome.com/reset?token=abc', lang: 'ar' });
  assert.match(ar.subject, /كلمة مرور/);
  assert.match(ar.html, /https:\/\/troveathome\.com\/ar\/reset\?token=abc/);
  const en = email.passwordReset({ name: 'Amal Rashid', link: 'https://troveathome.com/reset?token=abc' });
  assert.equal(en.subject, 'Reset your Trove password');
  assert.match(en.html, /href="https:\/\/troveathome\.com\/reset\?token=abc"/);
  // a services booking made from an Arabic page
  const bk = { code: 'SRV-ABC', title: 'Pottery class', provider_name: 'Kiln & Clay', area: 'Dubai Marina', name: 'Amal Rashid', payment_method: 'direct', price_cents: 25000, price_type: 'fixed', lang: 'ar' };
  const req = email.bookingRequestReceived({ booking: bk, viewUrl: 'https://troveathome.com/services/booking/SRV-ABC?t=x' });
  assert.match(req.html, /dir="rtl"/);
  assert.match(req.html, /\/ar\/services\/booking\/SRV-ABC/);
  assert.ok(req.subject.includes(`${LRI}SRV-ABC`));
  const reqEn = email.bookingRequestReceived({ booking: { ...bk, lang: 'en' }, viewUrl: 'https://troveathome.com/services/booking/SRV-ABC?t=x' });
  assert.equal(reqEn.subject, "We've sent your booking request — SRV-ABC");
});

test('langFor: account first, then the order or booking, else English', () => {
  const { langFor } = require('../src/email');
  const amal = db.prepare("SELECT id FROM users WHERE email='amal@test.local'").get().id;
  assert.equal(langFor({ order: { buyer_id: amal, lang: 'en' } }), 'ar', 'the account wins');
  assert.equal(langFor({ order: { buyer_id: null, lang: 'ar' } }), 'ar', 'a guest: the checkout page');
  assert.equal(langFor({ booking: { lang: 'ar' } }), 'ar');
  assert.equal(langFor({ email: 'AMAL@test.local' }), 'ar', 'by email, any case');
  assert.equal(langFor({ email: 'nobody@test.local' }), 'en');
  assert.equal(langFor({}), 'en');
});
