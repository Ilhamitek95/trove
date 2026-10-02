'use strict';
/**
 * The server-rendered public pages (src/site-pages.js): About, Contact, the
 * Help centre, Delivery & Returns, the Terms of Sale, the Privacy Policy and
 * the three agreements. Each must carry its real text in the raw HTML (no
 * JavaScript, no "Loading…"), the company details must come from Site
 * content and read as a neutral line until the owner fills them in, the
 * contact form must validate, store and rate-limit, and the crawler files
 * (robots, sitemap, llms.txt) must point at all of it.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });

const DOCS = path.join(__dirname, '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');

let ctx; let adminCookie;
before(async () => {
  ctx = await startApp();
  const { hashPassword } = require('../src/middleware');
  ctx.db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@test.local', ?, 'Admin', 'admin')").run(hashPassword('adminpass123'));
  adminCookie = await ctx.loginAs('admin@test.local', 'adminpass123');
});
after(async () => { await ctx.close(); });

const get = (p) => ctx.api('GET', p);
// Visible text of a page: scripts, styles and tags stripped.
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

// Every contact POST gets its own client address, so the 5-per-10-minutes
// limit only bites where a test means it to.
let ipSeq = 0;
async function contact(body, { ip = `10.0.0.${++ipSeq}`, form = false, cookie } = {}) {
  const res = await fetch(ctx.baseUrl + '/api/contact', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const GOOD = { name: 'Layla Haddad', email: 'layla@example.com', topic: 'order', orderRef: 'TRV-1A2B3C', message: 'Hello, my parcel has not arrived yet — could you check?' };

const PAGES = {
  '/about': ['About Trove', 'How curation works', 'A real person reviews every application', 'Dubai and Abu Dhabi', 'seller of every product', '15 days of delivery'],
  '/contact': ['Contact us', 'Send message', 'Privacy Policy'],
  '/faq': ['Help centre', 'Who am I buying from?', 'fortnightly, every other Tuesday', '15 days of delivery', 'the provider, not Trove, is responsible for the service'],
  '/returns': ['Delivery & Returns', '15 days of the day it was delivered', 'AED 30 delivery', 'free delivery', 'We refund you once the courier has collected the return', 'There is never a collection fee when a piece is faulty, damaged or not what you ordered', 'Personalised pieces'],
  '/delivery-returns': ['Delivery & Returns', '15 days of the day it was delivered'],
  '/terms': ['Terms of Sale', 'Trove is the seller of every product you buy on troveathome.com', 'Dubai and Abu Dhabi only', 'Stripe', '15 days of delivery', 'AED 30 on orders of AED 200 and below', 'no collection fee when a piece is faulty, damaged or not what you ordered', 'Federal Law No. 15 of 2020'],
  '/privacy': ['Privacy Policy', 'Federal Decree-Law No. 45 of 2021', 'anonymous visitor id', 'Emirates ID', 'IBAN', 'Stripe', 'OTO', 'Resend', 'Render', 'Google', 'Anthropic', 'Your rights'],
};

for (const [p, needles] of Object.entries(PAGES)) {
  test(`${p} returns its real text in the raw HTML, no JavaScript needed`, async () => {
    const res = await get(p);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const text = visible(res.text);
    for (const n of needles) assert.ok(text.includes(n), `${p} is missing: ${n}`);
    assert.doesNotMatch(res.text, /Loading…/);
    assert.doesNotMatch(res.text, /<meta name="robots" content="noindex">/);
    assert.match(res.text, /<link rel="canonical" href="https:\/\/troveathome\.com\//);
    assert.match(res.text, /<meta property="og:title"/);
    assert.doesNotMatch(res.text, /href="#"/, `${p} has a placeholder link`);
    assert.doesNotMatch(res.text, /font-style:\s*italic/);
  });
}

test('/delivery-returns is the same page, canonical at /returns', async () => {
  const res = await get('/delivery-returns');
  assert.match(res.text, /<link rel="canonical" href="https:\/\/troveathome\.com\/returns">/);
});

test('the agreements render their current version server-side, picked from config.js', async () => {
  const config = require('../src/config');
  for (const [p, file, v] of [
    ['/seller-agreement', 'seller-agreement', config.AGREEMENT_VERSION],
    ['/provider-agreement', 'provider-agreement', config.PROVIDER_AGREEMENT_VERSION],
    ['/services-terms', 'services-terms', config.SERVICES_TERMS_VERSION],
  ]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(res.text, /Loading…/, p);
    const src = fs.readFileSync(path.join(__dirname, '..', 'legal', `${file}-${v}.md`), 'utf8');
    const firstHeading = src.match(/^## (.+)$/m)[1].replace(/\*\*/g, '');
    assert.ok(visible(res.text).includes(firstHeading), `${p} carries the text of ${file}-${v}.md`);
    assert.ok(visible(res.text).includes(`Version ${v}`), `${p} shows version ${v}`);
    const api = await get(`/api/legal/${file}`);
    assert.ok(res.text.includes(api.data.sha256), `${p} shows the document hash`);
  }
  // the old static files are gone and their addresses redirect
  for (const f of ['seller-agreement.html', 'provider-agreement.html', 'services-terms.html']) {
    assert.ok(!fs.existsSync(path.join(DOCS, f)), `${f} should no longer exist`);
    const r = await get('/' + f);
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/' + f.replace('.html', ''));
  }
});

