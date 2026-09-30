'use strict';
/**
 * One-time QA cleanup (src/qa-cleanup.js): only the ilhamitek95+trove-qa-*
 * test data goes; real accounts, shops, orders and providers — including
 * look-alikes — survive; anything where money moved is skipped and reported.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { testEnv, startApp } = require('./helpers');
const BACKUPS = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-qa-backups-'));
testEnv({ ADMIN_EMAIL: 'ilhamitek95@gmail.com', BACKUPS_DIR: BACKUPS });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
require('../src/session-store');
require('../src/seed'); // realistic catalogue: 7 shops, pieces, providers, a paid order with ledger rows
const qa = require('../src/qa-cleanup');
const { hashPassword } = require('../src/middleware');

const UP = process.env.UPLOADS_DIR;
const PRIV = process.env.PRIVATE_DIR;
const quiet = { log() {}, error() {} };
const count = (t, where = '1', ...a) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`).get(...a).n;
function touch(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file; }
const pw = hashPassword('testpass123');
const mkUser = (email, role = 'buyer', name = 'X') =>
  db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)').run(email, pw, name, role).lastInsertRowid;
let seq = 0;
function mkOrder({ email, buyer = null, status = 'pending', pi = null, items = [], publicId }) {
  const id = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,total_cents,status,stripe_payment_intent_id)
    VALUES (?,?,?,?,?,?,?)`).run(publicId || `TRV-T${++seq}`, buyer, email, 9400, 9400, status, pi).lastInsertRowid;
  for (const p of items) {
    db.prepare('INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty) VALUES (?,?,?,?,?,1)')
      .run(id, p.id, p.shop_id, p.name, p.price_cents);
  }
  return id;
}
const mkShop = (uid, name, slug, extra = {}) => db.prepare(`INSERT INTO shops (user_id,name,slug,status,image,license_image,eid_front_file,eid_back_file,payout_bank_name,payout_account_name,iban_masked,agreement_version,agreement_accepted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(uid, name, slug, extra.status || 'pending', extra.image || '', extra.license || '',
  extra.eidF || null, extra.eidB || null, 'Fake Bank', 'QA Test', 'AE** **** 1234', 'v4').lastInsertRowid;
const mkProduct = (shopId, name, images = []) => db.prepare(`INSERT INTO products (shop_id,name,price_cents,stock,status,images)
  VALUES (?,?,9400,3,'live',?)`).run(shopId, name, JSON.stringify(images)).lastInsertRowid;
const product = (id) => db.prepare('SELECT * FROM products WHERE id=?').get(id);

let ctx, ids = {}, files = {}, realBefore = {};

before(async () => {
  ctx = await startApp();
  ctx.stripeMock.reset();

  /* ---- real people and things that must survive ---- */
  ids.admin = mkUser('ilhamitek95@gmail.com', 'admin', 'Owner');
  ids.plusOther = mkUser('ilhamitek95+other@gmail.com', 'buyer', 'Real plus');
  ids.noSuffix = mkUser('ilhamitek95+trove-qa@gmail.com', 'buyer', 'No suffix');   // pattern needs trove-qa-<something>
  ids.prefixed = mkUser('xilhamitek95+trove-qa-1@gmail.com', 'buyer', 'Prefixed');
  ids.qaAdmin = mkUser('ilhamitek95+trove-qa-admin@gmail.com', 'admin', 'QA admin');  // admin: never removed
  ids.realMaker = mkUser('maker@real.ae', 'seller', 'Real maker');
  ids.realLookalikeShop = mkShop(ids.realMaker, 'QA TEST lookalike', 'qa-test-lookalike', { status: 'approved' }); // not QA-owned
  const kilnMug = db.prepare("SELECT * FROM products WHERE name='Reeded Stoneware Mug'").get();
  ids.kilnMug = kilnMug.id;
  ids.realPendingOrder = mkOrder({ email: 'ilhamitek95+other@gmail.com', buyer: ids.plusOther, items: [kilnMug], publicId: 'TRV-REAL01' });
  ids.realPaidOrder = mkOrder({ email: 'someone@real.ae', status: 'paid', items: [kilnMug], publicId: 'TRV-REAL02' });
  files.realImg = touch(path.join(UP, 'products', 'prod-real-mug.jpg'));
  db.prepare('UPDATE products SET images=? WHERE id=?').run(JSON.stringify(['/uploads/products/prod-real-mug.jpg']), kilnMug.id);
  files.orphan = touch(path.join(UP, 'products', 'orphan.jpg'));

  /* ---- the QA entities from 2026-09-30 ---- */
  ids.seller = mkUser('ilhamitek95+trove-qa-seller-1@gmail.com', 'seller', 'QA TEST Seller');
  ids.provUser = mkUser('ilhamitek95+trove-qa-provider-1@gmail.com', 'buyer', 'QA provider');
  ids.buyer = mkUser('Ilhamitek95+Trove-QA-buyer-1@gmail.com', 'buyer', 'QA buyer'); // case-insensitive
  ids.buyer4 = mkUser('ilhamitek95+trove-qa-buyer-4@gmail.com', 'buyer', 'QA buyer 4');

  files.qaImg = touch(path.join(UP, 'products', 'prod-12-25-0-1759000000000.jpg'));
  files.qaShopImg = touch(path.join(UP, 'shops', 'shop-12-1759000000000.jpg'));
  files.eidF = touch(path.join(PRIV, 'eid', 'eid-12-front.enc'));
  files.eidB = touch(path.join(PRIV, 'eid', 'eid-12-back.enc'));
  files.license = touch(path.join(PRIV, 'licenses', 'license-12.jpg'));
  ids.qaShop = mkShop(ids.seller, 'QA TEST — delete', 'qa-test-delete', {
    image: '/uploads/shops/shop-12-1759000000000.jpg', license: files.license,
    eidF: 'eid/eid-12-front.enc', eidB: 'eid/eid-12-back.enc',
  });
  ids.qaProduct = mkProduct(ids.qaShop, 'QA TEST — delete', ['/uploads/products/prod-12-25-0-1759000000000.jpg']);
  db.prepare("INSERT INTO analytics_events (kind,shop_id,product_id,visitor) VALUES ('product_view',?,?,'v1'), ('shop_view',?,NULL,'v1')")
    .run(ids.qaShop, ids.qaProduct, ids.qaShop);
  db.prepare("INSERT INTO analytics_events (kind,shop_id,product_id,visitor) VALUES ('product_view',?,?,'v2')").run(kilnMug.shop_id, kilnMug.id);

  ids.qaProvider = db.prepare(`INSERT INTO service_providers (user_id,name,slug,status) VALUES (?,?,?,'pending')`)
    .run(ids.provUser, 'QA TEST — delete', 'qa-test-delete-provider').lastInsertRowid;
  ids.qaService = db.prepare(`INSERT INTO services (provider_id,title,category,price_cents) VALUES (?,?,?,5000)`)
    .run(ids.qaProvider, 'QA TEST — delete', 'home-styling').lastInsertRowid;
  db.prepare(`INSERT INTO provider_payout_details (provider_id,account_name,bank_name,iban_encrypted,iban_masked) VALUES (?,?,?,?,?)`)
    .run(ids.qaProvider, 'QA', 'Fake Bank', 'enc', 'AE** 1234');
  ids.qaBooking = db.prepare(`INSERT INTO service_bookings (code,service_id,provider_id,buyer_id,name,email,phone,area,title,price_cents,price_type)
    VALUES ('SRV-QA0001',?,?,?,'QA','ilhamitek95+trove-qa-buyer-1@gmail.com','+971500000000','Dubai','QA TEST — delete',5000,'fixed')`)
    .run(ids.qaService, ids.qaProvider, ids.buyer).lastInsertRowid;

  // The QA buyer's traces.
  db.prepare("INSERT INTO addresses (user_id,name,line,city) VALUES (?,'QA','1 Test St','Dubai')").run(ids.buyer);
  db.prepare("INSERT INTO auth_tokens (user_id,kind,token_hash,email,expires_at) VALUES (?,'verify','h1',?,9999999999999)")
    .run(ids.buyer, 'ilhamitek95+trove-qa-buyer-1@gmail.com');
  db.prepare("INSERT INTO sessions (sid,sess,expire) VALUES ('qa-sess', ?, 9999999999999), ('real-sess', ?, 9999999999999)")
    .run(JSON.stringify({ userId: ids.buyer }), JSON.stringify({ userId: ids.plusOther }));
  db.prepare("INSERT INTO contact_messages (name,email,message) VALUES ('QA','ilhamitek95+trove-qa-buyer-2@gmail.com','test'), ('Real','someone@real.ae','hello')").run();

  // Orders: the live one, a guest pending one containing a REAL piece, a paid
  // QA guest order (skipped), and a pending order whose intent actually succeeded.
  ids.trv59 = mkOrder({ email: 'ilhamitek95+trove-qa-buyer-1@gmail.com', buyer: ids.buyer, pi: 'pi_3ULNCNEZ2SmPRliV0KCDThs7',
    items: [product(ids.qaProduct)], publicId: 'TRV-59BD85' });
  ids.guest2 = mkOrder({ email: 'ilhamitek95+trove-qa-buyer-2@gmail.com', status: 'cancelled', pi: 'pi_qa_guest2', items: [kilnMug], publicId: 'TRV-QA0002' });
  ids.paid3 = mkOrder({ email: 'ilhamitek95+trove-qa-buyer-3@gmail.com', status: 'paid', pi: 'pi_qa_paid3', items: [kilnMug], publicId: 'TRV-QA0003' });
  ids.succ4 = mkOrder({ email: 'ilhamitek95+trove-qa-buyer-4@gmail.com', buyer: ids.buyer4, pi: 'pi_qa_succ4', items: [kilnMug], publicId: 'TRV-QA0004' });
  ctx.stripeMock.setIntentStatus('pi_qa_succ4', 'succeeded');
  ctx.stripeMock.setIntentStatus('pi_qa_paid3', 'succeeded');

  // QA sellers whose shops must NOT go: one piece sold to a real customer,
  // one shop not carrying the QA TEST name.
  ids.seller2 = mkUser('ilhamitek95+trove-qa-seller-2@gmail.com', 'seller', 'QA seller 2');
  ids.qaShop2 = mkShop(ids.seller2, 'QA TEST two', 'qa-test-two');
  ids.qaProduct2 = mkProduct(ids.qaShop2, 'QA TEST piece');
  ids.realBuysQa = mkOrder({ email: 'buyer@real.ae', status: 'paid', items: [product(ids.qaProduct2)], publicId: 'TRV-REAL03' });
  ids.seller3 = mkUser('ilhamitek95+trove-qa-seller-3@gmail.com', 'seller', 'QA seller 3');
  ids.oddShop = mkShop(ids.seller3, 'Sand and Salt', 'sand-and-salt');

  // Homepage picks naming the QA piece and shop next to real ones.
  db.prepare("INSERT INTO site_content (section, value) VALUES ('home.weekly', ?), ('home.makers', ?)").run(
    JSON.stringify({ eyebrow: 'x', productIds: [kilnMug.id, ids.qaProduct], crops: { [kilnMug.id]: { x: 1, y: 1, z: 1 }, [ids.qaProduct]: { x: 2, y: 2, z: 1 } } }),
    JSON.stringify({ shopSlugs: ['kiln-and-clay', 'qa-test-delete'] }));

  realBefore = {
    shops: db.prepare("SELECT id FROM shops WHERE slug NOT IN ('qa-test-delete') ORDER BY id").all().map((r) => r.id),
    products: db.prepare('SELECT id FROM products WHERE id != ? ORDER BY id').all(ids.qaProduct).map((r) => r.id),
    providers: db.prepare("SELECT id FROM service_providers WHERE slug != 'qa-test-delete-provider' ORDER BY id").all().map((r) => r.id),
    services: count('services', 'provider_id != ?', ids.qaProvider),
    balances: count('seller_balances'),
    shipments: count('shipments'),
  };
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'seeded database is consistent');
});
after(async () => { await ctx.close(); });

