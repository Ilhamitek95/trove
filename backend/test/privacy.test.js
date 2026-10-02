'use strict';
/**
 * PDPL tooling (src/privacy.js + routes/privacy.routes.js) and the Privacy
 * Policy v2 that describes it: an admin can look a person up by email,
 * download a copy of their data (references only, no internal ids), and
 * close + anonymise the account — only once nothing is in progress — which
 * scrubs the person from every record while the order, refund and booking
 * money rows stay. A closed shop's ID documents go on request or after five
 * years; contact messages after two years; return photos a year after the
 * return closed. The policy text states exactly those periods.
 */
const fs = require('fs');
const path = require('path');
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, adminCookie, buyerCookie;
const ids = {};
const UP = () => process.env.UPLOADS_DIR;
const PRIV = () => process.env.PRIVATE_DIR;
function touch(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file; }

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  const { hashPassword } = require('../src/middleware');
  const pw = hashPassword('testpass123');
  const mkUser = (email, role, name) => db.prepare('INSERT INTO users (email,password_hash,name,role,phone) VALUES (?,?,?,?,?)')
    .run(email, pw, name, role, role === 'buyer' ? '+971501234567' : null).lastInsertRowid;
  ids.admin = mkUser('admin@test.local', 'admin', 'Admin');
  ids.buyer = mkUser('layla@test.local', 'buyer', 'Layla Haddad');
  ids.maker = mkUser('maker@test.local', 'seller', 'Mira Maker');
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
  buyerCookie = await ctx.loginAs('layla@test.local', 'testpass123');

  // The maker's shop and one piece.
  ids.shop = db.prepare(`INSERT INTO shops (user_id,name,slug,status,pitch_phone,pickup_address,pickup_phone,payout_bank_name,payout_account_name,
      iban_masked,iban_encrypted,emirates_id_last4,emirates_id_expiry,seller_address,eid_front_file,eid_back_file,license_image,agreement_version,agreement_accepted_at)
    VALUES (?,?,?,'approved','+971509999999','Villa 3, Al Barsha, Dubai','+971509999999','Test Bank','Mira Maker','AE·· ···· 3456','enc-blob','4417','2030-01-01',
      'Home 7, Jumeirah, Dubai','eid/f.enc','eid/b.enc',?,'v5',datetime('now'))`)
    .run(ids.maker, 'Mira Ceramics', 'mira-ceramics', path.join(PRIV(), 'licenses', 'lic.jpg')).lastInsertRowid;
  touch(path.join(PRIV(), 'eid', 'f.enc'));
  touch(path.join(PRIV(), 'eid', 'b.enc'));
  touch(path.join(PRIV(), 'licenses', 'lic.jpg'));
  ids.product = db.prepare("INSERT INTO products (shop_id,name,price_cents,stock,status) VALUES (?, 'Speckled bowl', 15000, 4, 'live')").run(ids.shop).lastInsertRowid;

  // Layla: an address, a delivered order whose return window has closed, a refunded return with a photo,
  // a review with a photo, a completed booking, a contact message.
  db.prepare("INSERT INTO addresses (user_id,label,name,line,city,phone) VALUES (?, 'Home', 'Layla Haddad', 'Flat 12, Marina Gate', 'Dubai', '+971501234567')").run(ids.buyer);
  ids.order = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,phone,subtotal_cents,shipping_cents,total_cents,status,shipping_json,delivered_at,return_window_ends_at,created_at)
    VALUES ('TRV-PRIV1',?,?,?,15000,3000,18000,'fulfilled',?,datetime('now','-40 days'),datetime('now','-25 days'),datetime('now','-45 days'))`)
    .run(ids.buyer, 'layla@test.local', '+971501234567', JSON.stringify({ name: 'Layla Haddad', line: 'Flat 12, Marina Gate', city: 'Dubai', emirate: 'Dubai', country: 'United Arab Emirates' })).lastInsertRowid;
  ids.item = db.prepare(`INSERT INTO order_items (order_id,product_id,shop_id,name_snapshot,price_cents,qty,personalization)
    VALUES (?,?,?,'Speckled bowl',15000,1,'For Layla')`).run(ids.order, ids.product, ids.shop).lastInsertRowid;
  touch(path.join(UP(), 'returns', 'ret-photo.jpg'));
  db.prepare(`INSERT INTO return_requests (order_id,buyer_id,reason,details,images,status,refund_cents,decided_at,refunded_at)
    VALUES (?,?,'damaged','It arrived with a crack near my name',?, 'refunded', 15000, datetime('now','-30 days'), datetime('now','-28 days'))`)
    .run(ids.order, ids.buyer, JSON.stringify(['/uploads/returns/ret-photo.jpg']));
  touch(path.join(UP(), 'reviews', 'rev-photo.jpg'));
  db.prepare("INSERT INTO reviews (buyer_id,shop_id,product_id,order_id,rating,body,images) VALUES (?,?,?,?,5,'Lovely bowl',?)")
    .run(ids.buyer, ids.shop, ids.product, ids.order, JSON.stringify(['/uploads/reviews/rev-photo.jpg']));
  const prov = db.prepare(`INSERT INTO service_providers (user_id,name,slug,status) VALUES (?, 'Studio Noor', 'studio-noor', 'approved')`).run(ids.admin).lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (provider_id,title,category,price_cents) VALUES (?, 'Calligraphy class', 'workshops', 20000)").run(prov).lastInsertRowid;
  db.prepare(`INSERT INTO service_bookings (code,service_id,provider_id,buyer_id,name,email,phone,area,notes,title,price_cents,price_type,status,completed_at)
    VALUES ('SRV-PRIV01',?,?,?, 'Layla Haddad','layla@test.local','+971501234567','Dubai','Gate code 4411','Calligraphy class',20000,'fixed','completed',datetime('now','-3 days'))`)
    .run(svc, prov, ids.buyer);
  db.prepare("INSERT INTO contact_messages (name,email,topic,message,user_id) VALUES ('Layla Haddad','layla@test.local','privacy','Please delete my account and my data.',?)").run(ids.buyer);

  // A guest who only ever checked out without an account.
  db.prepare(`INSERT INTO orders (public_id,email,phone,subtotal_cents,shipping_cents,total_cents,status,shipping_json,delivered_at,return_window_ends_at)
    VALUES ('TRV-GUEST',?,?,9000,3000,12000,'fulfilled',?,datetime('now','-60 days'),datetime('now','-45 days'))`)
    .run('guest@test.local', '+971507654321', JSON.stringify({ name: 'Omar Guest', line: 'Villa 9', city: 'Abu Dhabi', emirate: 'Abu Dhabi' }));
});
after(async () => { await ctx.close(); });

const admin = (method, p, body) => ctx.api(method, p, { cookie: adminCookie, body });
const keysDeep = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};

test('the privacy tools are admin only', async () => {
  for (const [m, p] of [['GET', '/api/admin/privacy/lookup?email=layla@test.local'], ['GET', '/api/admin/privacy/export?email=layla@test.local'],
    ['POST', '/api/admin/privacy/anonymise'], ['POST', '/api/admin/privacy/delete-id-documents']]) {
    assert.equal((await ctx.api(m, p, { body: m === 'POST' ? { email: 'layla@test.local', confirm: 'layla@test.local' } : undefined })).status, 401, p);
    assert.equal((await ctx.api(m, p, { cookie: buyerCookie, body: m === 'POST' ? { email: 'layla@test.local', confirm: 'layla@test.local' } : undefined })).status, 403, p);
  }
});

test('look-up shows what Trove holds and what must finish first', async () => {
  const r = await admin('GET', '/api/admin/privacy/lookup?email=LAYLA@test.local');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.data.found, true);
  assert.equal(r.data.account.name, 'Layla Haddad');
  assert.deepEqual(r.data.counts, { orders: 1, returns: 1, reviews: 1, bookings: 1, messages: 1, addresses: 1 });
  assert.deepEqual(r.data.blockers, []);
  assert.equal(r.data.canAnonymise, true);

  // An order still on its way blocks closing — and says which one.
  const open = db.prepare(`INSERT INTO orders (public_id,buyer_id,email,subtotal_cents,total_cents,status) VALUES ('TRV-OPEN1',?, 'layla@test.local', 5000, 8000, 'paid')`).run(ids.buyer).lastInsertRowid;
  const blocked = await admin('GET', '/api/admin/privacy/lookup?email=layla@test.local');
  assert.equal(blocked.data.canAnonymise, false);
  assert.ok(blocked.data.blockers.some((b) => /TRV-OPEN1 has not been delivered yet/.test(b)), blocked.text);
  const refused = await admin('POST', '/api/admin/privacy/anonymise', { email: 'layla@test.local', confirm: 'layla@test.local' });
  assert.equal(refused.status, 409);
  assert.ok(refused.data.blockers.length);
  // Delivered but inside the return window: still blocked.
  db.prepare("UPDATE orders SET status='fulfilled', delivered_at=datetime('now','-2 days'), return_window_ends_at=datetime('now','+13 days') WHERE id=?").run(open);
  assert.ok((await admin('GET', '/api/admin/privacy/lookup?email=layla@test.local')).data.blockers.some((b) => /return window/.test(b)));
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(open);
  assert.deepEqual((await admin('GET', '/api/admin/privacy/lookup?email=layla@test.local')).data.blockers, []);

  // Admin accounts are never closed from here; unknown addresses hold nothing.
  assert.ok((await admin('GET', '/api/admin/privacy/lookup?email=admin@test.local')).data.blockers.some((b) => /admin account/.test(b)));
  const none = await admin('GET', '/api/admin/privacy/lookup?email=nobody@test.local');
  assert.equal(none.data.found, false);
  assert.equal(none.data.canAnonymise, false);
  assert.equal((await admin('GET', '/api/admin/privacy/lookup?email=not-an-email')).status, 400);
});

test('a copy of their data: a JSON file with everything, references only', async () => {
  const r = await admin('GET', '/api/admin/privacy/export?email=layla@test.local');
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="trove-personal-data-\d{4}-\d{2}-\d{2}\.json"/);
  const d = r.data;
  assert.equal(d.controller, 'Serein Consultancy LLC');
  assert.equal(d.account.email, 'layla@test.local');
  assert.equal(d.account.mobile, '+971501234567');
  assert.equal(d.addresses[0].line, 'Flat 12, Marina Gate');
  const order = d.orders.find((o) => o.reference === 'TRV-PRIV1');
  assert.equal(order.total, 180);
  assert.equal(order.deliveryAddress.name, 'Layla Haddad');
  assert.equal(order.items[0].personalisation, 'For Layla');
  assert.equal(d.returns[0].details, 'It arrived with a crack near my name');
  assert.deepEqual(d.returns[0].photos, ['/uploads/returns/ret-photo.jpg']);
  assert.equal(d.reviews[0].text, 'Lovely bowl');
  assert.equal(d.bookings[0].reference, 'SRV-PRIV01');
  assert.equal(d.bookings[0].note, 'Gate code 4411');
  assert.equal(d.messages[0].message, 'Please delete my account and my data.');
  const keys = keysDeep(d);
  for (const k of keys) assert.ok(!/(^id$|_id$|Id$)/.test(k), `no internal id in the export: ${k}`);
  // A maker's export carries the shop, with the IBAN masked only.
  const m = (await admin('GET', '/api/admin/privacy/export?email=maker@test.local')).data;
  assert.equal(m.shop.name, 'Mira Ceramics');
  assert.equal(m.shop.bank.iban, 'AE·· ···· 3456');
  assert.equal(m.shop.emiratesId.lastFourDigits, '4417');
  assert.equal(m.shop.homeAddress, 'Home 7, Jumeirah, Dubai');
  assert.ok(!JSON.stringify(m).includes('enc-blob'), 'never the encrypted IBAN');
  // Logged without the address.
  const logRow = db.prepare("SELECT * FROM privacy_log WHERE action='export' ORDER BY id DESC LIMIT 1").get();
  assert.ok(!JSON.stringify(logRow).includes('@test.local'));
  assert.match(logRow.subject_hash, /^[0-9a-f]{64}$/);
});

test('close and anonymise: the person leaves every record, the money rows stay', async () => {
  const unconfirmed = await admin('POST', '/api/admin/privacy/anonymise', { email: 'layla@test.local', confirm: 'someone@else.ae' });
  assert.equal(unconfirmed.status, 400, 'the address must be typed again');
  const r = await admin('POST', '/api/admin/privacy/anonymise', { email: 'layla@test.local', confirm: ' Layla@Test.local ' });
  assert.equal(r.status, 200, r.text);

  const u = db.prepare('SELECT * FROM users WHERE id=?').get(ids.buyer);
  assert.equal(u.name, 'Deleted customer');
  assert.match(u.email, /^deleted-[0-9a-f]{12}@deleted\.invalid$/);
  assert.equal(u.phone, null);
  assert.ok(u.anonymised_at);
  // Signed out everywhere and no way back in.
  assert.equal((await ctx.api('GET', '/api/auth/me', { cookie: buyerCookie })).status, 401);
  assert.equal((await ctx.api('POST', '/api/auth/login', { body: { email: 'layla@test.local', password: 'testpass123' } })).status, 401);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM addresses WHERE user_id=?').get(ids.buyer).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews WHERE buyer_id=?').get(ids.buyer).n, 0);
  assert.ok(!fs.existsSync(path.join(UP(), 'reviews', 'rev-photo.jpg')), 'review photo deleted');
  assert.ok(!fs.existsSync(path.join(UP(), 'returns', 'ret-photo.jpg')), 'return photo deleted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contact_messages WHERE email='layla@test.local'").get().n, 0);

  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(ids.order);
  assert.equal(o.total_cents, 18000, 'the order and its amounts stay');
  assert.equal(o.status, 'fulfilled');
  assert.equal(o.email, u.email);
  assert.equal(o.phone, '');
  assert.deepEqual(JSON.parse(o.shipping_json), { name: 'Deleted customer', line: '', city: 'Dubai', emirate: 'Dubai', country: 'United Arab Emirates' });
  assert.equal(db.prepare('SELECT personalization FROM order_items WHERE id=?').get(ids.item).personalization, '[removed]');
  const rr = db.prepare('SELECT * FROM return_requests WHERE order_id=?').get(ids.order);
  assert.equal(rr.refund_cents, 15000, 'the refund record stays');
  assert.equal(rr.details, '');
  assert.equal(rr.images, '[]');
  const bk = db.prepare("SELECT * FROM service_bookings WHERE code='SRV-PRIV01'").get();
  assert.equal(bk.name, 'Deleted customer');
  assert.equal(bk.phone, '');
  assert.equal(bk.notes, '');
  assert.equal(bk.price_cents, 20000);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM privacy_log').all()).includes('layla'), 'the log holds no personal data');

  // Nothing is left under the old address, and it cannot be done twice.
  assert.equal((await admin('GET', '/api/admin/privacy/lookup?email=layla@test.local')).data.found, false);
  assert.equal((await admin('POST', '/api/admin/privacy/anonymise', { email: 'layla@test.local', confirm: 'layla@test.local' })).status, 404);
});

test('a guest with no account is anonymised by email too', async () => {
  const r = await admin('POST', '/api/admin/privacy/anonymise', { email: 'guest@test.local', confirm: 'guest@test.local' });
  assert.equal(r.status, 200, r.text);
  const o = db.prepare("SELECT * FROM orders WHERE public_id='TRV-GUEST'").get();
  assert.notEqual(o.email, 'guest@test.local');
  assert.equal(o.phone, '');
  assert.equal(JSON.parse(o.shipping_json).name, 'Deleted customer');
  assert.equal(o.total_cents, 12000);
});

test('a maker: shop off Trove, bank and contact details gone; ID documents kept until deleted', async () => {
  const r = await admin('POST', '/api/admin/privacy/anonymise', { email: 'maker@test.local', confirm: 'maker@test.local' });
  assert.equal(r.status, 200, r.text);
  const s = db.prepare('SELECT * FROM shops WHERE id=?').get(ids.shop);
  assert.equal(s.status, 'suspended');
  assert.ok(s.closed_at);
  assert.equal(s.iban_encrypted, null);
  assert.equal(s.payout_account_name, '');
  assert.equal(s.pickup_address, '');
  assert.equal(s.pickup_phone, '');
  assert.equal(s.pitch_phone, '');
  assert.equal(s.iban_masked, 'AE·· ···· 3456', 'the masked number stays on the records');
  assert.equal(db.prepare('SELECT status FROM products WHERE id=?').get(ids.product).status, 'hidden');
  assert.equal(s.emirates_id_last4, '4417', 'ID documents follow the retention period');
  assert.ok(fs.existsSync(path.join(PRIV(), 'eid', 'f.enc')));

  const look = await admin('GET', '/api/admin/privacy/lookup?email=' + encodeURIComponent(db.prepare('SELECT email FROM users WHERE id=?').get(ids.maker).email));
  assert.equal(look.data.shop.idDocumentsOnFile, true);
  const del = await admin('POST', '/api/admin/privacy/delete-id-documents', { email: db.prepare('SELECT email FROM users WHERE id=?').get(ids.maker).email });
  assert.equal(del.status, 200, del.text);
  const after = db.prepare('SELECT * FROM shops WHERE id=?').get(ids.shop);
  assert.equal(after.eid_front_file, null);
  assert.equal(after.eid_back_file, null);
  assert.equal(after.license_image, '');
  assert.equal(after.seller_address, '');
  assert.equal(after.emirates_id_last4, '');
  for (const f of [['eid', 'f.enc'], ['eid', 'b.enc'], ['licenses', 'lic.jpg']]) assert.ok(!fs.existsSync(path.join(PRIV(), ...f)), f.join('/'));
});

test('ID documents of an open shop are never deleted from here', async () => {
  const uid = db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('open@test.local','x','Open','seller')").run().lastInsertRowid;
  db.prepare("INSERT INTO shops (user_id,name,slug,status,eid_front_file) VALUES (?, 'Open Shop', 'open-shop', 'approved', 'eid/o.enc')").run(uid);
  const r = await admin('POST', '/api/admin/privacy/delete-id-documents', { email: 'open@test.local' });
  assert.equal(r.status, 409);
});

test('the nightly sweep keeps the retention periods the policy states', async () => {
  const privacy = require('../src/privacy');
  db.prepare("INSERT INTO contact_messages (name,email,message,created_at) VALUES ('Old','old@test.local','An old question about a vase', datetime('now','-731 days'))").run();
  db.prepare("INSERT INTO contact_messages (name,email,message,created_at) VALUES ('New','new@test.local','A recent question about a vase', datetime('now','-700 days'))").run();
  touch(path.join(UP(), 'returns', 'old.jpg'));
  touch(path.join(UP(), 'returns', 'recent.jpg'));
  touch(path.join(UP(), 'returns', 'open.jpg'));
  const ord = db.prepare("SELECT id FROM orders WHERE public_id='TRV-GUEST'").get().id;
  const rr = (status, img, when) => db.prepare(`INSERT INTO return_requests (order_id,buyer_id,reason,images,status,decided_at,refunded_at)
    VALUES (?,?,'damaged',?,?,?,?)`).run(ord, ids.buyer, JSON.stringify([`/uploads/returns/${img}`]), status, when, status === 'refunded' ? when : null).lastInsertRowid;
  const oldR = rr('refunded', 'old.jpg', db.prepare("SELECT datetime('now','-366 days') d").get().d);
  const recentR = rr('declined', 'recent.jpg', db.prepare("SELECT datetime('now','-100 days') d").get().d);
  const openR = rr('requested', 'open.jpg', null);
  db.prepare("UPDATE return_requests SET created_at = datetime('now','-400 days') WHERE id=?").run(openR);
  // A shop closed more than five years ago, and one closed last year.
  const mk = (slug, closed) => {
    const uid = db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)').run(`${slug}@test.local`, 'x', slug, 'seller').lastInsertRowid;
    touch(path.join(PRIV(), 'eid', `${slug}.enc`));
    return db.prepare(`INSERT INTO shops (user_id,name,slug,status,eid_front_file,seller_address,emirates_id_last4,closed_at)
      VALUES (?,?,?,'suspended',?,'Somewhere','1234',datetime('now', ?))`).run(uid, slug, slug, `eid/${slug}.enc`, closed).lastInsertRowid;
  };
  const longClosed = mk('long-closed', '-6 years');
  const recentClosed = mk('recent-closed', '-1 years');

  const res = privacy.sweep();
  assert.ok(res.messages >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contact_messages WHERE email='old@test.local'").get().n, 0, 'two years: gone');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contact_messages WHERE email='new@test.local'").get().n, 1, 'under two years: kept');
  assert.equal(db.prepare('SELECT images FROM return_requests WHERE id=?').get(oldR).images, '[]');
  assert.ok(!fs.existsSync(path.join(UP(), 'returns', 'old.jpg')));
  assert.notEqual(db.prepare('SELECT images FROM return_requests WHERE id=?').get(recentR).images, '[]');
  assert.ok(fs.existsSync(path.join(UP(), 'returns', 'recent.jpg')));
  assert.notEqual(db.prepare('SELECT images FROM return_requests WHERE id=?').get(openR).images, '[]', 'an open return keeps its photos');
  const lc = db.prepare('SELECT * FROM shops WHERE id=?').get(longClosed);
  assert.equal(lc.eid_front_file, null);
  assert.equal(lc.seller_address, '');
  assert.ok(!fs.existsSync(path.join(PRIV(), 'eid', 'long-closed.enc')));
  assert.equal(db.prepare('SELECT eid_front_file FROM shops WHERE id=?').get(recentClosed).eid_front_file, 'eid/recent-closed.enc');
  assert.ok(fs.existsSync(path.join(PRIV(), 'eid', 'recent-closed.enc')));
  // Idempotent.
  assert.deepEqual(privacy.sweep(), { messages: 0, returnPhotos: 0, idDocuments: 0 });
});

test('Privacy Policy v2 says what the code does', () => {
  const cfg = require('../src/config');
  const privacy = require('../src/privacy');
  assert.equal(cfg.PRIVACY_VERSION, 'v2');
  const md = fs.readFileSync(path.join(__dirname, '..', 'legal', 'privacy-v2.md'), 'utf8').replace(/\s+/g, ' ');
  assert.equal(privacy.CONTACT_MESSAGE_DAYS, 730);
  assert.match(md, /Contact form messages\*\*: two years from when they were sent, then deleted automatically/);
  assert.equal(privacy.RETURN_PHOTO_DAYS, 365);
  assert.match(md, /Return request photos\*\*: one year after the return is closed/);
  assert.equal(privacy.ID_DOCUMENT_YEARS, 5);
  assert.match(md, /for five years after your shop is closed, then deleted automatically/);
  assert.match(md, /structured, machine-readable file \(JSON\)/);
  assert.match(md, /Closing your account\./);
  assert.match(md, /Serein Consultancy LLC is the \*\*controller\*\*/);
  assert.match(md, /bank transfer from Serein Consultancy LLC/, 'the payer of provider fees is named');
  assert.doesNotMatch(md, /save a card/, 'there is no saved-card feature');
  assert.match(md, /\*\*last four digits\*\*, its \*\*expiry date\*\* and, if you give it, its \*\*issue date\*\*/);
  assert.match(md, /only if you agree to measurement cookies/, 'the shop-statistics id needs consent');
  assert.match(md, /guest orders are added to that account once the email address has been confirmed/);
  assert.doesNotMatch(md, /agree to measurement and marketing cookies/, 'no marketing purpose on the banner');
  assert.match(md, /full delivery address only for a parcel the maker delivers by hand, and only until that order's return window closes/);
  assert.match(md, /email you 30 days before your Emirates ID expires and to pause settlements while it has expired/);
  assert.match(md, /which we need before your shop is approved, shared only with the courier/);
  // The 18+ rule is in the Terms of Sale too now.
  const terms = fs.readFileSync(path.join(__dirname, '..', 'legal', `buyer-terms-${cfg.BUYER_TERMS_VERSION}.md`), 'utf8');
  assert.match(terms, /## 2\. Who can buy\s+You must be \*\*18 or over\*\*/);
  // v1 stays untouched as the published record.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'legal', 'privacy-v1.md'), 'utf8'), /if you choose to save a card/);
});
