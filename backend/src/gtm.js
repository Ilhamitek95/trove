'use strict';
/**
 * Google Tag Manager (GTM-5F87RHVM) with Consent Mode v2.
 *
 * SNIPPET is the one block every tagged page carries in its <head>, right
 * after the charset + viewport metas. The static pages in docs/ hold a
 * verbatim copy; the server-rendered pages (src/site-pages.js) print it from
 * here; test/gtm.test.js checks every copy matches. Order matters: the
 * consent default (everything denied except security storage) is set BEFORE
 * gtm.js loads, so no tag writes a cookie or sends an identifier until the
 * cookie banner records a choice. There is deliberately no <noscript> iframe
 * — it would load the container with no way to respect consent.
 *
 * The storefront's ecommerce + account events reach the container through
 * window.troveTrack (docs/api.js): GA4's recommended schema, never personal
 * data.
 *
 * Not tagged, on purpose:
 *   - /admin (docs/trove-admin.html): every customer's details and the only
 *     place a seller IBAN decrypts. Any container change (a Custom HTML or
 *     session-replay tag) would run there with the owner's session, and there
 *     is one user and nothing to measure.
 *   - the signed-in dashboards: /sell (docs/trove-seller.html), /provider
 *     (docs/trove-provider.html) and /account (docs/trove-account.html).
 *     A maker's order view shows the buyer's name and home address, a
 *     provider's bookings show the customer's phone, an account shows the
 *     buyer's own addresses and orders. The /admin reasoning applies
 *     unchanged: a container change made for 'all pages' (a heatmap or
 *     session-replay tag) would record those screens and send them to a
 *     third party, and there is little to measure there. Owner decision
 *     2026-10-02. The files carry no block, and forAddress() strips one from
 *     these addresses anyway should a copy ever be pasted back.
 *   - private links, whose address IS the key: a booking's
 *     /services/booking/<code>?t=… and /services/pay/<code>-<token>, the
 *     /reset?token=… password link, and any address carrying a token or a
 *     Stripe client secret. A tag sends the whole address to Google as
 *     page_location, so forAddress() strips the block from these responses
 *     and sets a referrer policy that passes on only the origin — the next
 *     page's page_referrer can't carry the token either.
 *   - emails, the self-billed purchase notes (stored financial documents)
 *     and the docs/index.html redirect stub (never served by this app).
 */

const GTM_ID = 'GTM-5F87RHVM';

const SNIPPET = [
  `  <!-- gtm:begin — Consent Mode v2: everything denied until the cookie banner records a choice; then Google Tag Manager ${GTM_ID}. No <noscript> iframe on purpose: it cannot respect consent. -->`,
  '  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted"});gtag("set","ads_data_redaction",true);</script>',
  '  <!-- iubenda: cookie banner + consent log (Privacy Controls and Cookie Solution, site 4702684). After the Consent Mode defaults, before GTM, so a saved choice is applied before any tag can run. The settings line overrides the dashboard: opt-in for every visitor (no US opt-out model, which granted consent on the second page), no marketing purpose, no floating button. -->',
  '  <script>var _iub=window._iub=window._iub||[];_iub.csConfiguration={enableGdpr:true,gdprAppliesGlobally:true,gdprApplies:true,enableUspr:false,usprApplies:false,showBannerForUS:false,enableFadp:false,fadpApplies:false,enableLgpd:false,lgpdApplies:false,purposes:"1,2,3,4",floatingPreferencesButtonDisplay:false};</script>',
  '  <script src="https://embeds.iubenda.com/widgets/e5a8f7dc-abe7-4798-a50d-a94138033fad.js"></script>',
  `  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');</script>`,
  '  <!-- gtm:end -->',
].join('\n');

/* Addresses whose path or query is a bearer key (see the header comment). */
const PRIVATE_PATH = /^\/(reset\/?$|services\/(booking|pay)\/)/i;
const PRIVATE_QUERY = ['token', 't', 'payment_intent_client_secret', 'setup_intent_client_secret'];

/* Signed-in surfaces that show other people's personal data (see the header comment). */
const UNTAGGED_FILES = ['trove-admin.html', 'trove-seller.html', 'trove-provider.html', 'trove-account.html'];
const DASHBOARD_PATH = /^\/(admin|sell|provider|account)(\/|$)/i;
const isDashboard = (req) => DASHBOARD_PATH.test(req.path || '');

function isPrivateAddress(req) {
  if (PRIVATE_PATH.test(req.path || '')) return true;
  const q = req.query || {};
  return PRIVATE_QUERY.some((k) => q[k] != null);
}

/** The page without its tag block. */
function strip(html) {
  return String(html).replace(/[ \t]*<!-- gtm:begin[\s\S]*?<!-- gtm:end -->[ \t]*\r?\n?/, '');
}

/**
 * The HTML to send for this request: unchanged for an ordinary address; for a
 * private link, the tag block comes out and the browser is told to pass on
 * only the origin as the referrer.
 */
function forAddress(req, res, html) {
  if (isDashboard(req) && !isPrivateAddress(req)) return strip(html);
  if (!isPrivateAddress(req)) return html;
  res.set('Referrer-Policy', 'strict-origin');
  return strip(html);
}

module.exports = { GTM_ID, SNIPPET, UNTAGGED_FILES, isDashboard, isPrivateAddress, strip, forAddress };