test('the email pattern is strict', () => {
  for (const ok of ['ilhamitek95+trove-qa-seller-1@gmail.com', 'ILHAMITEK95+TROVE-QA-x@GMAIL.COM', 'ilhamitek95+trove-qa-buyer_2@gmail.com']) assert.ok(qa.isQaEmail(ok), ok);
  for (const no of ['ilhamitek95@gmail.com', 'ilhamitek95+other@gmail.com', 'ilhamitek95+trove-qa@gmail.com', 'xilhamitek95+trove-qa-1@gmail.com',
    'ilhamitek95+trove-qa-1@gmail.com.evil.com', 'ilhamitek95+trove-qa-1@googlemail.com', 'ilhamitek95trove-qa-1@gmail.com', '']) assert.ok(!qa.isQaEmail(no), no);
});

test('plan is read-only and names exactly the QA rows', () => {
  const users = count('users'), orders = count('orders');
  const p = qa.plan(db);
  assert.equal(count('users'), users);
  assert.equal(count('orders'), orders);
  // Without Stripe the succeeded-but-pending order still looks unpaid; run() checks Stripe first.
  assert.deepEqual(p.shops.map((s) => s.slug), ['qa-test-delete']);
  assert.deepEqual(p.products.map((x) => x.id), [ids.qaProduct]);
  assert.deepEqual(p.providers.map((x) => x.slug), ['qa-test-delete-provider']);
  assert.deepEqual(p.services.map((x) => x.id), [ids.qaService]);
  assert.ok(p.orders.some((o) => o.publicId === 'TRV-59BD85'));
  assert.ok(!p.orders.some((o) => ['TRV-REAL01', 'TRV-REAL02', 'TRV-REAL03', 'TRV-QA0003'].includes(o.publicId)));
  const emails = p.users.map((u) => u.email);
  assert.ok(!emails.includes('ilhamitek95+trove-qa-admin@gmail.com'), 'admins are never removed');
  assert.ok(!emails.includes('ilhamitek95@gmail.com') && !emails.includes('ilhamitek95+other@gmail.com'));
});

