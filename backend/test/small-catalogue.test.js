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
  assert.doesNotMatch(html, /<html lang="en" class="[^"]*no-house/, 'the seed has Trove Collection pieces');
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

/* ---------------- one piece, one maker, no Trove Collection ---------------- */
test('one piece: the server draws the editorial hero and The first piece, marks no-house', async () => {
  const mug = MUG();
  db.prepare("UPDATE products SET status = 'hidden' WHERE id != ?").run(mug.id);
  const res = await get('/');
  assert.equal(res.status, 200);
  const html = res.text;
  assert.match(html, /<html lang="en" class="no-house few-pieces">/);
  assert.match(html, /<div class="hstage solo" id="heroStage" aria-label="Featured piece">/);
  assert.match(html, /<a class="hsolo" href="\/pieces\/\d+-reeded-stoneware-mug">/);
  assert.match(html, /<span class="hs-meta">Made in Alserkal Avenue, Dubai<\/span>/, 'where it was made, from the shop');
  assert.match(html, /<span class="hs-by">by Kiln &amp; Clay<\/span>/);
  assert.match(html, /<div class="firsts n1" id="trendingGrid">/);
  assert.match(html, /id="weeklyHeading"[^>]*>The first piece</);
  assert.match(html, /<a class="btn btn-dark" id="heroMarketLink"/, 'the Marketplace link leads the hero');
  // the stock stand-in photo is labelled as such wherever it shows
  assert.equal((noScripts(html).match(/class="illus">Illustrative photo</g) || []).length, 2);
  assert.equal(rawH1(noScripts(html)), 1);
});

/* ---------------- the shelf (/shop) ---------------- */
test('the shelf: filters that can change nothing hide, a short shelf gets a bigger grid, quick add sits under the price', async () => {
  // (runs after the one-piece test above: one live piece)
  const html = (await get('/shop')).text;
  assert.match(html, /<body class="no-filters">/, 'one piece: nothing to filter, no rail');
  assert.match(html, /<div class="pgrid few one" id="shopGrid">/);
  assert.match(noScripts(html), /<button class="add add-row" onclick="event\.stopPropagation\(\);addToCart\(\d+,this\)">Add to basket<\/button>/);
  for (const id of ['fgCat', 'fgSeller', 'fgOffers', 'fgPrice']) assert.match(store, new RegExp(`class="fgroup" id="${id}"`));
  assert.match(store, /const inPillar=p=>state\.cat!=='House'/, 'facet counts follow the pillar');
  assert.match(store, /opt\.hidden=!rated;opt\.disabled=!rated;/, 'Top rated waits for real ratings');
  assert.match(store, /\.card \.ph \.add\{display:none\}/, 'touch: no quick add over the photo');
  // many pieces again: the rail is back
  db.prepare("UPDATE products SET status = 'live' WHERE status = 'hidden'").run();
  const many = (await get('/shop')).text;
  assert.doesNotMatch(many, /<body class="no-filters">/);
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
  assert.match(page, /<dt>Trove reference<\/dt><dd>TRV-\d+<\/dd>/);
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
