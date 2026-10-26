'use strict';
/**
 * Sharjah on the supply side only (owner, 2026-10-26): makers and service
 * providers based in Sharjah can apply, open a shop and have the courier
 * collect from a Sharjah pickup address. Buyer delivery and service bookings
 * stay Dubai + Abu Dhabi; Ajman and the other emirates stay refused
 * everywhere. Seller Agreement v6 + Provider Agreement v5 say so.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ RATE_LIMIT_DISABLED: '1' });

const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const sa = require('../src/service-area');
const DOCS = path.join(__dirname, '..', '..', 'docs');
const LEGAL = path.join(__dirname, '..', 'legal');
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

let ctx, db, api, productId;

function mkShop(slug, extra = {}) {
  const { hashPassword } = require('../src/middleware');
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?, 'seller')")
    .run(`${slug}@test.local`, hashPassword('testpass123'), `${slug} owner`).lastInsertRowid;
  const id = db.prepare(`INSERT INTO shops (user_id,name,slug,status,tier,agreement_version,agreement_accepted_at,pickup_address,pickup_phone,location)
    VALUES (?,?,?, 'approved','consignment', 'v5', datetime('now'), 'Villa 9, Al Majaz 2, Sharjah', '+971501234567', 'Al Majaz, Sharjah')`).run(uid, slug, slug).lastInsertRowid;
  if (Object.keys(extra).length) db.prepare(`UPDATE shops SET ${Object.keys(extra).map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(extra), id);
  return { id: Number(id), email: `${slug}@test.local` };
}

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  api = ctx.api;
  const shop = mkShop('sharjah-loom');
  productId = Number(db.prepare("INSERT INTO products (shop_id,name,category,price_cents,stock,status) VALUES (?,?, 'Home & Living', 9000, 5, 'live')")
    .run(shop.id, 'Woven wall hanging').lastInsertRowid);
});
after(async () => { await ctx.close(); });

test('the two lists: makers in Dubai, Abu Dhabi or Sharjah; buyers in Dubai or Abu Dhabi', () => {
  assert.deepEqual(sa.SERVICE_AREAS, ['Dubai', 'Abu Dhabi'], 'buyer side unchanged');
  assert.deepEqual(sa.MAKER_AREAS, ['Dubai', 'Abu Dhabi', 'Sharjah']);
  for (const ok of ['Sharjah, UAE', 'Al Majaz, Sharjah', 'Villa 3, Al Nahda, Sharjah', 'Al Quoz, Dubai', 'Khalifa City, Abu Dhabi', 'فيلا 3، المجاز، الشارقة', 'القوز، دبي']) {
    assert.equal(sa.isMakerArea(ok), true, ok);
  }
  for (const no of ['Ajman, UAE', 'Al Jurf, Ajman', 'Al Nuaimiya, Ajman, near Sharjah', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain', 'Al Ain', 'عجمان', 'Sharjah<b>', '']) {
    assert.equal(sa.isMakerArea(no), false, no);
  }
  // Buyer delivery: Sharjah still refused, in every spelling the old rule caught.
  for (const a of [{ line: 'Villa 3', city: 'Al Majaz, Sharjah', emirate: 'Sharjah' }, { line: 'Villa 3, Sharjah', city: 'Dubai', emirate: 'Dubai' }, { line: 'Flat 2', city: 'الشارقة', emirate: 'Dubai' }]) {
    assert.equal(sa.isDeliverable(a), false, JSON.stringify(a));
  }
  assert.equal(sa.isServiceable('Sharjah'), false, 'the demand-side check never takes Sharjah');
});

test('a maker based in Sharjah can apply; Ajman is still refused', async () => {
  const body = (email, location) => ({
    role: 'seller', name: 'Sara Weaves', email, password: 'testpass123',
    shopName: `Loom ${email.split('@')[0]}`, location, about: 'Hand-woven wall hangings from my Al Majaz flat, dyed with plants.',
    instagram: '@saraweaves', phone: '+971501112233',
  });
  const ok = await api('POST', '/api/auth/register', { body: body('sara@test.local', 'Sharjah, UAE') });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(db.prepare("SELECT location FROM shops WHERE name='Loom sara'").get().location, 'Sharjah, UAE');
  const no = await api('POST', '/api/auth/register', { body: body('aisha@test.local', 'Ajman, UAE') });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /Dubai, Abu Dhabi and Sharjah only/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE email='aisha@test.local'").get().c, 0, 'no account left behind');
});

test('a Sharjah shop location and courier pickup are accepted; Ajman ones are not', async () => {
  const s = mkShop('pickup-sharjah', { pickup_address: '', location: 'Al Quoz, Dubai' });
  const cookie = await ctx.loginAs(s.email, 'testpass123');
  const patch = (body) => api('PATCH', '/api/seller/me', { cookie, body });
  assert.equal((await patch({ location: 'Al Majaz, Sharjah' })).status, 200);
  assert.equal((await patch({ pickupAddress: 'Villa 12, Al Majaz 2, Sharjah' })).status, 200);
  assert.equal((await patch({ pickupAddress: 'فيلا 12، المجاز، الشارقة' })).status, 200, 'typed in Arabic on /ar/sell');
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(s.id);
  assert.equal(shop.location, 'Al Majaz, Sharjah');
  let r = await patch({ location: 'Al Jurf, Ajman' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Dubai, Abu Dhabi and Sharjah only/);
  r = await patch({ pickupAddress: 'Villa 3, Al Rashidiya, Ajman' });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'pickup_area');
});

test('the courier is told the pickup is in Sharjah (OTO; Quiqup shares emirateOf); the buyer end stays Dubai/Abu Dhabi', () => {
  assert.equal(sa.emirateOf('Villa 12, Al Majaz 2, Sharjah'), 'Sharjah');
  assert.equal(sa.emirateOf('فيلا 12، المجاز، الشارقة'), 'Sharjah');
  assert.equal(sa.emirateOf('Al Qusais, near the Sharjah border, Dubai'), 'Dubai', 'the last emirate named wins');
  assert.equal(sa.emirateOf('Khalifa City, Abu Dhabi'), 'Abu Dhabi');
  assert.equal(sa.emirateOf('مدينة خليفة، أبوظبي'), 'Abu Dhabi');
  assert.equal(sa.emirateOf('Unit 5, Al Quoz 1'), 'Dubai', 'nothing named → Dubai, as before');
  const oto = require('../src/delivery/oto-live');
  const shop = { id: 7, name: 'Sara Weaves', pickup_address: 'Villa 12, Al Majaz 2, Sharjah', pickup_phone: '+971501112233', owner_name: 'Sara', owner_email: 'sara@test.local' };
  assert.equal(oto._location(shop).city, 'Sharjah');
  const order = oto._order({ id: 3, public_id: 'TRV-SHJ1', shipping_json: JSON.stringify({ name: 'Amal', line: 'Apt 4', city: 'Dubai Marina, Dubai', emirate: 'Dubai' }), buyer_phone: '+971501234567' }, shop, []);
  assert.equal(order.customer.city, 'Dubai', 'the buyer is in Dubai');
});

test('buyer delivery to Sharjah is still refused at checkout, even for a Sharjah maker’s piece', async () => {
  const checkout = (address) => api('POST', '/api/checkout', { body: { items: [{ productId, qty: 1 }], address, phone: '0501234567', email: 'guest@test.local' } });
  for (const address of [
    { name: 'Amal', line: 'Villa 3, Al Majaz', city: 'Al Majaz, Sharjah', emirate: 'Sharjah' },
    { name: 'Amal', line: 'Villa 3, Al Nahda, Sharjah', city: 'Al Nahda, Dubai', emirate: 'Dubai' },
    { name: 'Amal', line: 'Villa 3, Al Rashidiya', city: 'Al Rashidiya, Ajman', emirate: 'Ajman' },
  ]) {
    const r = await checkout(address);
    assert.equal(r.status, 400, JSON.stringify(address));
    assert.match(r.data.error, /We currently deliver in Dubai and Abu Dhabi only/);
  }
  // A Dubai buyer can order the same piece.
  const ok = await checkout({ name: 'Amal', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' });
  assert.notEqual(ok.status, 400, ok.text);
  // Saved account addresses follow the buyer rule too.
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer-shj@test.local',?,'B','buyer')").run(hashPassword('testpass123'));
  const cookie = await ctx.loginAs('buyer-shj@test.local', 'testpass123');
  assert.equal((await api('POST', '/api/account/addresses', { cookie, body: { name: 'B', line: 'Flat 2', city: 'Al Majaz, Sharjah' } })).status, 400);
  // …and the storefront keeps the same refusal list as the server.
  const store = read(path.join(DOCS, 'trove.html'));
  const client = store.match(/\nconst OTHER_EMIRATES=(\/.*\/i);/)[1];
  assert.ok(client.includes('sharjah') && client.includes('الشارقة'), 'checkout still refuses Sharjah in the page');
});

test('a provider based in Sharjah can apply; bookings still need a Dubai or Abu Dhabi customer', async () => {
  const APPLY = {
    name: 'Huda Clay', email: 'huda@test.local', password: 'testpass123', providerName: 'Huda Clay Workshops',
    categories: ['workshops'], location: 'Al Khan, Sharjah', about: 'Clay hand-building workshops at your place, for groups of up to eight.',
    instagram: '@hudaclay', phone: '+971501110000', agreeSub: true, agreeTerms: true,
  };
  const ok = await api('POST', '/api/services/apply', { body: APPLY });
  assert.equal(ok.status, 201, ok.text);
  const p = db.prepare("SELECT * FROM service_providers WHERE location='Al Khan, Sharjah'").get();
  assert.ok(p, 'the Sharjah practice exists');
  assert.equal(p.agreement_version, 'v5', 'Provider Agreement v5 recorded');
  const no = await api('POST', '/api/services/apply', { body: { ...APPLY, email: 'noor@test.local', providerName: 'Noor Ajman', location: 'Al Jurf, Ajman' } });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /Dubai, Abu Dhabi and Sharjah only/);
  // The booking side is unchanged: services.routes still checks the
  // customer's area with the demand-side rule.
  const src = read(path.join(__dirname, '..', 'src', 'routes', 'services.routes.js'));
  assert.match(src, /if \(!isServiceable\(b\.area\)\)/);
});

test('Seller Agreement v6 and Provider Agreement v5: Sharjah, Didit, Arabic twins, re-acceptance prompt', async () => {
  const cfg = require('../src/config');
  assert.equal(cfg.AGREEMENT_VERSION, 'v6');
  assert.equal(cfg.AGREEMENT_MIN_SELLING_VERSION, 'v4', 'no money term changed, so nobody is taken off sale');
  assert.equal(cfg.PROVIDER_AGREEMENT_VERSION, 'v5');
  const seller = await api('GET', '/api/legal/seller-agreement');
  assert.equal(seller.data.version, 'v6');
  const flat = seller.data.markdown.replace(/\s+/g, ' ');
  assert.match(flat, /based in \*\*Dubai, Abu Dhabi or Sharjah\*\*/);
  assert.match(flat, /customers in \*\*Dubai and Abu Dhabi only\*\*; it does not deliver to Sharjah/);
  assert.match(flat, /online identity check through Didit/);
  assert.match(flat, /live selfie/);
  assert.match(flat, /does not keep your ID images or your selfie/);
  assert.match(flat, /Serein Consultancy LLC/);
  for (const f of ['seller-agreement-v6.md', 'seller-agreement-v6-ar.md', 'provider-agreement-v5.md', 'provider-agreement-v5-ar.md']) {
    assert.ok(fs.existsSync(path.join(LEGAL, f)), f);
  }
  assert.match(read(path.join(LEGAL, 'seller-agreement-v6-ar.md')), /الشارقة/);
  assert.match(read(path.join(LEGAL, 'seller-agreement-v6-ar.md')), /Didit/);
  assert.doesNotMatch(read(path.join(LEGAL, 'seller-agreement-v5.md')), /Sharjah,|Didit/, 'v5 stays as signed');
  const provider = await api('GET', '/api/legal/provider-agreement');
  assert.equal(provider.data.version, 'v5');
  assert.match(provider.data.markdown.replace(/\s+/g, ' '), /customers in \*\*Dubai and Abu Dhabi only\*\*/);
  assert.ok((await api('GET', '/api/legal/seller-agreement?lang=ar')).data.arabic, 'Arabic convenience translation served');

  // A maker on v5 keeps selling and is asked to accept v6.
  const s = mkShop('v5-maker');
  const cookie = await ctx.loginAs(s.email, 'testpass123');
  const me = (await api('GET', '/api/seller/me', { cookie })).data.shop;
  assert.equal(me.agreementUpdateDue, true);
  assert.equal(me.sellingPaused, false);
  assert.equal(me.currentAgreementVersion, 'v6');
  assert.match(me.agreementChangeNote, /Sharjah/);
  const ar = JSON.parse(read(path.join(DOCS, 'i18n', 'ar', 'seller.json')));
  assert.ok(ar[me.agreementChangeNote], 'the change note has its Arabic');
});

