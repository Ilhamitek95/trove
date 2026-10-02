'use strict';
/**
 * Automatic Arabic for what people create (src/translate.js), against a fake
 * Claude client — no network, no key:
 *   - a save queues the piece; the worker stores Arabic keyed by the English
 *     it came from; /api/products?lang=ar serves it, English stays English
 *   - a changed English source makes the Arabic stale: the page shows the
 *     English and the sweep re-queues it
 *   - a hand-edited (locked) Arabic text is never overwritten
 *   - the daily budget stops the worker
 *   - emails and phone numbers never reach the API (and come back intact)
 *   - an API failure never fails a save and leaves the English showing
 *   - no client at all: nothing queued is sent, nothing breaks
 *   - the admin's Translations endpoints
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ TRANSLATE_AUTORUN: '0', TRANSLATE_DAILY_BUDGET_USD: '5' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, tr, sellerCookie, adminCookie, pid, shopId;
const calls = [];
let mode = 'ok';

const fake = {
  messages: {
    async create(req) {
      calls.push(req);
      if (mode === 'fail') throw new Error('overloaded');
      const fields = JSON.parse(req.messages[0].content.split('Fields to translate (JSON):\n')[1]);
      const translations = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `عربي: ${v}`]));
      if (mode === 'droptoken') for (const k of Object.keys(translations)) translations[k] = translations[k].replace(/⟦\d+⟧/g, '');
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ translations }) }],
        usage: { input_tokens: 1000, output_tokens: 1000 },
      };
    },
  },
};

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  tr = require('../src/translate');
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  const seller = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('maker@test.local',?, 'Maker','seller')").run(pw).lastInsertRowid;
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status,tier,bio,location) VALUES (?,?,?, 'approved','consignment',?,?)")
    .run(seller, 'Test Pots', 'test-pots', 'We throw small batches of stoneware.', 'Al Quoz, Dubai').lastInsertRowid;
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('boss@test.local',?, 'Boss','admin')").run(pw);
  sellerCookie = await ctx.loginAs('maker@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('boss@test.local', 'testpass123');
});
after(async () => { tr._reset(); await ctx.close(); });

test('without a client nothing is sent and the Arabic page shows the English', async () => {
  assert.equal(tr.enabled(), false);
  const res = await ctx.api('POST', '/api/seller/products', { cookie: sellerCookie, body: {
    name: 'Speckled Mug', description: 'A mug for slow mornings.', category: 'Ceramics', price: 60, stock: 4, status: 'live',
    options: [{ name: 'Glaze', values: ['Sand', 'Sea'] }], extras: [{ name: 'Gift wrap', priceCents: 1500 }] } });
  assert.equal(res.status, 201, res.text);
  pid = res.data.product.id;
  assert.equal(await tr.drain(), 0, 'the worker does nothing without a client');
  const p = (await ctx.api('GET', `/api/products/${pid}?lang=ar`)).data.product;
  assert.equal(p.name, 'Speckled Mug');
  assert.deepEqual(p.optionLabels, {});
});

test('a saved piece is translated in the background and served in Arabic', async () => {
  tr._setClient(fake);
  assert.ok(db.prepare("SELECT 1 FROM translation_queue WHERE entity='product' AND entity_id=?").get(String(pid)), 'the save queued it');
  await tr.drain();
  assert.ok(calls.length >= 1);
  const req = calls[calls.length - 1];
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  const ar = (await ctx.api('GET', `/api/products/${pid}?lang=ar`)).data.product;
  assert.equal(ar.name, 'عربي: Speckled Mug');
  assert.equal(ar.description, 'عربي: A mug for slow mornings.');
  assert.equal(ar.optionLabels.Glaze, 'عربي: Glaze');
  assert.equal(ar.optionLabels['Glaze:Sand'], 'عربي: Sand');
  assert.equal(ar.extraLabels['Gift wrap'], 'عربي: Gift wrap');
  assert.deepEqual(ar.options, [{ name: 'Glaze', values: ['Sand', 'Sea'] }], 'option values stay the English keys checkout matches on');
  assert.equal(ar.translated, true);
  // The same answer with the header docs/api.js sends.
  const viaHeader = (await ctx.api('GET', `/api/products/${pid}`, { headers: { 'X-Trove-Lang': 'ar' } })).data.product;
  assert.equal(viaHeader.name, 'عربي: Speckled Mug');
  const en = (await ctx.api('GET', `/api/products/${pid}`)).data.product;
  assert.equal(en.name, 'Speckled Mug', 'English readers are untouched');
  assert.equal(en.optionLabels, undefined);
  // Arabic search finds it.
  const found = (await ctx.api('GET', `/api/products?q=${encodeURIComponent('عربي')}&lang=ar`)).data.products.map((x) => x.id);
  assert.ok(found.includes(pid));
});

test('a changed English source shows English again and is re-queued', async () => {
  await ctx.api('PATCH', `/api/seller/products/${pid}`, { cookie: sellerCookie, body: { name: 'Speckled Stoneware Mug' } });
  const ar = (await ctx.api('GET', `/api/products/${pid}?lang=ar`)).data.product;
  assert.equal(ar.name, 'Speckled Stoneware Mug', 'stale Arabic is never shown');
  assert.equal(ar.description, 'عربي: A mug for slow mornings.', 'unchanged fields keep their Arabic');
  assert.deepEqual(tr.needs('product', pid), ['name']);
  db.prepare('DELETE FROM translation_queue').run();
  assert.ok(tr.sweep() >= 1, 'the sweep finds it');
  const before = calls.length;
  await tr.drain();
  const sent = JSON.parse(calls[before].messages[0].content.split('Fields to translate (JSON):\n')[1]);
  assert.deepEqual(Object.keys(sent), ['name'], 'only the changed field is sent again');
  assert.equal((await ctx.api('GET', `/api/products/${pid}?lang=ar`)).data.product.name, 'عربي: Speckled Stoneware Mug');
});

test('a hand-edited Arabic text is locked: the machine never overwrites it', async () => {
  const res = await ctx.api('PUT', `/api/admin/translations/product/${pid}`, { cookie: adminCookie, body: { field: 'name', text: 'كوب منقّط' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.fields.name.status, 'locked');
  tr.retranslate('product', pid);
  await tr.drain();
  assert.equal((await ctx.api('GET', `/api/products/${pid}?lang=ar`)).data.product.name, 'كوب منقّط');
  await tr.translateEntity('product', pid);
  assert.equal(db.prepare("SELECT text FROM translations WHERE entity='product' AND entity_id=? AND field='name'").get(String(pid)).text, 'كوب منقّط');
  // Its English changes: the page shows English and the admin list asks for an update.
  await ctx.api('PATCH', `/api/seller/products/${pid}`, { cookie: sellerCookie, body: { name: 'Speckled Mug, large' } });
  assert.equal((await ctx.api('GET', `/api/products/${pid}?lang=ar`)).data.product.name, 'Speckled Mug, large');
  assert.equal(tr.fieldStatus('product', pid).name.status, 'locked-stale');
  assert.ok(!tr.needs('product', pid).includes('name'), 'the machine still leaves it alone');
  // Unlock hands it back.
  await ctx.api('POST', `/api/admin/translations/product/${pid}/lock`, { cookie: adminCookie, body: { field: 'name', locked: false } });
  assert.ok(tr.needs('product', pid).includes('name'));
});

test('personal data never reaches the API, and comes back intact', async () => {
  await ctx.api('PATCH', '/api/seller/me', { cookie: sellerCookie, body: { bio: 'Commissions welcome: write to mara@kiln.ae or call +971 50 123 4567. Pieces from AED 120.' } });
  const before = calls.length;
  await tr.drain();
  const sent = calls.slice(before).map((c) => c.messages[0].content).join('\n');
  assert.doesNotMatch(sent, /mara@kiln\.ae/);
  assert.doesNotMatch(sent, /123 4567/);
  assert.match(sent, /AED 120/, 'prices are not mistaken for phone numbers');
  const shop = (await ctx.api('GET', '/api/shops/test-pots?lang=ar')).data.shop;
  assert.match(shop.bio, /^عربي: /);
  assert.match(shop.bio, /mara@kiln\.ae/);
  assert.match(shop.bio, /\+971 50 123 4567/);
  assert.equal(shop.name, 'Test Pots', 'shop names are never translated');
  // A reply that loses a token is thrown away rather than losing the detail.
  mode = 'droptoken';
  await ctx.api('PATCH', '/api/seller/me', { cookie: sellerCookie, body: { bio: 'Email hello@pots.ae for custom sets.' } });
  await tr.drain();
  mode = 'ok';
  assert.equal((await ctx.api('GET', '/api/shops/test-pots?lang=ar')).data.shop.bio, 'Email hello@pots.ae for custom sets.');
  assert.deepEqual(tr.scrub('Ring 050 123 4567 or a@b.co, 30 x 40 cm, AED 1,250').kept, ['a@b.co', '050 123 4567']);
});

test('an API failure never fails a save and leaves the English showing', async () => {
  mode = 'fail';
  const res = await ctx.api('PATCH', `/api/seller/products/${pid}`, { cookie: sellerCookie, body: { description: 'Now in three sizes.' } });
  assert.equal(res.status, 200, res.text);
  await tr.drain();
  mode = 'ok';
  const q = db.prepare("SELECT * FROM translation_queue WHERE entity='product' AND entity_id=?").get(String(pid));
  assert.ok(q && q.attempts === 1 && /overloaded/.test(q.last_error), 'the failure is recorded for a retry');
  assert.equal((await ctx.api('GET', `/api/products/${pid}?lang=ar`)).data.product.description, 'Now in three sizes.');
});

test('the daily budget stops the worker', async () => {
  // 1000 in + 1000 out tokens at $2/$10 per million = $0.012 per call.
  process.env.TRANSLATE_DAILY_BUDGET_USD = String(tr.spentToday() + 0.001);
  db.prepare('UPDATE translation_queue SET next_at=NULL').run();
  await ctx.api('PATCH', '/api/seller/me', { cookie: sellerCookie, body: { bio: 'A new story.' } });
  const before = calls.length;
  await tr.drain();
  assert.equal(calls.length, before + 1, 'one call takes the day over budget');
  await ctx.api('PATCH', '/api/seller/me', { cookie: sellerCookie, body: { bio: 'Another story.' } });
  await tr.drain();
  assert.equal(calls.length, before + 1, 'nothing more is sent today');
  assert.ok(db.prepare("SELECT 1 FROM translation_queue WHERE entity='shop'").get(), 'the work waits in the queue');
  process.env.TRANSLATE_DAILY_BUDGET_USD = '5';
});

test('admin content overrides are translated; the shipped wording comes from the dictionary', async () => {
  const content = require('../src/content');
  const promo = { text: 'Ramadan hours: orders placed after 8pm leave the next day' };
  assert.equal((await ctx.api('PUT', '/api/admin/content/site.promo', { cookie: adminCookie, body: promo })).status, 200);
  await tr.drain();
  const ar = (await ctx.api('GET', '/api/content?lang=ar')).data;
  assert.equal(ar.site.promo.text, 'عربي: Ramadan hours: orders placed after 8pm leave the next day');
  assert.equal(ar.site.footer.blurb, require('../src/i18n').dict('ar')[content.DEFAULTS['site.footer'].blurb], 'shipped wording is the hand-written Arabic');
  const en = (await ctx.api('GET', '/api/content')).data;
  assert.equal(en.site.promo.text, promo.text);
});

test('the admin Translations list: admins only, with statuses', async () => {
  assert.equal((await ctx.api('GET', '/api/admin/translations', { cookie: sellerCookie })).status, 403);
  const res = await ctx.api('GET', '/api/admin/translations', { cookie: adminCookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.enabled, true);
  const row = res.data.rows.find((r) => r.entity === 'product' && r.id === String(pid));
  assert.ok(row && row.label.includes('Test Pots'));
  const one = await ctx.api('GET', `/api/admin/translations/product/${pid}`, { cookie: adminCookie });
  assert.equal(one.status, 200);
  assert.ok(one.data.fields.description);
  assert.equal((await ctx.api('GET', '/api/admin/translations/bogus/1', { cookie: adminCookie })).status, 404);
  const sweep = await ctx.api('POST', '/api/admin/translations/sweep', { cookie: adminCookie });
  assert.equal(sweep.status, 200);
});
