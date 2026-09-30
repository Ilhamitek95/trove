'use strict';
/**
 * The live site holds one shop, one piece and one provider. Every public view
 * must look intentional with one of each AND with many: this seeds the demo
 * catalogue, checks the many-piece layouts, then hides all but one piece /
 * maker / provider and checks the small-catalogue layouts the server draws
 * (the storefront's script redraws the same markup, so nothing moves).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });

const DOCS = path.join(__dirname, '..', '..', 'docs');
const store = fs.readFileSync(path.join(DOCS, 'trove.html'), 'utf8');
let ctx; let db;
before(async () => { ctx = await startApp(); require('../src/seed'); db = ctx.db; });
after(async () => { await ctx.close(); });

const get = (p) => ctx.api('GET', p, { headers: { accept: 'text/html' } });
const noScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ');
const rawH1 = (html) => (html.match(/<h1[\s>]/g) || []).length;
const MUG = () => db.prepare("SELECT p.id, p.name FROM products p WHERE p.image_seed = 'mug7'").get();

/* ---------------- many pieces (the seeded demo catalogue) ---------------- */
test('many pieces: the carousel hero, browse tiles and the weekly grid stay as they are', async () => {
  const html = noScripts((await get("/")).text);
  assert.match(html, /<div class="hstage" id="heroStage" tabindex="0" aria-roledescription="carousel"/);
  assert.doesNotMatch(html, /class="hsolo"/);
  assert.match(html, /<div class="pgrid" id="trendingGrid">/);
  assert.doesNotMatch(html, /<html lang="en" class="[^"]*few-pieces/);
  assert.doesNotMatch(html, /<html lang="en" class="[^"]*house-soon/, 'the seed has Trove Collection pieces');
  assert.match(html, /<div class="copy live-copy">/, 'the Collection band, as it always was');
});

test('the storefront script draws the same small-catalogue layouts the server does', () => {
  for (const needle of ['function heroSoloHTML(', 'function firstPieceHTML(', 'function renderMakerStory(', "classList.toggle('few-pieces',few)", "stage.classList.toggle('solo',solo)"]) {
    assert.ok(store.includes(needle), needle);
  }
  // carousel controls only exist for two or more pieces
  assert.match(store, /\.hstage\.solo \.hs-bar\{visibility:hidden\}/);
  // the maker story is real shop data only: name, place, joined month, bio, link
  assert.match(store, /<section class="band" id="makerStory"[^>]*hidden>/);
  assert.match(store, /'On Trove since '\+sinceLabel\(v\)/);
  // the sell band's figures, the share from the live commission
  assert.match(store, /<b id="sfShare">60%<\/b>/);
  assert.match(store, /100-Number\(FEES\.commissionPercent\)/);
});

/* ---------------- one piece, one maker, the Collection still to come ---------------- */
test('one piece: the server draws the editorial hero and The first piece; the Collection stays, coming soon', async () => {
  const mug = MUG();
  db.prepare("UPDATE products SET status = 'hidden' WHERE id != ?").run(mug.id);
  const res = await get('/');
  assert.equal(res.status, 200);
  const html = res.text;
  assert.match(html, /<html lang="en" class="house-soon few-pieces">/);
  assert.match(html, /<div class="hstage solo" id="heroStage" aria-label="Featured piece">/);
  assert.match(html, /<a class="hsolo" href="\/pieces\/\d+-reeded-stoneware-mug">/);
  assert.match(html, /<span class="hs-meta">Made in Alserkal Avenue, Dubai<\/span>/, 'where it was made, from the shop');
  assert.match(html, /<span class="hs-by">by Kiln &amp; Clay<\/span>/);
  assert.match(html, /<div class="firsts n1" id="trendingGrid">/);
  assert.match(html, /id="weeklyHeading"[^>]*>The first piece</);
  // the original two-way hero: Shop the Collection + Explore the Marketplace
  assert.match(html, /<button class="btn btn-dark" id="heroShopBtn"[^>]*>Shop the Collection<\/button>/);
  assert.match(html, /<a class="txt-link" id="heroMarketLink"[^>]*>Explore the Marketplace<\/a>/);
  // the stock stand-in photo is labelled as such wherever it shows
  assert.equal((noScripts(html).match(/class="illus">Illustrative photo</g) || []).length, 2);
  assert.equal(rawH1(noScripts(html)), 1);
});

