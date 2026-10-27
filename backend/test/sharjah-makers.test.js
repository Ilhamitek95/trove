'use strict';
/**
 * Sharjah, supply side first (owner, 2026-10-26): makers and service
 * providers based in Sharjah can apply, open a shop and have the courier
 * collect from a Sharjah pickup address. Then the demand side (owner,
 * 2026-10-27, "oto does deliver to sharjah"): buyers in Sharjah can order and
 * book services, at the same delivery price. Ajman and the other emirates stay
 * refused everywhere.
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

test('the two lists: makers and buyers both in Dubai, Abu Dhabi or Sharjah', () => {
  assert.deepEqual(sa.SERVICE_AREAS, ['Dubai', 'Abu Dhabi', 'Sharjah'], 'buyers in Sharjah since 2026-10-27');
  assert.deepEqual(sa.MAKER_AREAS, ['Dubai', 'Abu Dhabi', 'Sharjah']);
  assert.equal(sa.AREA_LIST, 'Dubai, Abu Dhabi and Sharjah');
  for (const ok of ['Sharjah, UAE', 'Al Majaz, Sharjah', 'Villa 3, Al Nahda, Sharjah', 'Al Quoz, Dubai', 'Khalifa City, Abu Dhabi', 'فيلا 3، المجاز، الشارقة', 'القوز، دبي']) {
    assert.equal(sa.isMakerArea(ok), true, ok);
  }
  for (const no of ['Ajman, UAE', 'Al Jurf, Ajman', 'Al Nuaimiya, Ajman, near Sharjah', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain', 'Al Ain', 'عجمان', 'Sharjah<b>', '']) {
    assert.equal(sa.isMakerArea(no), false, no);
  }
  // Buyer delivery: Sharjah addresses go through; the other four emirates
  // are still refused, even with Dubai in the Emirate box.
  for (const a of [{ line: 'Villa 3', city: 'Al Majaz, Sharjah', emirate: 'Sharjah' }, { line: 'Flat 2', city: 'الشارقة', emirate: 'Sharjah' }, { line: 'Apt 4', city: 'Al Nahda, Sharjah' }]) {
    assert.equal(sa.isDeliverable(a), true, JSON.stringify(a));
  }
  for (const a of [{ line: 'Villa 3, Ajman', city: 'Dubai', emirate: 'Dubai' }, { line: 'Flat 2', city: 'عجمان', emirate: 'Dubai' }, { line: 'Villa 3', city: 'Al Jurf, Ajman', emirate: 'Ajman' }]) {
    assert.equal(sa.isDeliverable(a), false, JSON.stringify(a));
  }
  assert.equal(sa.isServiceable('Sharjah'), true);
  assert.equal(sa.isServiceable('Ajman'), false);
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

test('buyers in Sharjah can order (2026-10-27); Ajman is still refused at checkout', async () => {
  const checkout = (address) => api('POST', '/api/checkout', { body: { items: [{ productId, qty: 1 }], address, phone: '0501234567', email: 'guest@test.local' } });
  for (const address of [
    { name: 'Amal', line: 'Villa 3, Al Rashidiya', city: 'Al Rashidiya, Ajman', emirate: 'Ajman' },
    { name: 'Amal', line: 'Villa 3, Al Jurf, Ajman', city: 'Al Nahda, Dubai', emirate: 'Dubai' },
    { name: 'Amal', line: 'Villa 3', city: 'Fujairah', emirate: 'Fujairah' },
  ]) {
    const r = await checkout(address);
    assert.equal(r.status, 400, JSON.stringify(address));
    assert.match(r.data.error, /We currently deliver in Dubai, Abu Dhabi and Sharjah only/);
  }
  // A Sharjah buyer and a Dubai buyer can both order the same piece.
  for (const address of [
    { name: 'Amal', line: 'Villa 3, Al Majaz', city: 'Al Majaz, Sharjah', emirate: 'Sharjah' },
    { name: 'Amal', line: 'Apt 4, Harbour Views', city: 'Dubai Marina, Dubai', emirate: 'Dubai' },
  ]) {
    const ok = await checkout(address);
    assert.notEqual(ok.status, 400, ok.text);
  }
  // The courier is told the buyer is in Sharjah.
  const oto = require('../src/delivery/oto-live');
  const shop = { id: 7, name: 'Sara Weaves', pickup_address: 'Villa 12, Al Barsha 1, Dubai', pickup_phone: '+971501112233', owner_name: 'Sara', owner_email: 'sara@test.local' };
  const order = oto._order({ id: 4, public_id: 'TRV-SHJ2', shipping_json: JSON.stringify({ name: 'Amal', line: 'Villa 3', city: 'Al Majaz, Sharjah', emirate: 'Sharjah' }), buyer_phone: '+971501234567' }, shop, []);
  assert.equal(order.customer.city, 'Sharjah');
  // Saved account addresses follow the buyer rule too.
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('buyer-shj@test.local',?,'B','buyer')").run(hashPassword('testpass123'));
  const cookie = await ctx.loginAs('buyer-shj@test.local', 'testpass123');
  assert.ok([200, 201].includes((await api('POST', '/api/account/addresses', { cookie, body: { name: 'B', line: 'Flat 2', city: 'Al Majaz, Sharjah' } })).status));
  assert.equal((await api('POST', '/api/account/addresses', { cookie, body: { name: 'B', line: 'Flat 2', city: 'Al Jurf, Ajman' } })).status, 400);
  // …and the pages offer Sharjah and keep the same refusal list as the server.
  const store = read(path.join(DOCS, 'trove.html'));
  const client = store.match(/\nconst OTHER_EMIRATES=(\/.*\/i);/)[1];
  assert.ok(!client.includes('sharjah') && !client.includes('الشارقة') && client.includes('ajman'), 'checkout takes Sharjah in the page');
  assert.match(store, /const inServiceArea=city=>\/\(dubai\|abu dhabi\|sharjah\)\/i/);
  assert.match(store, /<option value="Sharjah">\$\{_t\('Sharjah'\)\}<\/option><\/select>/, 'checkout emirate list');
  for (const f of ['trove-account.html', 'trove-services.html']) {
    assert.match(read(path.join(DOCS, f)), /<option value="Sharjah"[^>]*>\$\{_t\('Sharjah'\)\}<\/option><\/select>/, f);
  }
  assert.match(read(path.join(DOCS, 'trove-admin.html')), /<select id="dvEmirate"><option>Dubai<\/option><option>Abu Dhabi<\/option><option>Sharjah<\/option><\/select>/);
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
  assert.equal(p.agreement_version, 'v6', 'Provider Agreement v6 recorded');
  const no = await api('POST', '/api/services/apply', { body: { ...APPLY, email: 'noor@test.local', providerName: 'Noor Ajman', location: 'Al Jurf, Ajman' } });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /Dubai, Abu Dhabi and Sharjah only/);
  // The booking side is unchanged: services.routes still checks the
  // customer's area with the demand-side rule.
  const src = read(path.join(__dirname, '..', 'src', 'routes', 'services.routes.js'));
  assert.match(src, /if \(!isServiceable\(b\.area\)\)/);
});

test('Seller Agreement v6/v7 and Provider Agreement v5/v6: Sharjah, Didit, Arabic twins, re-acceptance prompt', async () => {
  const cfg = require('../src/config');
  // v7 / v6 (owner, 27 Oct): customers in Sharjah can buy and book too.
  assert.equal(cfg.AGREEMENT_VERSION, 'v7');
  assert.equal(cfg.AGREEMENT_MIN_SELLING_VERSION, 'v4', 'no money term changed, so nobody is taken off sale');
  assert.equal(cfg.PROVIDER_AGREEMENT_VERSION, 'v6');
  const seller = await api('GET', '/api/legal/seller-agreement');
  assert.equal(seller.data.version, 'v7');
  const flat = seller.data.markdown.replace(/\s+/g, ' ');
  assert.match(flat, /based in \*\*Dubai, Abu Dhabi or Sharjah\*\*/);
  assert.match(flat, /Trove resells your pieces to customers in \*\*Dubai, Abu Dhabi and Sharjah only\*\*; it does not deliver anywhere else\./);
  assert.doesNotMatch(flat, /does not deliver to Sharjah|Dubai and Abu Dhabi only/);
  assert.match(flat, /online identity check through Didit/);
  assert.match(flat, /live selfie/);
  assert.match(flat, /does not keep your ID images or your selfie/);
  assert.match(flat, /Serein Consultancy LLC/);
  for (const f of ['seller-agreement-v6.md', 'seller-agreement-v6-ar.md', 'seller-agreement-v7.md', 'seller-agreement-v7-ar.md',
    'provider-agreement-v5.md', 'provider-agreement-v5-ar.md', 'provider-agreement-v6.md', 'provider-agreement-v6-ar.md']) {
    assert.ok(fs.existsSync(path.join(LEGAL, f)), f);
  }
  const flatFile = (f) => read(path.join(LEGAL, f)).replace(/\s+/g, ' ');
  // Only the version line and the customer-area sentence differ from v6.
  const sellerV6 = flatFile('seller-agreement-v6.md');
  assert.match(sellerV6, /customers in \*\*Dubai and Abu Dhabi only\*\*; it does not deliver to Sharjah/, 'v6 stays as signed');
  const sellerStrip = (s) => s.replace(/\*\*Version v\d+ · [^*]+\*\*/, '').replace(/Trove resells your pieces to customers in .*? anywhere else\./, '');
  assert.equal(sellerStrip(flatFile('seller-agreement-v7.md')), sellerStrip(sellerV6), 'nothing else changed in the Seller Agreement');
  const sellerAr = flatFile('seller-agreement-v7-ar.md');
  assert.match(sellerAr, /\(الإصدار v7\)/);
  assert.match(sellerAr, /\*\*دبي وأبوظبي والشارقة فقط\*\*/);
  assert.doesNotMatch(sellerAr, /ولا توصل إلى الشارقة/);
  assert.match(sellerAr, /Didit/);
  assert.match(sellerAr, /يُعتدّ بالنص الإنجليزي/, 'the English version prevails');
  assert.doesNotMatch(read(path.join(LEGAL, 'seller-agreement-v5.md')), /Sharjah,|Didit/, 'v5 stays as signed');
  const provider = await api('GET', '/api/legal/provider-agreement');
  assert.equal(provider.data.version, 'v6');
  const pflat = provider.data.markdown.replace(/\s+/g, ' ');
  assert.match(pflat, /Bookings are taken from customers in \*\*Dubai, Abu Dhabi and Sharjah only\*\*\. A service at your own studio/);
  assert.doesNotMatch(pflat, /If you are based in Sharjah|Dubai and Abu Dhabi only/);
  const providerV5 = flatFile('provider-agreement-v5.md');
  assert.match(providerV5, /customers in \*\*Dubai and Abu Dhabi only\*\*\. If you are based in Sharjah/, 'v5 stays as signed');
  const providerStrip = (s) => s.replace(/\*\*Version v\d+ · [^*]+\*\*/, '').replace(/Bookings are taken from customers in .*?(?= A service at your own studio)/, '');
  assert.equal(providerStrip(flatFile('provider-agreement-v6.md')), providerStrip(providerV5), 'nothing else changed in the Provider Agreement');
  const providerAr = flatFile('provider-agreement-v6-ar.md');
  assert.match(providerAr, /\(الإصدار v6\)/);
  assert.match(providerAr, /\*\*دبي وأبوظبي والشارقة فقط\*\*/);
  assert.doesNotMatch(providerAr, /فإذا كان مقرّك في الشارقة/);
  assert.ok((await api('GET', '/api/legal/seller-agreement?lang=ar')).data.arabic, 'Arabic convenience translation served');
  assert.ok((await api('GET', '/api/legal/provider-agreement?lang=ar')).data.arabic, 'Arabic convenience translation served');

  // Makers on v5 and v6 keep selling and are asked to accept v7.
  for (const [slug, v] of [['v5-maker', 'v5'], ['v6-maker', 'v6']]) {
    const s = mkShop(slug, { agreement_version: v });
    const cookie = await ctx.loginAs(s.email, 'testpass123');
    const me = (await api('GET', '/api/seller/me', { cookie })).data.shop;
    assert.equal(me.agreementUpdateDue, true, v);
    assert.equal(me.sellingPaused, false, v);
    assert.equal(me.currentAgreementVersion, 'v7');
    assert.match(me.agreementChangeNote, /customers in Dubai, Abu Dhabi and Sharjah/);
    assert.match(me.agreementChangeNote, /margin, fortnightly runs and the return window do not change/);
    const ar = JSON.parse(read(path.join(DOCS, 'i18n', 'ar', 'seller.json')));
    assert.ok(ar[me.agreementChangeNote], 'the change note has its Arabic');
  }
});