test('boot run removes only QA data, skips where money moved, and runs once', async () => {
  const r = await qa.bootOnce(db, { stripe: ctx.stripeMock, log: quiet });
  assert.ok(!r.error, r.error);
  await r.stripeDone;

  /* backup first, outside the nightly rotation */
  assert.ok(r.backupFile && fs.existsSync(r.backupFile));
  assert.ok(path.basename(r.backupFile).startsWith('trove-qa-cleanup-'));

  /* QA rows gone */
  const gone = (t, id) => assert.equal(count(t, 'id=?', id), 0, `${t} ${id} removed`);
  gone('users', ids.seller); gone('users', ids.provUser); gone('users', ids.buyer);
  gone('shops', ids.qaShop); gone('products', ids.qaProduct);
  gone('service_providers', ids.qaProvider); gone('services', ids.qaService); gone('service_bookings', ids.qaBooking);
  gone('orders', ids.trv59); gone('orders', ids.guest2);
  assert.equal(count('order_items', 'order_id IN (?,?)', ids.trv59, ids.guest2), 0);
  assert.equal(count('provider_payout_details', 'provider_id=?', ids.qaProvider), 0);
  assert.equal(count('analytics_events', 'shop_id=?', ids.qaShop), 0);
  assert.equal(count('addresses', 'user_id=?', ids.buyer), 0);
  assert.equal(count('auth_tokens', 'user_id=?', ids.buyer), 0);
  assert.equal(count('sessions', "sid='qa-sess'"), 0);
  assert.equal(count('contact_messages', "email LIKE 'ilhamitek95+trove-qa-%'"), 0);

  /* skipped and reported */
  const skippedOrder = (pid) => r.skipped.find((s) => s.kind === 'order' && s.label.startsWith(pid));
  assert.match(skippedOrder('TRV-QA0003').reason, /status paid/);
  assert.match(skippedOrder('TRV-QA0004').reason, /succeeded/);
  assert.equal(count('orders', 'id IN (?,?)', ids.paid3, ids.succ4), 2);
  assert.equal(count('users', 'id=?', ids.buyer4), 1, 'buyer on a kept order stays');
  assert.match(r.skipped.find((s) => s.kind === 'shop' && s.id === ids.qaShop2).reason, /TRV-REAL03/);
  assert.match(r.skipped.find((s) => s.kind === 'shop' && s.id === ids.oddShop).reason, /not named QA TEST/);
  assert.ok(r.skipped.some((s) => s.kind === 'user' && s.id === ids.qaAdmin && /admin/.test(s.reason)));
  for (const id of [ids.seller2, ids.seller3, ids.qaAdmin]) assert.equal(count('users', 'id=?', id), 1);
  assert.equal(count('products', 'id=?', ids.qaProduct2), 1);

  /* real data intact */
  for (const id of [ids.admin, ids.plusOther, ids.noSuffix, ids.prefixed, ids.realMaker]) assert.equal(count('users', 'id=?', id), 1);
  assert.deepEqual(db.prepare('SELECT id FROM shops ORDER BY id').all().map((x) => x.id), realBefore.shops);
  assert.deepEqual(db.prepare('SELECT id FROM products ORDER BY id').all().map((x) => x.id), realBefore.products);
  assert.deepEqual(db.prepare('SELECT id FROM service_providers ORDER BY id').all().map((x) => x.id), realBefore.providers);
  assert.equal(count('services'), realBefore.services);
  assert.equal(count('seller_balances'), realBefore.balances);
  assert.equal(count('shipments'), realBefore.shipments);
  for (const id of [ids.realPendingOrder, ids.realPaidOrder, ids.realBuysQa]) assert.equal(count('orders', 'id=?', id), 1);
  assert.equal(count('orders', "public_id='TRV-SEED01'"), 1);
  assert.equal(count('sessions', "sid='real-sess'"), 1);
  assert.equal(count('contact_messages', "email='someone@real.ae'"), 1);
  assert.equal(count('analytics_events', 'product_id=?', ids.kilnMug), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'nothing dangles');

  /* homepage picks pruned, real ones kept */
  const weekly = JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='home.weekly'").get().value);
  assert.deepEqual(weekly.productIds, [ids.kilnMug]);
  assert.deepEqual(Object.keys(weekly.crops), [String(ids.kilnMug)]);
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM site_content WHERE section='home.makers'").get().value).shopSlugs, ['kiln-and-clay']);

  /* files: only the QA ones */
  for (const f of [files.qaImg, files.qaShopImg, files.eidF, files.eidB, files.license]) assert.ok(!fs.existsSync(f), `${f} removed`);
  assert.ok(fs.existsSync(files.realImg) && fs.existsSync(files.orphan), 'unrelated files untouched');

  /* Stripe: the open intents cancelled, the paid ones never touched, no refunds */
  const calls = ctx.stripeMock.calls;
  const cancelled = calls.filter((c) => c.method === 'paymentIntents.cancel').map((c) => c.params.id).sort();
  assert.deepEqual(cancelled, ['pi_3ULNCNEZ2SmPRliV0KCDThs7', 'pi_qa_guest2']);
  assert.equal(calls.filter((c) => c.method === 'refunds.create').length, 0);

  /* marker + stored summary; a second boot is a no-op */
  assert.equal(count('schema_migrations', 'id=?', qa.MARKER), 1);
  const stored = qa.lastSummary(db);
  assert.equal(stored.summary.backupFile, r.backupFile);
  assert.ok(stored.summary.stripe.some((s) => s.outcome === 'cancelled'));
  const users = count('users');
  ctx.stripeMock.reset();
  const again = await qa.bootOnce(db, { stripe: ctx.stripeMock, log: quiet });
  assert.deepEqual(again, { skipped: true });
  assert.equal(count('users'), users);
  assert.equal(ctx.stripeMock.calls.length, 0);
});