/* ---------------- the shelf (/shop) ---------------- */
test('the shelf: the full filter rail even with one piece, a short shelf gets a bigger grid, quick add sits under the price', async () => {
  // (runs after the one-piece test above: one live piece)
  const html = (await get('/shop')).text;
  assert.doesNotMatch(html, /no-filters/, 'the rail is always there (owner, 2026-09-30)');
  assert.doesNotMatch(store, /no-filters|\.hidden=!on/, 'no filter group or rail is ever hidden by the script');
  assert.match(html, /<label class="fitem fhouse"><input type="checkbox" id="fltHouse"[^>]*> Trove Collection only<\/label>/);
  assert.match(html, /<select id="fltShop"/);
  assert.match(html, /<input type="checkbox" id="fltSale"[^>]*> On sale only/);
  assert.match(store, /<button class="f-open-btn" onclick="openFilters\(\)">/, 'the phone Filter sheet button');
  assert.match(html, /<div class="pgrid few one" id="shopGrid">/);
  assert.match(noScripts(html), /<button class="add add-row" onclick="event\.stopPropagation\(\);addToCart\(\d+,this\)">Add to basket<\/button>/);
  for (const id of ['fgCat', 'fgSeller', 'fgOffers', 'fgPrice']) assert.match(store, new RegExp(`class="fgroup" id="${id}"`));
  assert.match(store, /const inPillar=p=>state\.cat!=='House'/, 'facet counts follow the pillar');
  assert.match(store, /opt\.hidden=!rated;opt\.disabled=!rated;/, 'Top rated waits for real ratings');
  assert.match(store, /\.card \.ph \.add\{display:none\}/, 'touch: no quick add over the photo');
  // many pieces again
  db.prepare("UPDATE products SET status = 'live' WHERE status = 'hidden'").run();
  const many = (await get('/shop')).text;
  assert.match(many, /<div class="pgrid" id="shopGrid">/);
  db.prepare("UPDATE products SET status = 'hidden' WHERE id != ?").run(MUG().id);
});

