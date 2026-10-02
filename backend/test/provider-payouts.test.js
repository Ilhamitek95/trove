'use strict';
/**
 * Manual provider payouts (owner, 2026-09-30: providers are paid by bank
 * transfer from Serein Consultancy on Trove's behalf) — src/provider-payouts.js,
 * src/service-credits.js, GET/PUT /api/provider/payout and the admin
 * transfer file + Mark paid.
 *
 * The load-bearing rules under test:
 *   - a provider IBAN passes the seller payout-setup validator (UAE + mod-97)
 *     and is stored encrypted: the raw column never equals or contains it
 *   - every provider-facing response carries the masked IBAN only
 *   - 'Use my shop's bank details' copies the ciphertext server-side
 *   - the transfer file is admin-only, the ONLY place the IBAN decrypts, and
 *     lists only payable fees of providers who have bank details
 *   - Mark paid stamps paid_at + reference + payer on each row and emails the
 *     provider a payment note naming the payer — and nothing about the customer
 *   - the provider sees waiting / payable / paid for each fee
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db, api, adminCookie;
const sent = [];
const P = {}; // name → { id, cookie, serviceId }

/** A valid UAE IBAN for a 3-digit bank code + 16-digit account (mod-97 check digits computed). */
function ibanFor(bank, account) {
  const bban = `${bank}${account}`;
  const digits = `${bban}101400`; // 'AE' = 10 14, check digits 00
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return `AE${String(98 - rem).padStart(2, '0')}${bban}`;
}
const IBAN_A = 'AE070331234567890123456';           // the textbook example — valid
const IBAN_SHOP = ibanFor('026', '1234000099998888');
const GUEST = { name: 'Sara Guest', email: 'sara@test.local', phone: '050 222 3344', area: 'Dubai', preferredDate: 'next week', notes: 'Six frames.', agreeTerms: true, paymentMethod: 'trove' };
const dayFromNow = (n) => new Date(Date.now() + 4 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const todayDubai = () => dayFromNow(0).replace(/-/g, '');
let ipN = 0, evt = 0;

async function applyProvider(key, providerName, email) {
  const r = await api('POST', '/api/services/apply', { body: {
    name: `${key} Owner`, email, password: 'testpass123', providerName, categories: ['workshops'], location: 'Dubai, UAE',
    about: 'Hands-on sessions at your place.', experience: '3+ years', instagram: '@studio', links: '', phone: '+971 50 111 2233', agreeSub: true, agreeTerms: true,
  } });
  assert.equal(r.status, 201, r.text);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const id = db.prepare('SELECT id FROM service_providers WHERE user_id=(SELECT id FROM users WHERE email=?)').get(email).id;
  await api('PATCH', `/api/admin/providers/${id}`, { cookie: adminCookie, body: { status: 'approved' } });
  const s = await api('POST', '/api/provider/services', { cookie, body: { title: `${providerName} session`, category: 'workshops', priceCents: 40000, priceType: 'fixed', setting: 'home' } });
  P[key] = { id, cookie, serviceId: s.data.service.id };
}

/** Book, confirm and pay a trove booking for provider `key`; optionally mark it done an hour ago. */
async function paidBooking(key, { done = true, serviceDate = dayFromNow(1) } = {}) {
  const r = await api('POST', `/api/services/${P[key].serviceId}/book`, { body: GUEST, headers: { 'x-forwarded-for': `198.51.100.${++ipN}` } });
  assert.equal(r.status, 201, r.text);
  const id = r.data.booking.id;
  const c = await api('PATCH', `/api/provider/bookings/${id}`, { cookie: P[key].cookie, body: { action: 'confirm', serviceDate } });
  assert.equal(c.status, 200, c.text);
  const bk = db.prepare('SELECT * FROM service_bookings WHERE id=?').get(id);
  const w = await ctx.postWebhook({ id: `evt_pp_${++evt}`, type: 'payment_intent.succeeded', data: { object: {
    id: bk.stripe_payment_intent_id, amount: bk.amount_cents, amount_received: bk.amount_cents,
    metadata: { kind: 'service_booking', booking_id: String(id), code: bk.code } } } });
  assert.equal(w.status, 200);
  if (done) {
    assert.equal((await api('PATCH', `/api/provider/bookings/${id}`, { cookie: P[key].cookie, body: { action: 'complete' } })).status, 200);
    db.prepare("UPDATE service_bookings SET completed_at=datetime('now','-1 hour') WHERE id=?").run(id);
  }
  return db.prepare('SELECT * FROM service_bookings WHERE id=?').get(id);
}
const detailsRow = (key) => db.prepare('SELECT * FROM provider_payout_details WHERE provider_id=?').get(P[key].id);
const payout = (key) => api('GET', '/api/provider/payout', { cookie: P[key].cookie });

let bkA, bkA2, bkC;
before(async () => {
  ctx = await startApp(); db = ctx.db; api = ctx.api;
  require('../src/email').send = async (msg) => { sent.push(msg); return { id: 'test' }; };
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@test.local', ?, 'Admin', 'admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
  await applyProvider('A', 'Noor Frames', 'noor@test.local');
  await applyProvider('C', 'Clay Days', 'clay@test.local');
  // B runs a shop too, with verified shop payout details on file.
  const pcrypto = require('../src/crypto');
  const uid = db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('mara@test.local', ?, 'Mara Kiln', 'seller')").run(hashPassword('testpass123')).lastInsertRowid;
  db.prepare(`INSERT INTO shops (user_id,name,slug,status,payout_bank_name,payout_account_name,iban_encrypted,iban_masked)
    VALUES (?,?,?,'approved','Emirates NBD','Mara Kiln',?,?)`).run(uid, 'Kiln & Clay', 'kiln-clay', pcrypto.encrypt(IBAN_SHOP), pcrypto.maskIban(IBAN_SHOP));
  const bid = db.prepare("INSERT INTO service_providers (user_id,name,slug,status,categories) VALUES (?,?,?,'approved','[]')").run(uid, 'Kiln Sessions', 'kiln-sessions').lastInsertRowid;
  P.B = { id: Number(bid), cookie: await ctx.loginAs('mara@test.local', 'testpass123') };
  const sb = await api('POST', '/api/provider/services', { cookie: P.B.cookie, body: { title: 'Kiln session', category: 'workshops', priceCents: 40000, priceType: 'fixed', setting: 'home' } });
  P.B.serviceId = sb.data.service.id;

  bkA = await paidBooking('A');                                        // payable now
  bkA2 = await paidBooking('A', { done: false, serviceDate: dayFromNow(5) }); // waiting
  bkC = await paidBooking('C');                                        // payable, but no bank details
});
after(async () => { await ctx.close(); });

/* ---------------- provider bank details ---------------- */

test('a provider with a paid booking and no bank details is asked for them', async () => {
  const r = await payout('A');
  assert.equal(r.status, 200);
  assert.equal(r.data.details, null);
  assert.equal(r.data.needsDetails, true);
  assert.equal(r.data.payerName, 'Serein Consultancy LLC');
  assert.equal(r.data.shopDetails, null, 'no shop, no shop option');
  assert.equal(r.data.credits.length, 2);
});

test('bank details are validated with the seller IBAN rules', async () => {
  const put = (body) => api('PUT', '/api/provider/payout', { cookie: P.A.cookie, body });
  const good = { accountName: 'Noor Hassan', bankName: 'Mashreq', iban: IBAN_A };
  assert.equal((await put({ ...good, iban: 'AE080331234567890123456' })).status, 400, 'bad mod-97 checksum');
  assert.equal((await put({ ...good, iban: 'GB82WEST12345698765432' })).status, 400, 'not a UAE IBAN');
  assert.equal((await put({ ...good, iban: 'AE07033123' })).status, 400, 'too short');
  assert.equal((await put({ ...good, accountName: '' })).status, 400, 'holder required');
  assert.equal((await put({ ...good, bankName: ' ' })).status, 400, 'bank required');
  assert.equal((await put({ ...good, accountName: '<b>x</b>' })).status, 400, 'no markup');
  assert.equal(detailsRow('A'), undefined, 'nothing saved on a refusal');
});

test('the IBAN is encrypted at rest and only ever returned masked', async () => {
  const r = await api('PUT', '/api/provider/payout', { cookie: P.A.cookie, body: { accountName: 'Noor Hassan', bankName: 'Mashreq', iban: 'ae07 0331 2345 6789 0123 456' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ ...r.data.details, updatedAt: undefined }, { accountName: 'Noor Hassan', bankName: 'Mashreq', iban: 'AE·· ···· 3456', source: 'own', updatedAt: undefined });
  assert.equal(r.data.needsDetails, false);
  const row = detailsRow('A');
  assert.notEqual(row.iban_encrypted, IBAN_A);
  assert.ok(!row.iban_encrypted.includes('0331234567890123456'), 'no plaintext inside the stored value');
  assert.equal(require('../src/crypto').decrypt(row.iban_encrypted), IBAN_A, 'decrypts with the payout key');
  for (const res of [r, await payout('A'), await api('GET', '/api/provider/me', { cookie: P.A.cookie }),
    await api('GET', '/api/admin/providers', { cookie: adminCookie }), await api('GET', '/api/admin/service-credits', { cookie: adminCookie })]) {
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('0331234567890123456'), `no full IBAN in ${res.text.slice(0, 40)}`);
    assert.ok(!res.text.includes(row.iban_encrypted), 'no ciphertext either');
  }
});

test('a provider who runs a shop can reuse the shop bank details, copied server-side', async () => {
  const before = await payout('B');
  assert.deepEqual(before.data.shopDetails, { name: 'Kiln & Clay', accountName: 'Mara Kiln', bankName: 'Emirates NBD', iban: require('../src/crypto').maskIban(IBAN_SHOP) });
  assert.ok(!before.text.includes(IBAN_SHOP.slice(4)), 'the shop IBAN is masked too');
  // A client-sent IBAN alongside useShop is ignored: the shop's ciphertext is copied.
  const r = await api('PUT', '/api/provider/payout', { cookie: P.B.cookie, body: { useShop: true, iban: IBAN_A, accountName: 'Someone Else', bankName: 'X' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.details.source, 'shop');
  assert.equal(r.data.details.accountName, 'Mara Kiln');
  const shop = db.prepare("SELECT iban_encrypted FROM shops WHERE slug='kiln-clay'").get();
  assert.equal(detailsRow('B').iban_encrypted, shop.iban_encrypted);
  assert.equal(require('../src/crypto').decrypt(detailsRow('B').iban_encrypted), IBAN_SHOP);
  // No shop → nothing to copy.
  assert.equal((await api('PUT', '/api/provider/payout', { cookie: P.C.cookie, body: { useShop: true } })).status, 409);
  assert.equal(detailsRow('C'), undefined);
});

/* ---------------- admin only ---------------- */

test('the transfer file and Mark paid are admin-only', async () => {
  for (const cookie of [P.A.cookie, P.B.cookie, undefined]) {
    const csv = await api('GET', '/api/admin/provider-payouts/export.csv', { cookie });
    assert.ok([401, 403].includes(csv.status), `csv ${csv.status}`);
    assert.ok(!csv.text.includes('0331234567890123456'));
    const paid = await api('POST', `/api/admin/service-credits/${P.A.id}/paid`, { cookie, body: {} });
    assert.ok([401, 403].includes(paid.status));
    assert.ok([401, 403].includes((await api('GET', '/api/admin/service-credits', { cookie })).status));
  }
  assert.equal((await api('GET', '/api/admin/provider-payouts/export.csv', { cookie: P.A.cookie })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM provider_credits WHERE paid_at IS NOT NULL').get().c, 0);
});

test('the transfer file lists only payable fees of providers with bank details', async () => {
  const r = await api('GET', '/api/admin/provider-payouts/export.csv', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="trove-provider-transfers-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const lines = r.text.trim().split('\r\n');
  assert.equal(lines[0], 'provider,account_name,bank,iban,amount_aed,reference,bookings');
  assert.equal(lines.length, 2, 'A only: B has nothing payable, C has no bank details');
  assert.equal(lines[1], `"Noor Frames","Noor Hassan","Mashreq","${IBAN_A}",360.00,"TRV-SVC-${P.A.id}-${todayDubai()}","${bkA.code}"`);
  assert.ok(!r.text.includes(bkA2.code), 'a fee still waiting is not in the file');
  assert.ok(!r.text.includes('Clay Days') && !r.text.includes(bkC.code), 'no bank details, not in the file');
  assert.ok(!r.text.includes('Sara') && !r.text.includes('sara@test.local'), 'nothing about the customer');

  const adm = await api('GET', '/api/admin/service-credits', { cookie: adminCookie });
  assert.equal(adm.data.payerName, 'Serein Consultancy LLC');
  const c = adm.data.excluded.find((x) => x.providerId === P.C.id);
  assert.equal(c.reason, 'payout_details_missing');
  const a = adm.data.eligible.find((x) => x.providerId === P.A.id);
  assert.deepEqual(a.payTo, { bank: 'Mashreq', accountName: 'Noor Hassan', iban: 'AE·· ···· 3456' });
  assert.equal(a.reference, `TRV-SVC-${P.A.id}-${todayDubai()}`);
});

test('Mark paid refuses a provider still waiting for bank details, and a stale amount', async () => {
  const c = await api('POST', `/api/admin/service-credits/${P.C.id}/paid`, { cookie: adminCookie, body: {} });
  assert.equal(c.status, 409);
  assert.match(c.data.error, /Waiting for bank details/);
  const stale = await api('POST', `/api/admin/service-credits/${P.A.id}/paid`, { cookie: adminCookie, body: { amountCents: 12345 } });
  assert.equal(stale.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM provider_credits WHERE paid_at IS NOT NULL').get().c, 0);
  assert.equal(sent.length > 0 ? sent.filter((m) => /on their way/.test(m.subject)).length : 0, 0);
});

test('Mark paid stamps each fee with the reference and the payer, and emails the provider', async () => {
  sent.length = 0;
  const ref = `TRV-SVC-${P.A.id}-${todayDubai()}`;
  const r = await api('POST', `/api/admin/service-credits/${P.A.id}/paid`, { cookie: adminCookie, body: { reference: ref, amountCents: 36000 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.amountCents, 36000);
  assert.equal(r.data.payer, 'Serein Consultancy LLC');
  const cr = db.prepare("SELECT * FROM provider_credits WHERE booking_id=? AND type='credit_service'").get(bkA.id);
  assert.ok(cr.paid_at);
  assert.equal(cr.pay_reference, ref);
  assert.equal(cr.payer_name, 'Serein Consultancy LLC');
  const waiting = db.prepare("SELECT * FROM provider_credits WHERE booking_id=? AND type='credit_service'").get(bkA2.id);
  assert.equal(waiting.paid_at, null, 'a fee not yet payable stays open');

  await new Promise((res) => setTimeout(res, 20));
  const mails = sent.filter((m) => m.to === 'noor@test.local');
  assert.equal(mails.length, 1);
  const m = mails[0];
  assert.match(m.subject, /AED 360/);
  assert.ok(m.html.includes(ref), 'the reference');
  assert.ok(m.html.includes('Serein Consultancy'), 'the payer');
  assert.ok(m.html.includes('1–2 working days'));
  assert.ok(m.html.includes(bkA.code), 'the booking covered');
  assert.ok(m.html.includes('because you offer services on the Trove Services Marketplace'), 'provider footer');
  for (const secret of ['Sara', 'sara@test.local', '222 3344', 'Six frames']) assert.ok(!m.html.includes(secret), `no customer data: ${secret}`);
  assert.ok(!m.html.includes('0331234567890123456'), 'no IBAN in the email');

  assert.equal((await api('POST', `/api/admin/service-credits/${P.A.id}/paid`, { cookie: adminCookie, body: {} })).status, 404, 'nothing left to pay');
  const csv = await api('GET', '/api/admin/provider-payouts/export.csv', { cookie: adminCookie });
  assert.equal(csv.text.trim().split('\r\n').length, 1, 'paid fees leave the file');
});

test('the payer name comes from PROVIDER_PAYER_NAME when set', async () => {
  await paidBooking('B');
  process.env.PROVIDER_PAYER_NAME = 'Serein Consultancy FZ-LLC';
  try {
    sent.length = 0;
    const r = await api('POST', `/api/admin/service-credits/${P.B.id}/paid`, { cookie: adminCookie, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.reference, `TRV-SVC-${P.B.id}-${todayDubai()}`, 'the default reference');
    assert.equal(db.prepare('SELECT payer_name FROM provider_credits WHERE provider_id=?').get(P.B.id).payer_name, 'Serein Consultancy FZ-LLC');
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(sent.find((m) => m.to === 'mara@test.local').html.includes('Serein Consultancy FZ-LLC'));
  } finally { delete process.env.PROVIDER_PAYER_NAME; }
});

/* ---------------- the provider's statement ---------------- */

test('the provider sees waiting, payable and paid for each fee', async () => {
  const a = await payout('A');
  const byCode = Object.fromEntries(a.data.credits.map((c) => [c.code, c]));
  assert.equal(byCode[bkA.code].status, 'paid');
  assert.equal(byCode[bkA.code].reference, `TRV-SVC-${P.A.id}-${todayDubai()}`);
  assert.equal(byCode[bkA.code].payer, 'Serein Consultancy LLC');
  assert.match(byCode[bkA.code].paidOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(byCode[bkA.code].amountCents, 36000);
  assert.equal(byCode[bkA2.code].status, 'waiting');
  assert.equal(byCode[bkA2.code].payableOn, dayFromNow(8), 'service date + 3 days');
  const c = await payout('C');
  assert.equal(c.data.credits[0].status, 'payable');
  assert.equal(c.data.needsDetails, true);
  for (const res of [a, c]) {
    for (const secret of ['Sara', 'sara@test.local', '222 3344']) assert.ok(!res.text.includes(secret), 'no customer data in the statement');
  }
  // one provider never sees another's fees
  assert.ok(!c.text.includes(bkA.code));
});

test('an account with no provider profile gets no payout endpoint', async () => {
  const r = await api('GET', '/api/provider/payout', { cookie: adminCookie });
  assert.equal(r.status, 403);
  assert.equal((await api('PUT', '/api/provider/payout', { body: { useShop: true } })).status, 401);
});
