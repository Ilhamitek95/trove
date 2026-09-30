/* ------------------------------------------------------------------ *
 * Trove — shared page chrome.
 *
 * 1. TroveDialog: the one way a sheet, drawer or modal behaves as a dialog
 *    (the basket, the mobile menu, the filter sheet, the booking modal).
 *    Opening moves focus in, Tab stays inside, Escape closes, and focus
 *    goes back to the control that opened it. Every page loads this.
 * 2. The shared header's handlers for the server-rendered pages (About,
 *    Contact, Help centre, Delivery & Returns, the legal pages). The
 *    markup is the storefront's header, copied from trove-services.html by
 *    backend/src/site-pages.js. The storefront and the Services page load
 *    this file with data-own-chrome and bring their own handlers.
 * Load AFTER config.js and api.js. Everything here is progressive: the
 * page text is already in the HTML, so nothing waits on this script.
 * ------------------------------------------------------------------ */
(function () {
  var ownChrome = !!(document.currentScript && document.currentScript.hasAttribute('data-own-chrome'));
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 1. dialogs ---------------- */
  var stack = [];
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  function focusables(el) {
    return Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (x) {
      return x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden';
    });
  }
  function entryOf(el) { for (var i = 0; i < stack.length; i++) if (stack[i].el === el) return i; return -1; }
  window.TroveDialog = {
    /* opts: { opener, focus, onClose } — onClose is the page's own close
       function (Escape calls it; it must end by calling TroveDialog.close). */
    open: function (el, opts) {
      if (!el) return;
      opts = opts || {};
      var i = entryOf(el);
      if (i >= 0) stack.splice(i, 1);
      var opener = opts.opener || document.activeElement;
      stack.push({ el: el, opener: opener, onClose: opts.onClose });
      el.setAttribute('aria-hidden', 'false');
      if (opener && opener.hasAttribute && opener.hasAttribute('aria-expanded')) opener.setAttribute('aria-expanded', 'true');
      // Sheets slide in from visibility:hidden, which can't take focus until the
      // transition has begun — so try a few times over the first moments.
      var tries = [0, 50, 150, 320, 460];
      tries.forEach(function (ms) {
        setTimeout(function () {
          if (entryOf(el) < 0 || el.contains(document.activeElement)) return;
          var target = opts.focus || focusables(el)[0] || el;
          try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
        }, ms);
      });
    },
    close: function (el) {
      var i = entryOf(el);
      if (i < 0) return; // never opened (e.g. the filter panel on desktop, a plain sidebar): leave it alone
      el.setAttribute('aria-hidden', 'true');
      var e = stack.splice(i, 1)[0];
      if (e.opener && e.opener.hasAttribute && e.opener.hasAttribute('aria-expanded')) e.opener.setAttribute('aria-expanded', 'false');
      if (e.opener && document.contains(e.opener) && e.el.contains(document.activeElement)) {
        try { e.opener.focus({ preventScroll: true }); } catch (_) { e.opener.focus(); }
      }
    },
    isOpen: function (el) { return entryOf(el) >= 0; },
  };
  document.addEventListener('keydown', function (e) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (typeof top.onClose === 'function') top.onClose(); else window.TroveDialog.close(top.el);
      return;
    }
    if (e.key !== 'Tab') return;
    var f = focusables(top.el);
    if (!f.length) { e.preventDefault(); top.el.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (!top.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  if (ownChrome) return;

  /* ---------------- 2. the header on the server-rendered pages ---------------- */
  var CART_KEY = 'trove.cart.v1';
  function updateCartCount() {
    var n = 0;
    try { n = (JSON.parse(localStorage.getItem(CART_KEY) || '[]') || []).reduce(function (s, c) { return s + (parseInt(c && c.qty) || 0); }, 0); } catch (_) {}
    var el = $('cartCount'); if (!el) return;
    el.textContent = n; el.classList.toggle('hide', n === 0);
  }
  window.openCart = function () { location.href = '/?cart=1'; };
  window.runSearch = function (q) { location.href = '/?q=' + encodeURIComponent((q || '').trim()); };
  window.openMenu = function (focusSearch) {
    $('mnav').classList.add('open'); $('uiScrim').classList.add('open'); document.body.style.overflow = 'hidden';
    window.TroveDialog.open($('mnav'), { onClose: window.closeSheets, focus: focusSearch ? $('mSearchInput') : null });
  };
  window.closeSheets = function () {
    $('mnav').classList.remove('open'); $('uiScrim').classList.remove('open'); document.body.style.overflow = '';
    window.TroveDialog.close($('mnav'));
  };
  window.toggleAcct = function (e) {
    e.stopPropagation();
    var open = $('acctMenu').classList.toggle('open');
    if (e.currentTarget && e.currentTarget.setAttribute) e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  function closeAcct() {
    var m = $('acctMenu'); if (!m) return;
    m.classList.remove('open');
    var b = document.querySelector('[aria-controls="acctMenu"]'); if (b) b.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', closeAcct);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAcct(); });

  async function renderAuth() {
    if (!window.TroveAPI) return;
    var me = null;
    try { me = await TroveAPI.me(); } catch (_) { return; }
    var u = me && me.user;
    if (!u) return;
    $('amAv').textContent = ((u.name || '?').trim()[0] || '·').toUpperCase();
    $('amName').textContent = u.name; $('amEmail').textContent = u.email;
    $('authLabel').textContent = 'Sign out';
    var a = $('authLink'); a.removeAttribute('href'); a.style.cursor = 'pointer';
    a.setAttribute('role', 'button'); a.tabIndex = 0;
    a.onclick = async function () { try { await TroveAPI.logout(); } catch (_) {} location.href = '/'; };
  }
  updateCartCount();
  renderAuth();
})();
