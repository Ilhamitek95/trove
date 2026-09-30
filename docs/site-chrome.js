/* ------------------------------------------------------------------ *
 * Trove — the shared header's behaviour on the server-rendered pages
 * (About, Contact, Help centre, Delivery & Returns, the legal pages).
 * The markup is the storefront's header, copied from trove-services.html
 * by backend/src/site-pages.js; these are the handlers it calls. Load
 * AFTER config.js and api.js. Everything here is progressive: the page
 * text is already in the HTML, so nothing waits on this script.
 * ------------------------------------------------------------------ */
(function () {
  var $ = function (id) { return document.getElementById(id); };
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
    if (focusSearch) setTimeout(function () { $('mSearchInput').focus(); }, 380);
  };
  window.closeSheets = function () {
    $('mnav').classList.remove('open'); $('uiScrim').classList.remove('open'); document.body.style.overflow = '';
  };
  window.toggleAcct = function (e) { e.stopPropagation(); $('acctMenu').classList.toggle('open'); };
  document.addEventListener('click', function () { var m = $('acctMenu'); if (m) m.classList.remove('open'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.closeSheets(); });

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
    a.onclick = async function () { try { await TroveAPI.logout(); } catch (_) {} location.href = '/'; };
  }
  /* No Trove Collection pieces yet → the header's Collection link hides, as
     it does on the storefront. Only decided on a real answer from the API. */
  async function markNoHouse() {
    if (!window.TroveAPI) return;
    try {
      var r = await TroveAPI.api('/api/shops');
      document.documentElement.classList.toggle('no-house', !((r && r.shops) || []).some(function (s) { return s.isHouse && s.productCount > 0; }));
    } catch (_) {}
  }

  updateCartCount();
  renderAuth();
  markNoHouse();
})();
