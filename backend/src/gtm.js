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
 * The cookie banner (iubenda). The settings line in each page overrides the
 * iubenda dashboard, so what it says and how it looks live here:
 *   - consent model: opt-in for every visitor (no US opt-out model, which
 *     granted consent on the second page), purposes 1-4 only (no marketing),
 *     no floating button;
 *   - look (owner 2026-10-12: "it does not look on brand"): a Cream card with
 *     a Clay Beige edge, Charcoal text and Charcoal buttons, Quicksand body and
 *     a Cormorant title — Trove's own tokens only, never Orange on Charcoal.
 *     Reject and Accept are identical buttons side by side (refusing must be
 *     as easy as agreeing); Customise opens iubenda's preferences panel;
 *   - size: a short notice, one row of buttons, flush to the bottom of a
 *     phone (a fraction of the old half-screen sheet, F393), a small card
 *     bottom-left on wider screens.
 * iubenda has no Arabic, so Arabic pages swap in the 'ar' line (src/i18n.js).
 */
const IUB_SETTINGS = {
  enableGdpr: true, gdprAppliesGlobally: true, gdprApplies: true,
  enableUspr: false, usprApplies: false, showBannerForUS: false,
  enableFadp: false, fadpApplies: false, enableLgpd: false, lgpdApplies: false,
  purposes: '1,2,3,4', floatingPreferencesButtonDisplay: false,
  // No advertising frameworks (Trove runs no advertising cookies — Privacy
  // Policy v2). The preferences panel's Marketing section and 'personalised
  // advertising by Google' switches come from the iubenda dashboard (IAB TCF
  // + Google Additional Consent there), so those must be off there as well.
  enableTcf: false, googleAdditionalConsentMode: false,
};
const IUB_LOOK = {
  position: 'float-bottom-left', closeButtonDisplay: false, showTitle: false,
  backgroundColor: '#FFFCFA', textColor: '#292727', linksColor: '#292727', fontSizeBody: '14px',
  acceptButtonDisplay: true, acceptButtonColor: '#292727', acceptButtonCaptionColor: '#FDF7F5',
  rejectButtonDisplay: true, rejectButtonColor: '#292727', rejectButtonCaptionColor: '#FDF7F5',
  customizeButtonDisplay: true, customizeButtonColor: '#FFFCFA', customizeButtonCaptionColor: '#292727',
};
const IUB_TEXT = {
  en: {
    content: '<span class="trove-cmp-title">Your cookie choices</span>We use cookies to run Trove. With your consent, we and selected partners also use them to remember your choices, improve your experience and measure visits, as set out in our <a href="/privacy#2-what-we-collect" class="iubenda-cs-cookie-policy-lnk">cookie policy</a>. Change your mind any time under Cookie settings at the foot of every page.',
    acceptButtonCaption: 'Accept', rejectButtonCaption: 'Reject', customizeButtonCaption: 'Customise',
  },
  ar: {
    content: '<span class="trove-cmp-title">خياراتك لملفات تعريف الارتباط</span>نستخدم ملفات تعريف الارتباط لتشغيل Trove. وبموافقتك، نستخدمها نحن وشركاء مختارون أيضاً لتذكّر اختياراتك وتحسين تجربتك وقياس الزيارات، كما هو موضّح في <a href="/ar/privacy" class="iubenda-cs-cookie-policy-lnk">سياسة ملفات تعريف الارتباط</a>. يمكنك تغيير رأيك في أي وقت من «إعدادات ملفات تعريف الارتباط» أسفل كل صفحة.',
    acceptButtonCaption: 'قبول', rejectButtonCaption: 'رفض', customizeButtonCaption: 'تخصيص',
  },
};
/** The banner settings line for a language ('en' | 'ar'). */
function iubSettingsLine(lang = 'en') {
  const cfg = { ...(lang === 'ar' ? { lang: 'ar' } : {}), ...IUB_SETTINGS, banner: { ...IUB_LOOK, ...IUB_TEXT[lang === 'ar' ? 'ar' : 'en'] } };
  return `  <script>var _iub=window._iub=window._iub||[];_iub.csConfiguration=${JSON.stringify(cfg).replace(/</g, '\\u003c')};</script>`;
}
/* The banner's shape and type, over iubenda's own stylesheet: its rules are
   !important and injected after ours, so every selector here doubles the
   banner's id (#iubenda-cs-banner#iubenda-cs-banner) to outrank all of its
   rules (the preferences panel behind Customise likewise, #iubenda-iframe).
   Colours are the brand tokens above. */