test('the buyer terms and privacy policy are served by /api/legal with version and hash', async () => {
  for (const [doc, needle, version] of [['terms', 'seller of every product', 'v3'], ['buyer-terms', 'seller of every product', 'v3'], ['privacy', 'Personal Data Protection Law', 'v2']]) {
    const r = await get('/api/legal/' + doc);
    assert.equal(r.status, 200, doc);
    assert.equal(r.data.version, version, doc);
    assert.ok(r.data.markdown.includes(needle), doc);
    assert.match(r.data.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal((await get('/api/legal/constructor')).status, 404, 'no prototype keys resolve');
});

test('how curation works has its own address, pointing at the About section', async () => {
  const r = await get('/how-curation-works');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/about#curation');
  assert.match((await get('/about')).text, /<h2 id="curation">How curation works<\/h2>/);
});

test('the FAQ carries FAQPage structured data built from the same questions', async () => {
  const res = await get('/faq');
  const graph = ldBlocks(res.text).flatMap((b) => b['@graph'] || [b]);
  const faq = graph.find((n) => n['@type'] === 'FAQPage');
  assert.ok(faq, 'FAQPage present');
  assert.ok(faq.mainEntity.length >= 15);
  const q = faq.mainEntity.find((e) => e.name === 'Who am I buying from?');
  assert.match(q.acceptedAnswer.text, /Trove is the seller of every product/);
  for (const e of faq.mainEntity) assert.ok(visible(res.text).includes(e.name), `question on the page: ${e.name}`);
  assert.match(res.text, /id="makers"/, 'the maker handbook anchor exists');
});

test('company details default to Serein Consultancy LLC, the company behind Trove (owner, 2026-10-02)', async () => {
  const content = require('../src/content');
  assert.deepEqual(content.DEFAULTS['site.company'], {
    legalName: 'Serein Consultancy LLC',
    tradeLicence: '2220356.01',
    licenceAuthority: 'Sharjah Media City (Shams), Sharjah, UAE',
    address: 'Sharjah Media City (Shams), Sharjah, United Arab Emirates',
    email: 'hello@troveathome.com',
    whatsapp: '',
    vatTrn: '104316607100003',
  });
  for (const p of ['/about', '/contact', '/terms', '/privacy']) {
    const res = await get(p);
    const text = visible(res.text);
    assert.ok(text.includes('Serein Consultancy LLC'), p);
    assert.ok(text.includes('2220356.01, Sharjah Media City (Shams), Sharjah, UAE'), p);
    assert.ok(text.includes('Trove and Trove at Home'), `${p}: the brand names`);
    assert.ok(!text.includes('VAT TRN'), `${p}: no VAT number until the owner decides`);
    assert.ok(!text.includes('being finalised'), p);
    const org = ldBlocks(res.text)[0]['@graph'][0];
    assert.equal(org.legalName, 'Serein Consultancy LLC', p);
    assert.equal(org.vatID, undefined, p);
    assert.equal(org.contactPoint.email, 'hello@troveathome.com', p);
    assert.equal(org.contactPoint.telephone, undefined, `${p}: no WhatsApp number invented`);
  }
  assert.match((await get('/llms.txt')).text, /Legal name: Serein Consultancy LLC/);
});

test('every legal document names the contracting company and its licence', async () => {
  for (const doc of ['terms', 'privacy', 'seller-agreement', 'provider-agreement', 'services-terms']) {
    const md = (await ctx.api('GET', `/api/legal/${doc}`)).data.markdown;
    assert.match(md, /Serein Consultancy\s+LLC/, doc);
    assert.match(md, /Sharjah Media City \(Shams\)/, doc);
    assert.match(md, /2220356\.01/, doc);
    assert.match(md, /Trove and Trove at Home are (?:its )?brand names/, doc);
  }
});

test('an all-blank saved company override no longer hides the company (migration 022-E)', async () => {
  const mig = require('../src/migrations/022-E-company-identity');
  ctx.db.prepare("INSERT OR REPLACE INTO site_content (section, value) VALUES ('site.company', ?)")
    .run(JSON.stringify({ legalName: '', tradeLicence: '', licenceAuthority: '', address: '', email: '', whatsapp: '', vatTrn: '' }));
  assert.ok(visible((await get('/about')).text).includes('being finalised'), 'a blank override hides the defaults');
  mig.up(ctx.db);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM site_content WHERE section='site.company'").get().n, 0);
  assert.ok(visible((await get('/about')).text).includes('Serein Consultancy LLC'));
  // The owner's own wording is never touched.
  ctx.db.prepare("INSERT OR REPLACE INTO site_content (section, value) VALUES ('site.company', ?)")
    .run(JSON.stringify({ legalName: 'Owner wording LLC', tradeLicence: '', licenceAuthority: '', address: '', email: '', whatsapp: '', vatTrn: '' }));
  mig.up(ctx.db);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM site_content WHERE section='site.company'").get().n, 1);
  ctx.db.prepare("DELETE FROM site_content WHERE section='site.company'").run();
});

test('the owner fills the company details in Site content and every page picks them up', async () => {
  const content = require('../src/content');
  const bad = await ctx.api('PUT', '/api/admin/content/site.company', { cookie: adminCookie, body: { ...content.DEFAULTS['site.company'], email: 'not-an-email' } });
  assert.equal(bad.status, 422);
  const markup = await ctx.api('PUT', '/api/admin/content/site.company', { cookie: adminCookie, body: { ...content.DEFAULTS['site.company'], legalName: '<b>Trove</b>' } });
  assert.equal(markup.status, 422);
  const body = { legalName: 'Trove Home Trading L.L.C', tradeLicence: '1234567', licenceAuthority: 'Dubai DET', address: 'Office 1, Example Tower, Dubai', email: 'hello@troveathome.com', whatsapp: '+971 50 123 4567', vatTrn: '' };
  const ok = await ctx.api('PUT', '/api/admin/content/site.company', { cookie: adminCookie, body });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const about = await get('/about');
  const text = visible(about.text);
  assert.ok(text.includes('Trove Home Trading L.L.C'));
  assert.ok(text.includes('1234567, Dubai DET'));
  assert.ok(!text.includes('VAT TRN'), 'a blank field is not shown');
  assert.ok(!text.includes('being finalised'));
  const contactPage = await get('/contact');
  assert.match(contactPage.text, /href="mailto:hello@troveathome\.com"/);
  assert.match(contactPage.text, /href="https:\/\/wa\.me\/971501234567"/);
  const org = ldBlocks(about.text)[0]['@graph'][0];
  assert.equal(org.legalName, 'Trove Home Trading L.L.C');
  assert.equal(org.contactPoint.email, 'hello@troveathome.com');
  assert.equal(org.contactPoint.telephone, '+971501234567');
  const store = ldBlocks((await get('/')).text)[0]['@graph'][0];
  assert.equal(store.contactPoint.email, 'hello@troveathome.com');
  assert.match((await get('/llms.txt')).text, /Legal name: Trove Home Trading L\.L\.C/);
  // Every field blanked: the neutral line, never made-up details.
  const blank = await ctx.api('PUT', '/api/admin/content/site.company', { cookie: adminCookie, body: { legalName: '', tradeLicence: '', licenceAuthority: '', address: '', email: '', whatsapp: '', vatTrn: '' } });
  assert.equal(blank.status, 200, JSON.stringify(blank.data));
  assert.ok(visible((await get('/about')).text).includes('Company details are being finalised — write to us via the contact form'));
  assert.match((await get('/llms.txt')).text, /Company details: being finalised/);
  // Removing the override goes back to the defaults.
  await ctx.api('DELETE', '/api/admin/content/site.company', { cookie: adminCookie });
  assert.ok(visible((await get('/about')).text).includes('Serein Consultancy LLC'));
});

test('the storefront carries Organization + OnlineStore structured data', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  const org = ldBlocks(res.text)[0]['@graph'][0];
  assert.deepEqual(org['@type'], ['Organization', 'OnlineStore']);
  assert.equal(org.name, 'Trove');
  assert.equal(org.alternateName, 'Trove at Home');
  assert.equal(org.url, 'https://troveathome.com/');
  assert.match(org.logo, /^https:\/\/troveathome\.com\//);
  assert.deepEqual(org.areaServed.map((a) => a.name), ['Dubai', 'Abu Dhabi']);
  assert.equal(org.hasMerchantReturnPolicy.merchantReturnDays, 15);
});

/* ---- contact form ---- */

test('contact form: validation', async () => {
  for (const [body, re] of [
    [{ ...GOOD, name: '' }, /name/],
    [{ ...GOOD, name: '<script>' }, /name/],
    [{ ...GOOD, email: 'nope' }, /email/],
    [{ ...GOOD, message: 'hi' }, /a little more/],
    [{ ...GOOD, message: 'x'.repeat(4001) }, /4,000/],
    [{ ...GOOD, topic: 'refund-me-now' }, /choose/],
    [{ ...GOOD, orderRef: 'TRV 1; DROP' }, /Order numbers/],
  ]) {
    const r = await contact(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(r.data.error, re);
  }
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n, 0, 'nothing invalid is stored');
});

test('contact form: a good message is stored (then emailed) and the admin can read and tick it off', async () => {
  const r = await contact(GOOD);
  assert.equal(r.status, 201);
  const row = ctx.db.prepare('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.name, 'Layla Haddad');
  assert.equal(row.email, 'layla@example.com');
  assert.equal(row.topic, 'order');
  assert.equal(row.order_ref, 'TRV-1A2B3C');
  assert.equal(row.handled_at, null);

  assert.equal((await ctx.api('GET', '/api/contact/messages')).status, 401, 'not public');
  const list = await ctx.api('GET', '/api/contact/messages', { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.open, 1);
  assert.equal(list.data.messages[0].topicLabel, 'An order');
  const done = await ctx.api('PATCH', `/api/contact/messages/${row.id}`, { cookie: adminCookie, body: { handled: true } });
  assert.equal(done.status, 200);
  assert.ok(ctx.db.prepare('SELECT handled_at FROM contact_messages WHERE id=?').get(row.id).handled_at);
  assert.equal((await ctx.api('GET', '/api/contact/messages', { cookie: adminCookie })).data.open, 0);
});

test('contact form: the honeypot swallows bot posts without storing them', async () => {
  const before_ = ctx.db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n;
  const r = await contact({ ...GOOD, website: 'http://spam.example' });
  assert.equal(r.status, 201);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n, before_);
});

test('contact form: works without JavaScript (form post → redirect back)', async () => {
  const ok = await contact(GOOD, { form: true });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/contact?sent=1');
  const page = await get('/contact?sent=1');
  assert.ok(visible(page.text).includes('your message is with us'));
  const bad = await contact({ ...GOOD, email: 'x' }, { form: true });
  assert.equal(bad.status, 303);
  assert.match(bad.headers.get('location'), /^\/contact\?error=/);
  const errPage = await get(bad.headers.get('location'));
  assert.ok(visible(errPage.text).includes('Please give an email address'));
  assert.doesNotMatch(errPage.text, /<script>alert/);
  const xss = await get('/contact?error=' + encodeURIComponent('<script>alert(1)</script>'));
  assert.doesNotMatch(xss.text, /<script>alert\(1\)<\/script>/, 'the error text is escaped');
});

test('contact form: rate-limited to 5 messages per 10 minutes per visitor', async () => {
  const ip = '10.9.9.9';
  for (let i = 0; i < 5; i++) assert.equal((await contact(GOOD, { ip })).status, 201, `message ${i + 1}`);
  const sixth = await contact(GOOD, { ip });
  assert.equal(sixth.status, 429);
  assert.equal((await contact(GOOD, { ip: '10.9.9.10' })).status, 201, 'another visitor is unaffected');
});

/* ---- crawler files ---- */

test('llms.txt and llms-full.txt are plain text with accurate facts', async () => {
  const r = await get('/llms.txt');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  for (const n of ['# Trove', 'Trove at Home', 'Dubai and Abu Dhabi', 'seller of record', 'Stripe', 'AED 30 on orders of AED 200 and below', 'within 15 days of delivery', 'fortnightly, every other Tuesday', 'https://troveathome.com/about', 'https://troveathome.com/returns', 'https://troveathome.com/faq', 'https://troveathome.com/apply', 'https://troveathome.com/llms-full.txt']) {
    assert.ok(r.text.includes(n), `llms.txt: ${n}`);
  }
  const full = await get('/llms-full.txt');
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-type'), /^text\/plain/);
  for (const n of ['How curation works', 'Delivery & Returns', 'Who am I buying from?', 'Company details', 'https://troveathome.com/terms']) {
    assert.ok(full.text.includes(n), `llms-full.txt: ${n}`);
  }
  assert.doesNotMatch(full.text, /\{#|\*\*/, 'no markdown markers leak');
});

test('robots.txt no longer blocks the agreements; the sitemap lists the new pages', async () => {
  const robots = (await get('/robots.txt')).text;
  assert.match(robots, /Allow: \/seller-agreement/);
  assert.match(robots, /Allow: \/provider-agreement/);
  assert.match(robots, /Disallow: \/sell\n/);
  assert.match(robots, /Disallow: \/provider\n/);
  const map = (await get('/sitemap.xml')).text;
  for (const p of ['/about', '/returns', '/faq', '/contact', '/terms', '/privacy', '/seller-agreement', '/provider-agreement', '/services-terms']) {
    assert.match(map, new RegExp(`<loc>https://troveathome\\.com${p}</loc>`), p);
  }
  assert.doesNotMatch(map, /delivery-returns/, 'the alias stays out of the sitemap');
});

/* ---- links on the static pages ---- */

test('no footer on any page links to #, and Privacy · Terms are real links', () => {
  const store = read('trove.html');
  const footer = store.match(/<footer class="site">[\s\S]*?<\/footer>/)[0];
  assert.doesNotMatch(footer, /href="#"/);
  for (const p of ['/privacy', '/terms', '/about', '/about#curation', '/faq', '/contact', '/faq#makers', '/#weekly']) {
    assert.ok(footer.includes(`href="${p}"`), `storefront footer links ${p}`);
  }
  assert.match(store, /<section class="band" id="weekly"/);
  const services = read('trove-services.html').match(/<footer class="site">[\s\S]*?<\/footer>/)[0];
  assert.doesNotMatch(services, /href="#"/);
  for (const p of ['/privacy', '/terms', '/contact', '/about']) assert.ok(services.includes(`href="${p}"`), `services footer links ${p}`);
});

test('checkout and sign-up say what the customer agrees to, with links', () => {
  const store = read('trove.html');
  const summary = store.match(/<button class="co-place"[\s\S]{0,400}/)[0];
  assert.match(summary, /By placing your order you agree to our <a href="\/terms"[^>]*>Terms of Sale<\/a> and <a href="\/privacy"[^>]*>Privacy Policy<\/a>/);
  assert.match(store, /async function placeOrder\(\)\{/, 'checkout logic untouched');
  const login = read('trove-login.html');
  assert.match(login, /<span id="regAgreeLead">By continuing with Google or creating an account<\/span> you agree to our <a href="\/terms"[^>]*>Terms of Sale<\/a> and <a href="\/privacy"[^>]*>Privacy Policy<\/a>/);
  // F295: a first Google sign-in opens an account, so the line shows in sign-in mode too.
  assert.match(login, /\$\('regAgree'\)\.style\.display='block'/, 'shown while signing in as well as signing up');
  assert.match(login, /text:'continue_with'/, 'the Google button says Continue, not Sign in');
});

test('the default copy never promises Collection pieces; the Collection is never hidden (owner, 2026-09-30)', () => {
  const { DEFAULTS } = require('../src/content');
  assert.doesNotMatch(DEFAULTS['home.hero'].lead, /Trove Collection/);
  assert.doesNotMatch(DEFAULTS['site.footer'].blurb, /Trove Collection/);
  const store = read('trove.html');
  assert.doesNotMatch(store, /no-house|NO_HOUSE_COPY/, 'no runtime hiding of the Collection');
  // before its first piece the band says what is coming instead
  assert.match(store, /<div class="copy soon-copy">[\s\S]*?The Trove Collection — our own line — is on its way\.[\s\S]*?<a class="btn btn-dark" href="\/shop">Explore the Marketplace<\/a>/);
  assert.match(store, /head='Our own line lands soon'/);
});
