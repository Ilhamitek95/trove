/* Trove's own cookie banner (owner 2026-10-15: "customised in Trove's
 * branding, similar logic to what we have for Josephine").
 *
 * iubenda keeps the legal plumbing: the consent log, the stored choice and
 * the Google Consent Mode signals. It never draws anything: its banner is
 * parked out of sight (src/gtm.js, the settings line + #iubenda-cs-banner
 * rule) and this banner is the only thing the visitor sees. Every choice goes
 * through iubenda's JavaScript API, so the record of consent is iubenda's:
 *   Accept       → _iub.cs.api.consentGiven()                      (all purposes)
 *   Reject       → _iub.cs.api.rejectAll()
 *   Save choices → _iub.cs.api.setPreferences({ purposes }, true)
 *   Cookie settings (footer, .iubenda-cs-preferences-link) → this banner on
 *                  its "choose" step, with the stored choice.
 * iubenda purposes: 1 necessary (always on), 4 measurement (Google Analytics
 * through Tag Manager, and the shop analytics' anonymous visitor id). Trove
 * uses nothing else (Privacy Policy, "When you browse").
 *
 * It opens when iubenda says a choice is still needed (callback.onBannerShown
 * in src/gtm.js), never on the dashboards or /admin (no tag block there).
 * After a choice iubenda's onPreferenceExpressed updates Consent Mode and
 * pushes `consent_ready`, so the Google tag fires for this page view.
 *
 * Reject and Accept are identical buttons side by side: refusing is as easy
 * as agreeing. Brand tokens only (Cream card, Clay Beige edge, Charcoal text
 * and buttons; never Orange), Cormorant title, Quicksand body, upright.
 * Arabic pages (html[lang=ar]) get the Arabic words and read right to left.
 *
 * Pages that keep things above the banner on phones (the basket, the buy bar)
 * measure #troveCmp.
 */
