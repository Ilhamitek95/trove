'use strict';
/**
 * Didit identity checks (src/didit.js, 15 Oct 2026): a maker proves who they
 * are with an Emirates ID scan + live selfie instead of photos for the admin.
 * Didit's API is faked through didit._setTransport; nothing leaves the box.
 */
const { testEnv, startApp } = require('./helpers');
const SECRET = 'whsec_test_didit_0123456789';
testEnv({
  PAYOUT_ENC_KEY: 'a3f1c9e2b47d80561e93fa2c74b8d015c2e6a90f3b7d4188e5c0a9d2f16b3874',
  DIDIT_API_KEY: 'test-didit-key',
  DIDIT_WORKFLOW_ID: 'ff425389-0000-4000-8000-000000331730',
  DIDIT_WEBHOOK_SECRET: SECRET,
  PUBLIC_URL: 'https://troveathome.test',
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

let ctx, db, didit, cookie, shopId, adminCookie, otherCookie, otherShopId;

/* ---- a fake Didit ---- */
const fake = { sessions: new Map(), calls: [], next: 0, failCreate: null };
function decisionFor(id, over = {}) {
  const s = fake.sessions.get(id);
  return { session_id: id, status: 'Approved', vendor_data: s ? s.vendor_data : undefined, ...over };
}
const approvedUae = (over = {}) => ({
  status: 'Approved',
  id_verifications: [{
    status: 'Approved', document_type: 'Identity Card', issuing_state: 'ARE',
    personal_number: '784-1990-1234567-1', document_number: '123456789',
    expiration_date: '2031-04-30', date_of_issue: '2026-04-30', date_of_birth: '1990-05-12',
    first_name: 'Layla', last_name: 'Haddad', full_name: 'Layla Haddad',
    front_image: 'https://media.example/front.jpg', portrait_image: 'https://media.example/face.jpg', warnings: [],
  }],
  liveness_checks: [{ status: 'Approved', score: 97.2, warnings: [] }],
  face_matches: [{ status: 'Approved', score: 95.4, warnings: [] }],
  ...over,
});
async function transport(url, opts) {
  fake.calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (opts.method === 'POST' && url.endsWith('/v3/session/')) {
    if (fake.failCreate) return json(400, { detail: fake.failCreate });
    const body = JSON.parse(opts.body);
    // Didit returns the unfinished session for the same vendor_data.
    for (const [id, s] of fake.sessions) {
      if (s.vendor_data === body.vendor_data && ['Not Started', 'In Progress'].includes(s.status)) return json(201, { session_id: id, url: `https://verify.didit.me/session/${id}`, status: s.status });
    }
    const id = `sess-${++fake.next}`;
    fake.sessions.set(id, { vendor_data: body.vendor_data, status: 'Not Started', decision: { status: 'Not Started' } });
    return json(201, { session_id: id, session_token: 'tok', url: `https://verify.didit.me/session/${id}`, status: 'Not Started', vendor_data: body.vendor_data });
  }
  const m = url.match(/\/v3\/session\/([^/]+)\/decision\/$/);
  if (opts.method === 'GET' && m) {
    const s = fake.sessions.get(decodeURIComponent(m[1]));
    if (!s) return json(404, { detail: 'Not found.' });
    return json(200, { session_id: m[1], vendor_data: s.vendor_data, ...s.decision });
  }
  return json(404, { detail: 'unknown route' });
}
const setDecision = (id, decision) => { const s = fake.sessions.get(id); s.decision = decision; s.status = decision.status; };

/* ---- webhook signing, as Didit does it ---- */
const sortKeys = (x) => (Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.keys(x).sort().reduce((a, k) => { a[k] = sortKeys(x[k]); return a; }, {}) : x);
function signed(body, { secret = SECRET, ts = Math.floor(Date.now() / 1000), header = 'raw' } = {}) {
  const raw = JSON.stringify(sortKeys(body));
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, headers: { 'x-timestamp': String(ts), ...(header === 'raw' ? { 'x-signature': sig } : header === 'v2' ? { 'x-signature-v2': sig } : { 'x-signature-simple': sig }) } };
}
const hook = (body, opts) => { const s = signed(body, opts); return ctx.api('POST', '/api/identity/didit/webhook', { raw: s.raw, headers: s.headers }); };

const ADDRESS = 'Apt 1, Blue Tower, Al Quoz, Dubai';
const BANK = { iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Test Bank', accountName: 'Layla Haddad', acceptAgreement: true };
const shop = (id = shopId) => db.prepare('SELECT * FROM shops WHERE id=?').get(id);

before(async () => {
  ctx = await startApp();
  db = ctx.db;
  didit = require('../src/didit');
  didit._setTransport(transport);
  const { hashPassword } = require('../src/middleware');
  const mkUser = (email, role, name = 'Layla H') => db.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)')
    .run(email, hashPassword('testpass123'), name, role).lastInsertRowid;
  const u = mkUser('maker@test.local', 'seller');
  shopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(u, 'Layla Ceramics', 'layla-ceramics').lastInsertRowid;
  const o = mkUser('other@test.local', 'seller', 'Omar Q');
  otherShopId = db.prepare("INSERT INTO shops (user_id,name,slug,status) VALUES (?,?,?,'approved')").run(o, 'Omar Wood', 'omar-wood').lastInsertRowid;
  mkUser('admin@test.local', 'admin');
  cookie = await ctx.loginAs('maker@test.local', 'testpass123');
  otherCookie = await ctx.loginAs('other@test.local', 'testpass123');
  adminCookie = await ctx.loginAs('admin@test.local', 'testpass123');
});
after(async () => { didit._setTransport(null); await ctx.close(); });

/* ---------------- pure pieces ---------------- */

test('summarise: a UAE Identity Card with liveness and face match approved is Approved, keeping only the last four digits', () => {
  const s = didit.summarise({ session_id: 'x', ...approvedUae() });
  assert.equal(s.effective, 'Approved');
  assert.equal(s.document.last4, '5671', 'from the 15-digit 784… number, not the card number');
  assert.equal(s.document.expiry, '2031-04-30');
  assert.equal(s.name, 'Layla Haddad');
  const kept = JSON.stringify({ ...s, name: undefined });
  for (const leak of ['784199012345671', '1990-05-12', 'media.example', '123456789']) assert.ok(!kept.includes(leak), `${leak} is not kept`);
});

test("summarise: Didit's Approved is refused unless it is an in-date UAE ID with both face checks", () => {
  const idv = approvedUae().id_verifications[0];
  for (const [over, why] of [
    [{ id_verifications: [{ ...idv, issuing_state: 'ESP' }] }, /Not a UAE Emirates ID/],
    [{ id_verifications: [{ ...idv, document_type: 'Passport' }] }, /Not a UAE Emirates ID/],
    [{ id_verifications: [{ ...idv, expiration_date: '2020-01-01' }] }, /expired/],
    [{ liveness_checks: [{ status: 'Declined' }] }, /live selfie/],
    [{ face_matches: [] }, /did not match/],
    [{ id_verifications: [{ ...idv, personal_number: null, document_number: null }] }, /could not be read/],
  ]) {
    const s = didit.summarise(approvedUae(over));
    assert.equal(s.effective, 'Declined', JSON.stringify(over));
    assert.match(s.refusal, why);
    assert.match(s.reasons[0], why, 'the reason is shown to the maker');
  }
  const declined = didit.summarise({ status: 'Declined', id_verifications: [{ status: 'Declined', warnings: [{ log_type: 'error', short_description: 'Document expired' }, { log_type: 'warning', short_description: 'Low quality' }] }] });
  assert.deepEqual(declined.reasons, ['Document expired'], 'only error-level warnings');
});

test('webhook signatures: raw and V2 accepted; stale, wrong-secret and envelope-only refused', () => {
  const body = { session_id: 's', status: 'Approved', webhook_type: 'status.updated', timestamp: 1 };
  const ok = signed(body);
  assert.equal(didit.verifyWebhook(Buffer.from(ok.raw), body, ok.headers), true);
  const v2 = signed(body, { header: 'v2' });
  assert.equal(didit.verifyWebhook(Buffer.from('{"re":"encoded"}'), body, v2.headers), true, 'V2 survives a re-encoded body');
  const stale = signed(body, { ts: Math.floor(Date.now() / 1000) - 301 });
  assert.equal(didit.verifyWebhook(Buffer.from(stale.raw), body, stale.headers), false);
  const wrong = signed(body, { secret: 'nope' });
  assert.equal(didit.verifyWebhook(Buffer.from(wrong.raw), body, wrong.headers), false);
  const simple = signed(body, { header: 'simple' });
  assert.equal(didit.verifyWebhook(Buffer.from(simple.raw), body, simple.headers), false, 'X-Signature-Simple alone is not enough');
});

/* ---------------- the maker's flow ---------------- */

test('the dashboard says the check is available; starting needs the consent tick', async () => {
  const me = await ctx.api('GET', '/api/seller/me', { cookie });
  assert.equal(me.data.shop.idCheck.available, true);
  assert.equal(me.data.shop.identity.verified, false);
  const r = await ctx.api('POST', '/api/seller/identity/start', { cookie, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Tick the box/);
  assert.equal(fake.calls.length, 0, 'Didit is not called without consent');
});

test('start: creates a Didit session for this shop and records the consent', async () => {
  const r = await ctx.api('POST', '/api/seller/identity/start', { cookie, body: { consent: true } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.data.url, /^https:\/\/verify\.didit\.me\/session\//);
  const call = fake.calls.at(-1);
  assert.equal(call.headers['x-api-key'], 'test-didit-key');
  assert.equal(call.body.workflow_id, process.env.DIDIT_WORKFLOW_ID);
  assert.equal(call.body.vendor_data, `shop-${shopId}`);
  assert.equal(call.body.callback, 'https://troveathome.test/sell');
  const s = shop();
  assert.ok(s.didit_session_id);
  assert.equal(s.didit_status, 'Not Started');
  const row = db.prepare('SELECT * FROM identity_sessions WHERE session_id=?').get(s.didit_session_id);
  assert.equal(row.shop_id, shopId);
  assert.ok(row.consent_at, 'consent time recorded');
  // A second click resumes the same unfinished session.
  const again = await ctx.api('POST', '/api/seller/identity/start', { cookie, body: { consent: true } });
  assert.equal(again.data.url, r.data.url);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identity_sessions WHERE shop_id=?').get(shopId).n, 1);
});

test('payout setup with Didit on: no ID photos asked for, the home address still is', async () => {
  const noAddr = await ctx.api('POST', '/api/seller/payout-setup', { cookie, body: { ...BANK } });
  assert.equal(noAddr.status, 400);
  assert.match(noAddr.data.error, /home address/i);
  const r = await ctx.api('POST', '/api/seller/payout-setup', { cookie, body: { ...BANK, address: ADDRESS } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.shop.identity.verified, false, 'bank details alone do not establish identity');
  // Choosing the photo route still asks for the whole set.
  const partial = await ctx.api('POST', '/api/seller/payout-setup', { cookie, body: { ...BANK, emiratesIdLast4: '1234', currentPassword: 'testpass123' } });
  assert.equal(partial.status, 400);
  assert.match(partial.data.error, /expiry date|front of your Emirates ID/);
});

test('refresh: an approved check verifies the shop, from Didit’s API, and settlement accepts it', async () => {
  const sid = shop().didit_session_id;
  setDecision(sid, approvedUae());
  const r = await ctx.api('POST', '/api/seller/identity/refresh', { cookie, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.shop.identity.verified, true);
  assert.equal(r.data.shop.identity.method, 'didit');
  assert.equal(r.data.shop.emirates_id_last4, '5671');
  assert.equal(r.data.shop.emirates_id_expiry, '2031-04-30');
  assert.equal(r.data.shop.idCheck.status, 'Approved');
  assert.equal(r.data.shop.identity_name, undefined, 'the name on the ID is not in the maker payload');
  const s = shop();
  assert.equal(s.verification_method, 'didit');
  assert.ok(s.identity_checked_at);
  assert.equal(s.identity_checked_by, null, 'no admin ticked it');
  assert.equal(s.identity_name, 'Layla Haddad');
  const identity = require('../src/identity');
  assert.equal(identity.status(s).verified, true);
  assert.equal(identity.payoutNameMatches({ ...s, payout_account_name: 'Layla Haddad', name: 'X' }, 'Someone Else'), true, 'the name on the ID counts for the payout name check');
  // The stored summary holds no images, no full number, no date of birth.
  const row = db.prepare('SELECT summary FROM identity_sessions WHERE session_id=?').get(sid);
  for (const leak of ['784199012345671', '1990-05-12', 'media.example', 'Layla Haddad']) assert.ok(!row.summary.includes(leak), leak);
});

test('a Didit-verified maker: payout saves never undo it, typed ID details are ignored, and a second check is refused', async () => {
  const r = await ctx.api('POST', '/api/seller/payout-setup', {
    cookie, body: { ...BANK, bankName: 'Another Bank', currentPassword: 'testpass123', emiratesIdLast4: '9999', emiratesIdExpiry: '2035-01-01', address: 'Villa 9, Palm Street, Jumeirah, Dubai' },
  });
  assert.equal(r.status, 200, r.text);
  const s = shop();
  assert.equal(s.verification_method, 'didit');
  assert.ok(s.identity_checked_at);
  assert.equal(s.emirates_id_last4, '5671');
  assert.equal(s.seller_address, 'Villa 9, Palm Street, Jumeirah, Dubai', 'the address still updates');
  const again = await ctx.api('POST', '/api/seller/identity/start', { cookie, body: { consent: true } });
  assert.equal(again.status, 409);
});

test('admin: Shops shows the Didit result; Undo withdraws it and a repeated webhook does not bring it back', async () => {
  const list = await ctx.api('GET', '/api/admin/shops', { cookie: adminCookie });
  const row = list.data.shops.find((x) => x.id === shopId);
  assert.equal(row.identity.method, 'didit');
  assert.equal(row.identityName, 'Layla Haddad');
  assert.equal(row.idCheck.status, 'Approved');
  assert.deepEqual(row.payoutMissing, [], 'nothing stops the settlement run paying this maker');
  const undo = await ctx.api('POST', `/api/admin/shops/${shopId}/identity-check`, { cookie: adminCookie, body: { checked: false } });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(undo.data.identity.verified, false);
  const sid = shop().didit_session_id;
  const h = await hook({ session_id: sid, status: 'Approved', webhook_type: 'status.updated', vendor_data: `shop-${shopId}`, timestamp: Math.floor(Date.now() / 1000) });
  assert.equal(h.status, 200, h.text);
  assert.equal(require('../src/identity').status(shop()).verified, false, 'the withdrawn approval stays withdrawn');
});

test('a new check after a withdrawal: In Review by webhook shows in Needs you, then Declined reaches the maker', async () => {
  const st = await ctx.api('POST', '/api/seller/identity/start', { cookie, body: { consent: true } });
  assert.equal(st.status, 200, st.text);
  const sid = shop().didit_session_id;
  setDecision(sid, { status: 'In Review', id_verifications: [{ status: 'In Review', warnings: [] }] });
  // Unsigned or forged: refused before Didit is asked anything.
  const before = fake.calls.length;
  const forged = await ctx.api('POST', '/api/identity/didit/webhook', { raw: JSON.stringify({ session_id: sid, webhook_type: 'status.updated' }), headers: { 'x-timestamp': String(Math.floor(Date.now() / 1000)), 'x-signature': 'deadbeef' } });
  assert.equal(forged.status, 401);
  assert.equal(fake.calls.length, before);
  // Signed: the decision is re-read from Didit (the body's claim is ignored).
  const h = await hook({ session_id: sid, status: 'Approved', webhook_type: 'status.updated', timestamp: 1, decision: approvedUae() });
  assert.equal(h.status, 200, h.text);
  assert.equal(h.data.status, 'In Review', 'Didit’s API, not the webhook body, decides');
  assert.equal(require('../src/identity').status(shop()).reason, 'id_in_review');
  const ops = require('../src/admin-ops').needsYou();
  assert.ok(ops.find((x) => x.key === 'id_reviews' && x.count === 1), 'the owner sees it under Needs you');
  // The owner declines it in the Didit console → webhook.
  setDecision(sid, { status: 'Declined', id_verifications: [{ status: 'Declined', warnings: [{ log_type: 'error', short_description: 'Document is a screen capture' }] }] });
  await hook({ session_id: sid, status: 'Declined', webhook_type: 'status.updated', timestamp: 1 });
  const me = await ctx.api('GET', '/api/seller/me', { cookie });
  assert.equal(me.data.shop.identity.reason, 'id_declined');
  assert.deepEqual(me.data.shop.idCheck.reasons, ['Document is a screen capture']);
});

test('Didit says Approved for a non-UAE document: Trove refuses it and tells the maker why', async () => {
  const st = await ctx.api('POST', '/api/seller/identity/start', { cookie, body: { consent: true } });
  assert.equal(st.status, 200, st.text);
  const sid = shop().didit_session_id;
  const idv = approvedUae().id_verifications[0];
  setDecision(sid, approvedUae({ id_verifications: [{ ...idv, issuing_state: 'GBR', document_type: 'Passport' }] }));
  const r = await ctx.api('POST', '/api/seller/identity/refresh', { cookie, body: {} });
  assert.equal(r.data.shop.identity.verified, false);
  assert.equal(r.data.shop.idCheck.status, 'Declined');
  assert.ok(r.data.shop.idCheck.reasons.includes('Not a UAE Emirates ID'));
});

test('webhooks for sessions Trove did not start, or other events, are ignored', async () => {
  const before = fake.calls.length;
  const r = await hook({ session_id: 'someone-elses', status: 'Approved', webhook_type: 'status.updated', timestamp: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.ignored, true);
  const u = await hook({ vendor_user_id: 'x', status: 'BLOCKED', webhook_type: 'user.status.updated', timestamp: 1 });
  assert.equal(u.data.ignored, true);
  assert.equal(fake.calls.length, before, 'Didit is not asked about them');
});

test('Didit out of credits: the maker is offered the photo route and the owner is told', async () => {
  fake.failCreate = "You don't have enough credits to perform this request. Please top up at https://business.didit.me";
  try {
    const r = await ctx.api('POST', '/api/seller/identity/start', { cookie: otherCookie, body: { consent: true } });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /photos of your Emirates ID/);
    const job = require('../src/job-runs').status().find((j) => j.job === 'identity');
    assert.ok(job && job.failing, 'Background jobs shows it');
    assert.doesNotMatch(job.lastError, /test-didit-key/, 'the key never lands in a log');
  } finally { fake.failCreate = null; }
});

test('at most five checks a day per shop', async () => {
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO identity_sessions (shop_id, session_id, status, consent_at) VALUES (?, ?, 'Abandoned', datetime('now'))").run(otherShopId, `old-${i}`);
  const r = await ctx.api('POST', '/api/seller/identity/start', { cookie: otherCookie, body: { consent: true } });
  assert.equal(r.status, 429);
});

test('the hourly sweep re-reads open sessions and applies them', async () => {
  // A fresh approved-later session for the first maker.
  db.prepare("DELETE FROM identity_sessions WHERE shop_id=? AND created_at > datetime('now','-1 day')").run(shopId);
  const st = await ctx.api('POST', '/api/seller/identity/start', { cookie, body: { consent: true } });
  assert.equal(st.status, 200, st.text);
  const sid = shop().didit_session_id;
  setDecision(sid, approvedUae());
  const out = await didit.sweepOpen();
  assert.ok(out.checked >= 1);
  assert.equal(require('../src/identity').status(shop()).verified, true, 'verified without the maker coming back');
});

test('privacy: the export lists the Didit result; deleting ID documents removes it', () => {
  const user = db.prepare('SELECT * FROM users WHERE email=?').get('maker@test.local');
  const exp = require('../src/privacy').exportData(user.email);
  assert.equal(exp.shop.identityCheck.provider, 'Didit');
  assert.equal(exp.shop.identityCheck.nameOnId, 'Layla Haddad');
  assert.equal(exp.shop.identityCheck.verified, true);
  // The wipe the retention sweep and 'delete ID documents' use.
  db.prepare("UPDATE shops SET closed_at=datetime('now','-6 years'), status='suspended' WHERE id=?").run(shopId);
  require('../src/privacy').sweep();
  const s = shop();
  assert.equal(s.identity_name, null);
  assert.equal(s.didit_session_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identity_sessions WHERE shop_id=?').get(shopId).n, 0);
});