/* ---------------- a piece (PDP) ---------------- */
test('a piece: one photo has no thumbnail rail, details come only from real fields, Trove is the seller of record', async () => {
  const mug = MUG();
  const html = (await get(`/pieces/${mug.id}-reeded-stoneware-mug`)).text;
  const page = noScripts(html);
  assert.match(page, /<div class="gallery one" id="pdpGallery">/);
  assert.match(page, /<span class="illus" id="pdpIllus">Illustrative photo<\/span>/);
  assert.match(page, /Made by <a class="vlink" id="pdpVendorLink" href="\/makers\/kiln-and-clay">Kiln &amp; Clay<\/a> · Sold and delivered by Trove/);
  // the accordion: Details + About the maker, nothing invented
  assert.match(page, /<details class="acc" open><summary>Details/);
  assert.match(page, /<dt>Category<\/dt><dd>Ceramics<\/dd>/);
  assert.doesNotMatch(page, /Trove reference|TRV-\d/, 'no internal ids on the product page (owner, 2026-09-30)');
  assert.match(page, /<summary>About the maker/);
  for (const invented of [/Dimensions/, /Dishwasher/i, /Care<\/summary>/, /Lead time/]) assert.doesNotMatch(page, invented);
  // personalised pieces: the returns rule is said under the field, which is 16px on phones
  assert.match(store, /can be returned only if it arrives faulty, damaged, wrong or not as described\. Everything else on Trove has 15-day returns\./);
  assert.match(store, /<textarea id="pdpPersoText" class="perso-in"/);
  assert.match(store, /#pdpPersoText\{font-size:16px\}|,#pdpPersoText\{font-size:16px\}/);
  assert.match(store, /<label class="lbl" for="pdpPersoText"/);
  // delivery facts as a short list; the phone buy bar
  assert.match(page, /<ul class="ship-list" aria-label="Delivery and returns">/);
  assert.match(store, /<div class="pdp-bar" id="pdpBar" aria-hidden="true">/);
  assert.doesNotMatch(page, /Sold &amp; shipped by/);
  assert.equal(rawH1(page), 1);
});

/* ---------------- a maker's page ---------------- */
test('a maker: Pieces by <maker>, a meta line with the joined month, the calm panel instead of a stock cover', async () => {
  db.prepare("UPDATE shops SET image = 'https://images.unsplash.com/photo-1470058869958-2a77ade41c02?auto=format&fit=crop&w=900&q=72' WHERE slug = 'kiln-and-clay'").run();
  const joined = db.prepare("SELECT created_at FROM shops WHERE slug = 'kiln-and-clay'").get().created_at;
  const month = new Date(String(joined).slice(0, 7) + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const page = noScripts((await get('/makers/kiln-and-clay')).text);
  assert.match(page, /id="vPiecesHead">Pieces by Kiln &amp; Clay</);
  assert.doesNotMatch(page, />The collection</);
  assert.match(page, new RegExp(`id="vMeta">Alserkal Avenue, Dubai · On Trove since ${month} · 1 piece( · [0-9.]+★ from [0-9]+ reviews?)?<`));
  assert.doesNotMatch(page, /1 Pieces/);
  assert.match(page, /<div class="grad vpanel" id="vheroGrad" style="--t0:#[0-9A-Fa-f]{6};--t1:#[0-9a-f]{6}"/, 'a stock shop image is not shown as the maker cover');
  assert.doesNotMatch(page, /images\.unsplash\.com\/photo-1470058869958/);
  assert.match(page, /<div class="pgrid few one" id="vendorProducts">/);
  assert.match(page, /class="illus">Illustrative photo</);
  // the API hands over the joined month for the storefront's own drawing
  const { data } = await ctx.api('GET', '/api/shops/kiln-and-clay');
  assert.match(data.shop.joined, /^\d{4}-\d{2}$/);
  assert.match(store, /\$\('vPiecesHead'\)\.textContent='Pieces by '\+v\.name/);
});

/* ---------------- the Services Marketplace ---------------- */
test('services: a brand tile per service, a Request button, empty categories folded into one strip', async () => {
  db.prepare("UPDATE service_providers SET status = 'pending' WHERE slug != 'noor-letters'").run();
  const page = noScripts((await get('/services')).text);
  assert.match(page, /<div class="dir one" id="dir">/, 'one live category spans the row');
  assert.equal((page.match(/class="cnt none">Be the first</g) || []).length, 0, 'no Be the first card per empty category');
  assert.match(page, /<div class="soon"><div><b>Coming soon<\/b><p>[^<]*Care &amp; repair[^<]*<\/p><\/div><a href="\/apply\?for=services">Offer a service →<\/a><\/div>/);
  assert.match(page, /<div class="svtile" aria-hidden="true"><span class="svt-cat">Made to order &amp; personalisation<\/span><\/div>/);
  assert.doesNotMatch(page, /class="svtile" style="background:center\/cover url/, 'no pastel blob tiles');
  assert.match(page, /<button type="button" class="sv-req" aria-label="Request [^"]+" onclick="event\.stopPropagation\(\);openService\(\d+\)">Request<\/button>/);
  // two trust chips, four one-line steps
  const hero = page.match(/<section class="hero">[\s\S]*?<\/section>/)[0];
  assert.equal((hero.match(/<span><svg/g) || []).length, 2);
  assert.equal((page.match(/<div class="hrow">/g) || []).length, 4);
  assert.doesNotMatch(page, /Booking one|Offering one/);
  const prov = noScripts((await get('/services/noor-letters')).text);
  assert.match(prov, /<div class="pv-hero vpanel" id="pvHero" style="--t0:#[0-9A-Fa-f]{3,6};--t1:#[0-9a-f]{6}"><div class="wrap pv-back-wrap"><a class="pv-back"/);
  assert.match(prov, /class="sv-req"/);
});