(function () {
  'use strict';
  if (window.troveConsent) return;

  var AR = /^ar\b/i.test(document.documentElement.lang || '');
  var T = AR ? {
    label: 'ملفات تعريف الارتباط',
    title: 'خياراتك لملفات تعريف الارتباط',
    text: 'نستخدم ملفات تعريف الارتباط لتشغيل Trove. وبموافقتك، نقيس الزيارات أيضاً عبر Google Analytics لنعرف ما يفيد ونحسّن المتجر. لا يعمل أي شيء اختياري قبل أن تختار.',
    reject: 'رفض', accept: 'قبول', choose: 'تخصيص',
    chooseTitle: 'اختر ما تسمح به',
    chooseText: 'فعّل كل استخدام أو أوقفه. ملفات تعريف الارتباط الضرورية تُبقي الموقع يعمل ولا يمكن إيقافها.',
    necessary: 'ضرورية', necessaryText: 'تُبقيك مسجّلاً الدخول، وتحفظ سلّتك، وتؤمّن الدفع.', always: 'مفعّلة دائماً',
    measurement: 'القياس', measurementText: 'Google Analytics عبر Google Tag Manager، ومعرّف زائر مجهول يُطلع الحرفيين على أداء متاجرهم بالإجمالي فقط.',
    save: 'حفظ اختياراتي', acceptAll: 'قبول الكل', back: 'رجوع',
    policy: 'سياسة ملفات تعريف الارتباط', policyHref: '/ar/privacy',
    accepted: 'تم قبول ملفات تعريف الارتباط.', rejected: 'لن نستخدم إلا ملفات تعريف الارتباط الضرورية.', saved: 'تم حفظ اختياراتك.'
  } : {
    label: 'Cookies',
    title: 'Your cookie choices',
    text: 'We use cookies to run Trove. With your consent, we also measure visits with Google Analytics, to see what helps and improve the shop. Nothing optional runs until you choose.',
    reject: 'Reject', accept: 'Accept', choose: 'Choose',
    chooseTitle: 'Choose what you allow',
    chooseText: 'Switch each use on or off. Necessary cookies keep the site working and cannot be turned off.',
    necessary: 'Necessary', necessaryText: 'Keep you signed in, keep your basket and keep checkout secure.', always: 'Always on',
    measurement: 'Measurement', measurementText: 'Google Analytics, through Google Tag Manager, and an anonymous visitor id that shows makers how their shops are doing, in totals only.',
    save: 'Save my choices', acceptAll: 'Accept all', back: 'Back',
    policy: 'Cookie policy', policyHref: '/privacy#2-what-we-collect',
    accepted: 'Cookies accepted.', rejected: 'Only necessary cookies will be used.', saved: 'Your cookie choices are saved.'
  };

  var CSS = ''
    + '.tcmp{position:fixed;z-index:99999998;inset-inline-start:24px;bottom:24px;width:min(420px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;'
    + 'background:#FFFCFA;color:#292727;border:1px solid #DBC7BD;border-radius:18px;box-shadow:0 18px 48px -18px rgba(41,39,39,.32);padding:20px 22px 18px;'
    + 'font:500 14px/1.55 "Quicksand",system-ui,sans-serif;letter-spacing:0;text-align:start;outline:none}'
    + '.tcmp[hidden]{display:none}'
    + '.tcmp *{box-sizing:border-box}'
    + '.tcmp h2{font:500 22px/1.15 "Cormorant",Georgia,serif;color:#292727;margin:0 0 6px;letter-spacing:0}'
    + '.tcmp p{margin:0}'
    + '.tcmp-acts{display:flex;align-items:center;gap:8px;margin:16px 0 0}'
    + '.tcmp-btn{flex:1 1 0;max-width:150px;min-height:44px;margin:0;padding:12px 18px;border-radius:999px;border:1.5px solid #292727;background:#292727;color:#FDF7F5;font:600 14px/1 "Quicksand",system-ui,sans-serif;letter-spacing:0;cursor:pointer}'
    + '.tcmp-btn:hover{opacity:.86}'
    + '.tcmp-link{flex:0 0 auto;margin:0 auto 0 0;padding:12px 0;min-height:44px;border:0;background:none;color:#292727;font:600 14px/1 "Quicksand",system-ui,sans-serif;letter-spacing:0;text-decoration:underline;text-underline-offset:3px;cursor:pointer}'
    + '[dir=rtl] .tcmp-link{margin:0 0 0 auto}'
    + '.tcmp-legal{margin:8px 0 0!important;font-size:12.5px}'
    + '.tcmp-legal a{color:#292727;font-weight:600;text-decoration:underline;text-underline-offset:3px}'
    + '.tcmp :focus-visible{outline:2px solid #292727;outline-offset:2px}'
    + '.tcmp-list{list-style:none;margin:14px 0 0;padding:0;border-top:1px solid #DBC7BD}'
    + '.tcmp-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid #DBC7BD}'
    + '.tcmp-row strong{display:block;font-weight:600}'
    + '.tcmp-row .tcmp-d{display:block;font-size:13px;line-height:1.5;color:rgba(41,39,39,.78)}'
    + '.tcmp-always{flex:0 0 auto;padding-top:1px;font-size:12.5px;font-weight:600;white-space:nowrap}'
    + '.tcmp-sw{position:relative;flex:0 0 auto;width:46px;height:28px;margin:0;padding:0;border:1.5px solid #292727;border-radius:999px;background:#FFFCFA;cursor:pointer}'
    + '.tcmp-sw span{position:absolute;top:3px;inset-inline-start:3px;width:19px;height:19px;border-radius:50%;background:#292727;transition:inset-inline-start .18s ease}'
    + '.tcmp-sw[aria-checked=true]{background:#292727}'
    + '.tcmp-sw[aria-checked=true] span{inset-inline-start:21px;background:#FDF7F5}'
    + '.tcmp-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}'
    + '@media (prefers-reduced-motion:no-preference){.tcmp{animation:tcmp-in .28s ease-out}@keyframes tcmp-in{from{opacity:0;transform:translateY(12px)}}}'
    + '@media (max-width:639px){.tcmp{inset-inline-start:0;bottom:0;width:100%;max-height:85vh;border-radius:18px 18px 0 0;border-width:1px 0 0;padding:16px 16px calc(14px + env(safe-area-inset-bottom,0px));font-size:13px;line-height:1.5}'
    + '.tcmp h2{font-size:19px;margin-bottom:4px}.tcmp-acts{margin-top:12px}.tcmp-btn{padding:11px 16px}.tcmp-row .tcmp-d{font-size:12.5px}}'
    + '@media print{.tcmp{display:none!important}}';

  var api = function () { return (window._iub && window._iub.cs && window._iub.cs.api) || null; };
  var box = null, live = null, step = 'notice', measurement = false;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function mount() {
    if (box) return;
    var st = document.createElement('style');
    st.id = 'trove-consent-css';
    st.textContent = CSS;
    document.head.appendChild(st);
    live = document.createElement('div');
    live.className = 'tcmp-sr';
    live.setAttribute('aria-live', 'polite');
    box = document.createElement('section');
    box.id = 'troveCmp';
    box.className = 'tcmp';
    box.hidden = true;
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    box.setAttribute('aria-label', T.label);
    box.addEventListener('click', onClick);
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape' && step === 'choose') { e.stopPropagation(); render('notice'); } });
    document.body.appendChild(live);
    document.body.appendChild(box);
  }

  function render(which) {
    step = which;
    var legal = '<p class="tcmp-legal"><a href="' + esc(T.policyHref) + '">' + esc(T.policy) + '</a></p>';
    if (which === 'choose') {
      box.innerHTML = '<h2>' + esc(T.chooseTitle) + '</h2>'
        + '<p>' + esc(T.chooseText) + '</p>'
        + '<ul class="tcmp-list">'
        + '<li class="tcmp-row"><div><strong>' + esc(T.necessary) + '</strong><span class="tcmp-d">' + esc(T.necessaryText) + '</span></div><span class="tcmp-always">' + esc(T.always) + '</span></li>'
        + '<li class="tcmp-row"><div><strong id="tcmpMeas">' + esc(T.measurement) + '</strong><span class="tcmp-d" id="tcmpMeasD">' + esc(T.measurementText) + '</span></div>'
        + '<button type="button" class="tcmp-sw" role="switch" aria-checked="' + (measurement ? 'true' : 'false') + '" aria-labelledby="tcmpMeas" aria-describedby="tcmpMeasD" data-act="toggle"><span></span></button></li>'
        + '</ul>'
        + '<div class="tcmp-acts"><button type="button" class="tcmp-link" data-act="back">' + esc(T.back) + '</button>'
        + '<button type="button" class="tcmp-btn" data-act="save">' + esc(T.save) + '</button>'
        + '<button type="button" class="tcmp-btn" data-act="accept">' + esc(T.acceptAll) + '</button></div>'
        + legal;
    } else {
      box.innerHTML = '<h2>' + esc(T.title) + '</h2>'
        + '<p>' + esc(T.text) + '</p>'
        + '<div class="tcmp-acts"><button type="button" class="tcmp-link" data-act="choose">' + esc(T.choose) + '</button>'
        + '<button type="button" class="tcmp-btn" data-act="reject">' + esc(T.reject) + '</button>'
        + '<button type="button" class="tcmp-btn" data-act="accept">' + esc(T.accept) + '</button></div>'
        + legal;
    }
    box.hidden = false;
    try { box.focus({ preventScroll: true }); } catch (_) { box.focus(); }
  }

  function close(message) {
    if (live) live.textContent = message;
    box.hidden = true;
    box.innerHTML = '';
    step = 'notice';
  }

  // iubenda records the choice (its cookie, its log, its Consent Mode update),
  // then may throw putting focus back on its own parked banner: the record is
  // complete by then, so that error is swallowed.
  function call(fn) { try { fn(); } catch (_) { /* iubenda's focus restore */ } }

  function onClick(e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    var a = b.getAttribute('data-act'), cs = api();
    if (a === 'accept') { call(function () { cs && cs.consentGiven && cs.consentGiven(); }); close(T.accepted); }
    else if (a === 'reject') { call(function () { cs && cs.rejectAll && cs.rejectAll(); }); close(T.rejected); }
    else if (a === 'save') { call(function () { cs && cs.setPreferences && cs.setPreferences({ purposes: { 1: true, 4: measurement } }, true); }); close(T.saved); }
    else if (a === 'choose') render('choose');
    else if (a === 'back') render('notice');
    else if (a === 'toggle') { measurement = !measurement; b.setAttribute('aria-checked', measurement ? 'true' : 'false'); }
  }

  /** Opens the banner: 'notice' (first visit) or 'choose' (Cookie settings). */
  function open(which) {
    mount();
    var cs = api(), stored = null;
    try { stored = cs && cs.getPreferences && cs.getPreferences(); } catch (_) { stored = null; }
    measurement = !!(stored && stored.purposes && stored.purposes['4'] === true);
    render(which === 'choose' ? 'choose' : 'notice');
  }

  // The footer's Cookie settings link: ours, not iubenda's panel. Capture
  // phase, so it runs before iubenda's own handler on the same class.
  window.addEventListener('click', function (e) {
    var l = e.target.closest && e.target.closest('.iubenda-cs-preferences-link,[data-cookie-settings]');
    if (!l) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    open('choose');
  }, true);

  window.troveConsent = { open: open };
  var ready = function () { window.dispatchEvent(new Event('trove:consent-ready')); };
  if (document.body) ready(); else document.addEventListener('DOMContentLoaded', ready, { once: true });
})();
