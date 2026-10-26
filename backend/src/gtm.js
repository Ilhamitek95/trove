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

/*
 * The cookie banner: Trove's own (docs/consent.js), with iubenda behind it
 * (owner 2026-10-15: "customised in Trove's branding, similar logic to what
 * we have for Josephine"). iubenda keeps the legal plumbing — the consent
 * log, the stored choice, the Google Consent Mode signals — and draws
 * nothing: its banner is parked out of sight and our banner opens in its
 * place. The settings line in each page overrides the iubenda dashboard:
 *   - consent model: opt-in for every visitor (no US opt-out model, which
 *     granted consent on the second page), no floating button;
 *   - purposes 1 (necessary) and 4 (measurement) only — exactly what the
 *     Privacy Policy says the banner asks about (Google Analytics through Tag
 *     Manager, and the shop analytics' anonymous visitor id). No marketing;
 *   - callbacks: onBannerShown parks iubenda's banner and opens ours;
 *     onConsentRead / onPreferenceExpressed apply Trove's own Consent Mode
 *     update after iubenda's (analytics from purpose 4; advertising, and the
 *     functionality / personalisation storage nothing here uses, always
 *     denied — iubenda grants a purpose the settings leave out), and a choice
 *     pushes `consent_ready` so the Google tag fires for this page view.
 * The banner's words live in docs/consent.js (English + Arabic, picked by the
 * page's lang), so both languages share this one settings line.
 */
const IUB_SETTINGS = {
  enableGdpr: true, gdprAppliesGlobally: true, gdprApplies: true,
  enableUspr: false, usprApplies: false, showBannerForUS: false,
  enableFadp: false, fadpApplies: false, enableLgpd: false, lgpdApplies: false,
  purposes: '1,4', floatingPreferencesButtonDisplay: false,
  // No advertising frameworks (Trove runs no advertising cookies — Privacy
  // Policy v3). Turn IAB TCF + Google Additional Consent off in the iubenda
  // dashboard as well.
  enableTcf: false, googleAdditionalConsentMode: false,
  // iubenda's own banner still exists (it is what fires onBannerShown); it is
  // parked off-screen and never seen, so it carries no look or words.
  banner: { position: 'float-bottom-left', closeButtonDisplay: false, acceptButtonDisplay: true, rejectButtonDisplay: true, customizeButtonDisplay: true },
};
const IUB_CALLBACKS = ''
  + "_iub.csConfiguration.callback={"
  + "onBannerShown:function(){window.__trovePark();var o=function(){window.troveConsent.open('notice')};if(window.troveConsent)o();else window.addEventListener('trove:consent-ready',o,{once:true})},"
  + 'onConsentRead:function(){window.__troveGcm()},'
  + "onPreferenceExpressed:function(){window.__troveGcm();(window.dataLayer=window.dataLayer||[]).push({event:'consent_ready'})}"
  + '};'
  // park iubenda's banner with inline !important styles (they beat every
  // stylesheet, iubenda's phone rules included); it stays in the page because
  // iubenda puts focus back on it after a choice
  + "window.__trovePark=function(){var b=document.getElementById('iubenda-cs-banner');if(!b)return;b.setAttribute('aria-hidden','true');b.setAttribute('inert','');"
  + "var P={position:'fixed',left:'-200vw',top:'0',width:'1px',height:'1px',overflow:'hidden',opacity:'0','pointer-events':'none','clip-path':'inset(100%)'};"
  + "for(var k in P)b.style.setProperty(k,P[k],'important')};"
  + "window.__troveGcm=function(){try{var p=(_iub.cs&&_iub.cs.api&&_iub.cs.api.getPreferences()||{}).purposes||{};var a=p['4']===true?'granted':'denied';"
  + "gtag('consent','update',{analytics_storage:a,ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',functionality_storage:'denied',personalization_storage:'denied'})}catch(e){}};";
/** The banner settings line (one for every language — the words are in docs/consent.js). */
function iubSettingsLine() {
  return `  <script>var _iub=window._iub=window._iub||[];_iub.csConfiguration=${JSON.stringify(IUB_SETTINGS).replace(/</g, '\\u003c')};${IUB_CALLBACKS}</script>`;
}
/* iubenda's banner and floating button never show, from the first frame (the
   doubled id outranks iubenda's injected !important rules); the inline park
   above backs it up. */
const IUB_STYLE = '  <style id="trove-cmp">'
  + '#iubenda-cs-banner#iubenda-cs-banner{position:fixed!important;left:-200vw!important;top:0!important;width:1px!important;height:1px!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important;clip-path:inset(100%)!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-container{position:absolute!important;opacity:0!important;pointer-events:none!important}'
  + '.iubenda-tp-btn,.iubenda-tp-alert-btn{display:none!important}'
  + '</style>';

const SNIPPET = [
  `  <!-- gtm:begin — Consent Mode v2: everything denied until the cookie banner records a choice; then Google Tag Manager ${GTM_ID}. No <noscript> iframe on purpose: it cannot respect consent. -->`,
  '  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted"});gtag("set","ads_data_redaction",true);</script>',
  '  <!-- Cookie banner: Trove\'s own (/consent.js) over iubenda, which keeps the consent log and Consent Mode signals and draws nothing (Privacy Controls and Cookie Solution, site 4702684). After the Consent Mode defaults, before GTM, so a saved choice is applied before any tag can run. Settings: opt-in for every visitor, necessary + measurement only, no floating button (src/gtm.js). -->',
  iubSettingsLine(),
  IUB_STYLE,
  '  <script src="/consent.js" defer></script>',
  '  <script src="https://embeds.iubenda.com/widgets/e5a8f7dc-abe7-4798-a50d-a94138033fad.js"></script>',
  `  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');</script>`,
  '  <!-- gtm:end -->',
].join('\n');

/* Addresses whose path or query is a bearer key (see the header comment). */
// (order/<id>/thanks shows the buyer's address and mobile — F164)
const PRIVATE_PATH = /^\/(reset\/?$|services\/(booking|pay)\/|order\/)/i;
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

module.exports = { GTM_ID, SNIPPET, UNTAGGED_FILES, isDashboard, isPrivateAddress, strip, forAddress, iubSettingsLine };