test('public copy: who can sell and where Trove delivers both say Dubai, Abu Dhabi and Sharjah', async () => {
  const faq = await api('GET', '/faq');
  const text = faq.text.replace(/\s+/g, ' ');
  assert.match(text, /Makers in Dubai, Abu Dhabi and Sharjah who make their pieces themselves/);
  assert.match(text, /To addresses in Dubai, Abu Dhabi and Sharjah only\./, 'buyer delivery answer');
  const about = (await api('GET', '/about')).text.replace(/\s+/g, ' ');
  assert.match(about, /Trove delivers to <strong>Dubai, Abu Dhabi and Sharjah<\/strong>/);
  assert.match(about, /based in <strong>Dubai, Abu Dhabi and Sharjah<\/strong>/);
  const apply = read(path.join(DOCS, 'trove-apply.html'));
  assert.match(apply, /<option value="Sharjah, UAE">Sharjah, UAE<\/option>/);
  assert.doesNotMatch(apply, /We're open in Dubai &amp; Abu Dhabi/);
  const content = require('../src/content');
  const items = (content.DEFAULTS || content.defaults || {})['sell.faq'];
  if (items) assert.ok(items.items.some((i) => i.q === 'Where do I need to be based?'));
  const sellPage = (await api('GET', '/sell-on-trove')).text;
  assert.match(sellPage, /Where do I need to be based\?/);
  // Buyer-facing promo bar and checkout copy name all three, and no page or
  // server copy file still says two (2026-10-27).
  assert.match(read(path.join(DOCS, 'trove.html')), /Delivering across Dubai, Abu Dhabi &amp; Sharjah/);
  const two = /Dubai (&amp;|&|and|or|\+) Abu Dhabi/;
  for (const f of fs.readdirSync(DOCS).filter((n) => /\.(html|js)$/.test(n))) assert.doesNotMatch(read(path.join(DOCS, f)), two, f);
  for (const f of ['seo.js', 'site-pages.js', 'content.js', 'email.js', path.join('pages', 'facts.js'), path.join('pages', 'about.js'), path.join('pages', 'faq.js')]) {
    assert.doesNotMatch(read(path.join(__dirname, '..', 'src', f)), two, f);
  }
  const arStore = JSON.parse(read(path.join(DOCS, 'i18n', 'ar', 'storefront.json')));
  assert.equal(arStore['We deliver in Dubai, Abu Dhabi and Sharjah only for now.'], 'نوصل حالياً إلى دبي وأبوظبي والشارقة فقط.');
  // A saved promo bar with the old shipped wording is rewritten (migration 029).
  db.prepare("INSERT OR REPLACE INTO site_content (section, value) VALUES ('site.promo', ?)").run(JSON.stringify({ text: 'Delivering across Dubai & Abu Dhabi · Delivery AED 30, free on orders over AED 200' }));
  require('../src/migrations/029-sharjah-buyers-copy').up(db);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='site.promo'").get().value).text, 'Delivering across Dubai, Abu Dhabi & Sharjah · Delivery AED 30, free on orders over AED 200');
  const arApply = JSON.parse(read(path.join(DOCS, 'i18n', 'ar', 'apply.json')));
  assert.equal(arApply['Sharjah, UAE'], 'الشارقة، الإمارات');
});
