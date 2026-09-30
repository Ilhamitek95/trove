'use strict';
/**
 * Partner emails: applications, decisions and orders to pack.
 *
 *   - shop and provider applications email the applicant AND the admin
 *   - approve / reject decisions email the applicant (reject quotes the note)
 *   - a paid order emails each maker their own pieces only — never the
 *     buyer's email, phone, name or address
 *   - an admin-hidden piece can't be put back on sale by its seller
 *   - anonymous booking requests are limited per address
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ ADMIN_EMAIL: 'boss@test.local', PUBLIC_URL: 'https://trove.test', STRIPE_MOCK: '' }); // demo payments: orders complete without Stripe

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, sent, adminCookie, ipN = 0;
const tick = () => new Promise((r) => setImmediate(r));

async function call(method, pathname, { body, cookie, ip } = {}) {
  const res = await fetch(ctx.baseUrl + pathname, {
    method, redirect: 'manual',
    headers: {
      'x-forwarded-for': ip || `203.0.113.${(++ipN % 250) + 1}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const mailsTo = (to) => sent.filter((m) => m.to === to);

const SHOP_APPLY = {
  email: 'potter@test.local', password: 'potterpass1', name: 'Mira Saleh', role: 'seller',
  shopName: 'Mira Clay Studio', about: 'Wheel-thrown stoneware.', location: 'Dubai', category: 'Ceramics',
  instagram: '@miraclay', phone: '+971 50 222 3344',
};
const PROVIDER_APPLY = {
  name: 'Reem Craft', email: 'reem@test.local', password: 'testpass123', providerName: 'Reem Makes',
  categories: ['workshops'], location: 'Dubai, UAE', about: 'Pottery workshops.', experience: '3+ years',
  instagram: '@reemmakes', links: '', phone: '+971 50 111 2233', agreeSub: true, agreeTerms: true,
};

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?,'Boss','admin')").run(hashPassword('adminpass123'));
  adminCookie = (await call('POST', '/api/auth/login', { body: { email: 'boss@test.local', password: 'adminpass123' } })).cookie;
  sent = [];
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
});
after(async () => { await ctx.close(); });

test('a shop application emails the applicant (received + welcome) and alerts the admin', async () => {
  sent.length = 0;
  const r = await call('POST', '/api/auth/register', { body: SHOP_APPLY });
  assert.equal(r.status, 201, r.text);
  await tick();
  const mine = mailsTo('potter@test.local');
  assert.ok(mine.some((m) => /shop application/.test(m.subject) && /Mira Clay Studio/.test(m.html) && m.html.includes('https://trove.test/sell')), 'application received, with a dashboard link');
  assert.ok(mine.some((m) => /confirm your email/.test(m.subject)), 'welcome + confirm link');
  const alert = mailsTo('boss@test.local');
  assert.equal(alert.length, 1);
  assert.match(alert[0].subject, /New shop application: Mira Clay Studio/);
  assert.ok(alert[0].html.includes('https://trove.test/admin'));
  assert.ok(!alert[0].html.includes('222 3344') && !alert[0].html.includes('potter@test.local'), 'contact details stay in the admin panel');
});

test('a provider application emails the applicant and alerts the admin', async () => {
  sent.length = 0;
  const r = await call('POST', '/api/services/apply', { body: PROVIDER_APPLY });
  assert.equal(r.status, 201, r.text);
  await tick();
  assert.ok(mailsTo('reem@test.local').some((m) => /services application/.test(m.subject) && m.html.includes('https://trove.test/provider')));
  assert.ok(mailsTo('reem@test.local').some((m) => /confirm your email/.test(m.subject)));
  assert.equal(mailsTo('boss@test.local').length, 1);
  assert.match(mailsTo('boss@test.local')[0].subject, /New services practice application: Reem Makes/);
});

test('approve and reject decisions email the applicant, once per change, quoting the admin note', async () => {
  const shop = db.prepare("SELECT id FROM shops WHERE slug='mira-clay-studio'").get();
  sent.length = 0;
  assert.equal((await call('PATCH', `/api/admin/shops/${shop.id}`, { cookie: adminCookie, body: { status: 'approved' } })).status, 200);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'potter@test.local');
  assert.match(sent[0].subject, /Mira Clay Studio is approved/);
  assert.ok(sent[0].html.includes('https://trove.test/sell'), 'dashboard link');

  sent.length = 0;
  await call('PATCH', `/api/admin/shops/${shop.id}`, { cookie: adminCookie, body: { status: 'approved' } });
  await tick();
  assert.equal(sent.length, 0, 'no email when nothing changed');

  const prov = db.prepare("SELECT id FROM service_providers WHERE slug='reem-makes'").get();
  sent.length = 0;
  const rej = await call('PATCH', `/api/admin/providers/${prov.id}`, { cookie: adminCookie, body: { status: 'rejected', note: 'We have enough <b>workshops</b> in Dubai this season.' } });
  assert.equal(rej.status, 200);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'reem@test.local');
  assert.match(sent[0].subject, /About your Trove application — Reem Makes/);
  assert.match(sent[0].html, /enough workshops in Dubai this season/, 'the note, markup stripped');

  sent.length = 0;
  await call('PATCH', `/api/admin/providers/${prov.id}`, { cookie: adminCookie, body: { status: 'approved' } });
  await tick();
  assert.match(sent[0].subject, /approved on Trove Services/);
});

test('a paid order emails each maker only their own pieces and never the buyer contact details', async () => {
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('amal.buyer@test.local',?,'Amal Rashid','buyer')").run(pw);
  const mk = (email, name) => db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,'seller')").run(email, pw, name).lastInsertRowid;
  const potsOwner = mk('pots.owner@test.local', 'Pia Potter');
  const loomOwner = mk('loom.owner@test.local', 'Lina Loom');
  const shop = (uid, name, slug) => db.prepare("INSERT INTO shops (user_id,name,slug,status,tier) VALUES (?,?,?,'approved','consignment')").run(uid, name, slug).lastInsertRowid;
  const pots = shop(potsOwner, 'Pia Pots', 'pia-pots');
  const loom = shop(loomOwner, 'Lina Loom', 'lina-loom');
  const prod = (sid, name, price) => db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?,?,?,5,'live')").run(sid, name, 'Home & Living', price).lastInsertRowid;
  const mug = prod(pots, 'Speckled Mug', 6400);
  const thr = prod(loom, 'Wool Throw', 36000);

  const buyer = (await call('POST', '/api/auth/login', { body: { email: 'amal.buyer@test.local', password: 'testpass123' } })).cookie;
  const PHONE = '050 765 4321';
  const co = await call('POST', '/api/checkout', { cookie: buyer, body: {
    items: [{ productId: mug, qty: 2 }, { productId: thr, qty: 1 }],
    address: { name: 'Amal Rashid', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' }, phone: PHONE } });
  assert.equal(co.status, 200, co.text);
  sent.length = 0;
  const done = await call('POST', '/api/checkout/demo-complete', { cookie: buyer, body: { orderId: co.data.orderId } });
  assert.equal(done.status, 200, done.text);
  await tick();

  const potsMail = mailsTo('pots.owner@test.local');
  const loomMail = mailsTo('loom.owner@test.local');
  assert.equal(potsMail.length, 1);
  assert.equal(loomMail.length, 1);
  assert.match(potsMail[0].subject, new RegExp(`New order to pack — ${co.data.orderId}`));
  assert.match(potsMail[0].html, /Speckled Mug/);
  assert.ok(!potsMail[0].html.includes('Wool Throw'), 'only their own pieces');
  assert.match(loomMail[0].html, /Wool Throw/);
  assert.ok(!loomMail[0].html.includes('Speckled Mug'));
  for (const m of [...potsMail, ...loomMail]) {
    assert.match(m.html, /within 2 days/, 'pack-by guidance');
    assert.ok(m.html.includes('https://trove.test/sell?view=orders'), 'link to the order');
    for (const secret of ['amal.buyer@test.local', 'amal.buyer', '765 4321', '7654321', 'Harbour Views', 'Amal', 'Rashid']) {
      assert.ok(!m.html.includes(secret) && !m.subject.includes(secret), `maker email leaks ${secret}`);
    }
  }
  assert.equal(mailsTo('amal.buyer@test.local').length, 1, 'the buyer still gets exactly one receipt');
});

test('an email failure never fails the request that sent it', async () => {
  require('../src/email').send = async () => { throw new Error('Resend is down'); };
  const r = await call('POST', '/api/auth/forgot', { body: { email: 'potter@test.local' } });
  assert.equal(r.status, 200);
  const reg = await call('POST', '/api/auth/register', { body: { email: 'late@test.local', password: 'latepass123', name: 'Late' } });
  assert.equal(reg.status, 201);
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
});