const IUB_STYLE = '  <style id="trove-cmp">'
  + '#iubenda-cs-banner#iubenda-cs-banner *{font-family:"Quicksand",system-ui,sans-serif!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-content{background:#FFFCFA!important;color:#292727!important;border:1px solid #DBC7BD!important;border-radius:18px!important;box-shadow:0 18px 48px -18px rgba(41,39,39,.32)!important;padding:20px 22px 18px!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-rationale{max-width:none!important;margin:0!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-banner-content,#iubenda-cs-banner#iubenda-cs-banner .iubenda-banner-content p,#iubenda-cs-banner#iubenda-cs-banner .iub-p{font:500 14px/1.55 "Quicksand",system-ui,sans-serif!important;color:#292727!important;margin:0!important;padding:0!important;letter-spacing:0!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-banner-content{margin:0!important;max-height:none!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .trove-cmp-title{display:block;font:500 22px/1.15 "Cormorant",Georgia,serif!important;color:#292727;margin:0 0 6px}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-cookie-policy-lnk{color:#292727!important;font-weight:600!important;text-decoration:underline!important;text-underline-offset:3px}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group{display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;margin:16px 0 0!important;padding:0!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group>div{display:flex!important;flex-direction:row!important;gap:8px!important;margin:0!important;width:auto!important;order:0!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group-custom{flex:0 0 auto!important;padding:0!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group-consent{flex:1 1 auto!important;justify-content:flex-end!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group-consent button{flex:1 1 0!important;max-width:150px!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group button{width:auto!important;margin:0!important;border-radius:999px!important;font:600 14px/1 "Quicksand",system-ui,sans-serif!important;letter-spacing:0!important;padding:12px 20px!important;min-height:44px;cursor:pointer;box-shadow:none!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-reject-btn,#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-accept-btn{background:#292727!important;color:#FDF7F5!important;border:1.5px solid #292727!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-reject-btn:hover,#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-accept-btn:hover{opacity:.86}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group .iubenda-cs-customize-btn{background:transparent!important;color:#292727!important;border:0!important;padding:12px 0!important;min-width:0!important;text-align:start!important;text-decoration:underline!important;text-underline-offset:3px}'
  + '#iubenda-cs-banner#iubenda-cs-banner button:focus-visible,#iubenda-cs-banner#iubenda-cs-banner a:focus-visible{outline:2px solid #292727!important;outline-offset:2px!important}'
  + '@media (min-width:640px){#iubenda-cs-banner#iubenda-cs-banner.iubenda-cs-default-floating .iubenda-cs-container{max-width:420px!important}}'
  + '@media (max-width:639px){#iubenda-cs-banner#iubenda-cs-banner.iubenda-cs-default-floating{padding:0!important;bottom:0!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-container{max-width:none!important;width:100%!important;margin:0!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-content{border-radius:18px 18px 0 0!important;border-width:1px 0 0!important;padding:16px 16px calc(14px + env(safe-area-inset-bottom,0px))!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-banner-content,#iubenda-cs-banner#iubenda-cs-banner .iubenda-banner-content p,#iubenda-cs-banner#iubenda-cs-banner .iub-p{font-size:13px!important;line-height:1.5!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .trove-cmp-title{font-size:19px;margin-bottom:4px}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group{margin-top:12px!important}'
  + '#iubenda-cs-banner#iubenda-cs-banner .iubenda-cs-opt-group button{padding:11px 18px!important}}'
  + '#iubenda-iframe#iubenda-iframe #iubenda-iframe-content,#iubenda-iframe#iubenda-iframe #iubenda-iframe-content *{font-family:"Quicksand",system-ui,sans-serif!important}'
  + '#iubenda-iframe#iubenda-iframe #iubenda-iframe-content{background:#FFFCFA!important;color:#292727!important;border-radius:18px!important}'
  + '#iubenda-iframe#iubenda-iframe #iubenda-iframe-content .purposes-header-title,#iubenda-iframe#iubenda-iframe #iubenda-iframe-content .purposes-section-header-title{font-family:"Cormorant",Georgia,serif!important;font-weight:500!important;color:#292727!important;letter-spacing:0!important}'
  + '#iubenda-iframe#iubenda-iframe .iub-btn,#iubenda-iframe#iubenda-iframe #iubFooterBtn,#iubenda-iframe#iubenda-iframe #iubRejectBtn{border-radius:999px!important;font-weight:600!important;box-shadow:none!important}'
  + '#iubenda-iframe#iubenda-iframe #iubFooterBtn,#iubenda-iframe#iubenda-iframe #iubRejectBtn{background:#292727!important;color:#FDF7F5!important;border:1.5px solid #292727!important}'
  + '#iubenda-iframe#iubenda-iframe .iub-btn-consent,#iubenda-iframe#iubenda-iframe .iub-btn-cp,#iubenda-iframe#iubenda-iframe .iub-btn-config{background:#FDF7F5!important;color:#292727!important;border:1.5px solid #292727!important}'
  + '#iubenda-iframe#iubenda-iframe .iub-btn-consent svg path{fill:#292727!important;stroke:#292727!important}'
  + '#iubenda-iframe#iubenda-iframe input.style1:checked,#iubenda-iframe#iubenda-iframe input.style1.locked{background-color:#292727!important;border-color:#292727!important}'
  + '#iubenda-iframe#iubenda-iframe a,#iubenda-iframe#iubenda-iframe .purposes-item-title-btn{color:#292727!important}'
  + '#iubenda-iframe#iubenda-iframe #iubenda-iframe-content .iub-btn:focus,#iubenda-iframe#iubenda-iframe #iubenda-iframe-content .iub-btn:focus-visible,#iubenda-iframe#iubenda-iframe #iubenda-iframe-content a:focus-visible,#iubenda-iframe#iubenda-iframe #iubenda-iframe-content input:focus-visible{outline:2px solid #292727!important;outline-offset:2px!important;box-shadow:none!important}'
  // iubenda has no Arabic: the panel stays English, so it keeps left-to-right on Arabic pages
  + '[dir=rtl] #iubenda-iframe#iubenda-iframe #iubenda-iframe-content{direction:ltr!important;text-align:left!important}'
  + '</style>';

const SNIPPET = [
  `  <!-- gtm:begin — Consent Mode v2: everything denied until the cookie banner records a choice; then Google Tag Manager ${GTM_ID}. No <noscript> iframe on purpose: it cannot respect consent. -->`,
  '  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted"});gtag("set","ads_data_redaction",true);</script>',
  '  <!-- iubenda: cookie banner + consent log (Privacy Controls and Cookie Solution, site 4702684). After the Consent Mode defaults, before GTM, so a saved choice is applied before any tag can run. The settings line overrides the dashboard: opt-in for every visitor (no US opt-out model, which granted consent on the second page), no marketing purpose, no floating button, and the banner in Trove\'s own look and words (src/gtm.js). -->',
  iubSettingsLine('en'),
  IUB_STYLE,
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
