'use strict';
/**
 * The branded 404 page (docs/404.html) with the site's own header, search,
 * basket and footer (F426): a shopper who follows an old link to a piece that
 * has gone keeps every way back into Trove instead of a bare page.
 *
 * The header, its styles and the footer are the copy the server-rendered
 * pages use (src/site-pages.js chrome(), taken from trove-services.html,
 * which test/header-sync.test.js holds to the storefront's); site-chrome.js
 * wires the menu, the account menu, search and the basket. The page marks
 * where each part goes with a comment, so served as a plain file it still
 * renders (without the header). Still a 404 status, still noindex.
 */
const { esc } = require('./markdown');

function page(html, lang = 'en') {
  let ch;
  let sc;
  try {
    ch = require('./site-pages').chrome();
    sc = require('./translate').siteContent(require('./content').getPublic(), lang);
  } catch (e) {
    console.error('404 chrome unavailable:', e.message);
    return html; // the plain page is still a good 404
  }
  const promo = (sc && sc.site && sc.site.promo && sc.site.promo.text) || '';
  const header = ch.header.replace(/(<div class="wrap" data-cms="site\.promo\.text">)[^<]*(<\/div>)/, (m, a, b) => a + esc(promo) + b);
  // function replacements: the admin's promo and footer text may hold '$' (F074)
  return String(html)
    .replace('<!-- site-chrome:css -->', () => `<style>\n${ch.css}</style>`)
    .replace('<!-- site-chrome:header -->', () => `<a class="skip" href="#main">Skip to content</a>\n${header}`)
    .replace('<!-- site-chrome:footer -->', () => require('./site-pages').footerHtml(sc))
    .replace('<!-- site-chrome:scripts -->', () => '<script src="/config.js"></script>\n<script src="/api.js"></script>\n<script src="/site-chrome.js"></script>');
}

module.exports = { page };