test('admin endpoint shows the summary; everyone else gets 403', async () => {
  const other = await ctx.loginAs('ilhamitek95+other@gmail.com', 'testpass123');
  assert.equal((await ctx.api('GET', '/api/admin/maintenance/qa-cleanup', { cookie: other })).status, 403);
  assert.equal((await ctx.api('GET', '/api/admin/maintenance/qa-cleanup')).status, 401);
  const admin = await ctx.loginAs('ilhamitek95@gmail.com', 'testpass123');
  const res = await ctx.api('GET', '/api/admin/maintenance/qa-cleanup', { cookie: admin });
  assert.equal(res.status, 200);
  assert.equal(res.data.marker, 'qa-cleanup-2026-09-30-r2');
  assert.ok(res.data.appliedAt);
  assert.ok(res.data.summary.shops.some((s) => s.slug === 'qa-test-delete'));
});

test('a failed backup deletes nothing, writes no marker and does not throw', async () => {
  db.prepare('DELETE FROM schema_migrations WHERE id=?').run(qa.MARKER);
  const late = mkUser('ilhamitek95+trove-qa-late@gmail.com');
  const blocker = path.join(BACKUPS, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  process.env.BACKUPS_DIR = path.join(blocker, 'sub'); // mkdir under a file fails
  const errors = [];
  const r = await qa.bootOnce(db, { log: { log() {}, error: (...a) => errors.push(a.join(' ')) } });
  process.env.BACKUPS_DIR = BACKUPS;
  assert.ok(r.error);
  assert.ok(errors.some((e) => /QA cleanup .* FAILED/.test(e)));
  assert.equal(count('users', 'id=?', late), 1, 'nothing deleted');
  assert.equal(count('schema_migrations', 'id=?', qa.MARKER), 0, 'no marker - retries next boot');

  // Next boot succeeds; an empty plan still writes the marker.
  const ok = await qa.bootOnce(db, { log: quiet });
  assert.ok(!ok.error);
  assert.equal(count('users', 'id=?', late), 0);
  assert.equal(count('schema_migrations', 'id=?', qa.MARKER), 1);
  db.prepare('DELETE FROM schema_migrations WHERE id=?').run(qa.MARKER);
  const empty = await qa.bootOnce(db, { log: quiet });
  assert.equal(empty.noop, true);
  assert.equal(count('schema_migrations', 'id=?', qa.MARKER), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('server.js runs the cleanup at boot, before the app starts serving', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const hook = src.indexOf("require('./qa-cleanup').bootOnce(db");
  assert.ok(hook > 0, 'boot hook present');
  assert.ok(hook < src.indexOf('app.listen('), 'runs before listen');
  const text = qa.describe(qa.lastSummary(db).summary);
  assert.match(text, /QA cleanup qa-cleanup-2026-09-30-r2/);
});
