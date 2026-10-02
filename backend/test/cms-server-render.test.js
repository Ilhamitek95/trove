'use strict';
/**
 * F075: the owner's Site content edits reach the server-rendered HTML of the
 * storefront and Services pages (crawlers, link previews, first paint), not
 * only the page script after load.
 */
const { testEnv, startApp } = require('./helpers');
testEnv({ PUBLIC_URL: 'https://troveathome.com' });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx; let content;
before(async () => {
  ctx = await startApp();
  require('../src/seed');
  content = require('../src/content');
});
after(async () => { await ctx.close(); });

const get = async (p) => (await ctx.api('GET', p, { headers: { accept: 'text/html' } })).text;
const noScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ');

test('saved Site content is in the server HTML of /sell-on-trove, / and /services', async () => {
  const D = content.DEFAULTS;
  content.save('sell.hero', { ...D['sell.hero'], h1: 'CMS EDITED *headline*|second line', facts: ['Fact one edited', 'Fact two edited'] });
  content.save('sell.faq', { ...D['sell.faq'], items: [{ q: 'Edited question?', a: 'Edited answer & more.' }] });
  content.save('sell.steps', { ...D['sell.steps'], items: [{ title: 'Step A edited', text: 'Do A' }, { title: 'Step B edited', text: 'Do B' }] });
  content.save('site.promo', { text: 'CMS PROMO EDIT · free over AED 200' });
  content.save('home.hero', { ...D['home.hero'], lead: 'CMS edited lead line.' });
  content.save('sell.quotes', { ...D['sell.quotes'], items: [{ quote: 'Selling here is lovely.', name: 'Real Maker', shop: 'Real Studio' }] });
  try {
    const sell = noScripts(await get('/sell-on-trove'));
    assert.match(sell, /data-cms-rich="sell\.hero\.h1"[^>]*>CMS EDITED <em>headline<\/em><br>second line<\/h1>/, 'the rich heading, accent + line break, is the page h1');
    assert.ok(!sell.includes('You make the pieces.'), 'the built-in heading is gone');
    assert.ok(sell.includes('Fact one edited') && sell.includes('Fact two edited'), 'hero facts');
    assert.ok(!sell.includes('No trade licence needed</span>'), 'old facts gone');
    assert.ok(sell.includes('<summary>Edited question?<span class="faq-tg">+</span></summary><div class="faq-a">Edited answer &amp; more.</div>'), 'FAQ list');
    assert.ok(!sell.includes('Do I need a trade licence?'), 'old FAQ gone');
    assert.ok(sell.includes('<h4>Step A edited</h4>') && sell.includes('<h4>Step B edited</h4>'), 'hand-off steps');
    assert.equal((sell.match(/class="h-row"/g) || []).length, 2, 'one row per step');
    assert.equal((sell.match(/class="h-card"/g) || []).length, D['sell.offer'].items.length, 'every offer card still placed');
    assert.ok(sell.includes('Selling here is lovely.') && sell.includes('Real Studio'), 'a real quote');
    assert.match(sell, /id="foundingBand" hidden>/, 'the founding-makers panel steps aside once a real quote exists');
    assert.ok(sell.includes('CMS PROMO EDIT'), 'promo bar on the storefront');
    assert.ok(!sell.includes('Free delivery on orders over AED 200</div>'), 'old promo gone');
    assert.equal((sell.match(/<\/head>/g) || []).length, 1);

    const home = noScripts(await get('/'));
    assert.ok(home.includes('CMS edited lead line.'), 'home hero lead');
    assert.ok(home.includes('CMS PROMO EDIT'), 'promo on the homepage');

    const services = noScripts(await get('/services'));
    assert.ok(services.includes('CMS PROMO EDIT'), 'promo on /services agrees with the storefront');

    // Arabic page: an edit without its translation yet shows the edited English, never the stale default
    const ar = noScripts(await get('/ar/sell-on-trove'));
    assert.ok(ar.includes('Edited question?'), 'the edited FAQ on the Arabic page');
    assert.ok(ar.includes('CMS PROMO EDIT'));
  } finally {
    for (const s of ['sell.hero', 'sell.faq', 'sell.steps', 'site.promo', 'home.hero', 'sell.quotes']) content.reset(s);
  }
  const back = noScripts(await get('/sell-on-trove'));
  assert.ok(back.includes('Do I need a trade licence?'), 'defaults return after a reset');
  assert.ok(!/id="foundingBand" hidden/.test(back));
});

test('with no edits the server HTML is the page source untouched (Arabic keeps its dictionary translation)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'trove.html'), 'utf8').replace(/\r\n/g, '\n');
  const sell = await get('/sell-on-trove');
  const faqOf = (h) => h.match(/<div class="faqs" id="faqList">[\s\S]*?<\/div>\s*<p class="faq-more"/)[0];
  assert.equal(faqOf(sell), faqOf(src));
  const ar = noScripts(await get('/ar/sell-on-trove'));
  assert.ok(!ar.includes('Do I need a trade licence?'), 'the FAQ is translated on the Arabic page');
});