test('public copy: who can sell says Sharjah, delivery still says Dubai and Abu Dhabi', async () => {
  const faq = await api('GET', '/faq');
  const text = faq.text.replace(/\s+/g, ' ');
  assert.match(text, /Makers in Dubai, Abu Dhabi and Sharjah who make their pieces themselves/);
  assert.match(text, /To addresses in Dubai and Abu Dhabi only\./, 'buyer delivery answer unchanged');
  const about = (await api('GET', '/about')).text.replace(/\s+/g, ' ');
  assert.match(about, /Trove delivers to <strong>Dubai and Abu Dhabi<\/strong>/);
  assert.match(about, /based in <strong>Dubai, Abu Dhabi and Sharjah<\/strong>/);
  const apply = read(path.join(DOCS, 'trove-apply.html'));
  assert.match(apply, /<option value="Sharjah, UAE">Sharjah, UAE<\/option>/);
  assert.doesNotMatch(apply, /We're open in Dubai &amp; Abu Dhabi/);
  const content = require('../src/content');
  const items = (content.DEFAULTS || content.defaults || {})['sell.faq'];
  if (items) assert.ok(items.items.some((i) => i.q === 'Where do I need to be based?'));
  const sellPage = (await api('GET', '/sell-on-trove')).text;
  assert.match(sellPage, /Where do I need to be based\?/);
  // Buyer-facing promo bar and checkout copy keep the two emirates.
  assert.match(read(path.join(DOCS, 'trove.html')), /Delivering across Dubai &amp; Abu Dhabi/);
  const arApply = JSON.parse(read(path.join(DOCS, 'i18n', 'ar', 'apply.json')));
  assert.equal(arApply['Sharjah, UAE'], 'الشارقة، الإمارات');
});
