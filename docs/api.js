/* ------------------------------------------------------------------ *
 * trove — shared API client. Load AFTER config.js, BEFORE page script.
 *
 * Exposes window.TroveAPI:
 *   .base              API origin ("" = same origin as this page)
 *   .paymentsEnabled   true when a Stripe publishable key is configured
 *   .stripeKey         the publishable key (safe to be public)
 *   .api(path, opts)   fetch wrapper → parsed JSON, throws Error(msg) on failure
 *   .health()          → boolean, is the backend reachable (cached)
 *   .me()              → { user, shop } when signed in, else null
 *   .logout()          → ends the session
 * ------------------------------------------------------------------ */
(function () {
  const CFG = window.TROVE_CONFIG || {};
  const API_BASE = (CFG.API_URL || '').replace(/\/+$/, ''); // "" → relative, same-origin

  async function api(path, opts = {}) {
    const { headers, body, ...rest } = opts;
    const res = await fetch(API_BASE + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body != null && typeof body !== 'string' ? JSON.stringify(body) : body,
      ...rest,
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = { raw: text }; } }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || 'Something went wrong');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Only a healthy answer is cached: a failed check (cold start, a blip) is
  // asked again next time instead of leaving the page offline for the visit.
  let _healthy = false;
  async function health() {
    if (_healthy) return true;
    try {
      const res = await fetch(API_BASE + '/api/health', { credentials: 'include' });
      _healthy = res.ok;
    } catch (_) { _healthy = false; }
    return _healthy;
  }

  // Signed out is the normal case: /api/auth/session answers 200 {user:null}
  // (no 401 in the console), and this hands back null for it, as before.
  async function me() {
    try { const s = await api('/api/auth/session'); return s && s.user ? s : null; }
    catch (e) { if (e.status === 401) return null; throw e; }
  }

  // The marketplace fee rules (service fee, delivery, free-delivery threshold).
  // Cached; falls back to sensible defaults if the backend isn't reachable.
  let _config = null;
  async function config() {
    if (_config) return _config;
    try { _config = await api('/api/config'); }
    catch (_) { _config = { currency: 'aed', serviceFeeCents: 0, deliveryFeeCents: 3000, freeDeliveryThresholdCents: 20000, commissionPercent: 40, platformFeePercent: 40, aiTagsEnabled: false }; }
    return _config;
  }

  async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {} }

  window.TroveAPI = {
    base: API_BASE,
    paymentsEnabled: !!CFG.STRIPE_PUBLISHABLE_KEY,
    stripeKey: CFG.STRIPE_PUBLISHABLE_KEY || '',
    api, health, me, logout, config,
  };
})();

/* ------------------------------------------------------------------ *
 * window.troveTrack(event, params) — analytics: one GA4-ready push to
 * Google Tag Manager's dataLayer. The container sits in each page's <head>
 * behind Consent Mode v2 (backend/src/gtm.js), so nothing is stored or
 * sent with an identifier until the cookie banner records a choice.
 *   - An ecommerce event clears the previous ecommerce object first, as
 *     GA4 asks, so items never carry over from one event to the next.
 *   - Never throws: analytics can't break a page.
 *   - Returns a Promise that settles once Tag Manager has run its tags for
 *     the event (or after a second and a half; at once when it never
 *     loaded), so a page about to navigate away can wait for the hit.
 * NO personal data, ever: pieces, prices and public order numbers only —
 * never an email, name, phone, address, account id or IBAN. As a last line
 * of defence anything shaped like an email address is blanked.
 * ------------------------------------------------------------------ */
(function () {
  var EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi;
  function clean(v, depth) {
    if (typeof v === 'string') return v.replace(EMAIL, '[redacted]');
    if (!v || typeof v !== 'object' || depth > 6) return v;
    if (Array.isArray(v)) return v.map(function (x) { return clean(x, depth + 1); });
    var out = {};
    Object.keys(v).forEach(function (k) { out[k] = clean(v[k], depth + 1); });
    return out;
  }
  /* True once the latest gtag consent command on the dataLayer grants
   * analytics_storage — guards that keep a note in the browser (e.g. the
   * once-per-order purchase key) only do so after the visitor agrees. */
  window.troveAnalyticsConsent = function () {
    var granted = false;
    try {
      (window.dataLayer || []).forEach(function (e) {
        if (!e || typeof e !== 'object' || e[0] !== 'consent' || (e[1] !== 'default' && e[1] !== 'update')) return;
        var st = e[2] && e[2].analytics_storage;
        if (st === 'granted' || st === 'denied') granted = st === 'granted';
      });
    } catch (_) { granted = false; }
    return granted;
  };
  window.troveTrack = function (event, params) {
    return new Promise(function (resolve) {
      var settled = false, waiting = false;
      function done() { if (!settled) { settled = true; resolve(); } }
      try {
        var dl = (window.dataLayer = window.dataLayer || []);
        var msg = { event: String(event) }, p = clean(params || {}, 0);
        Object.keys(p).forEach(function (k) { if (k !== 'event') msg[k] = p[k]; });
        // Tag Manager calls eventCallback once this event's tags have fired.
        if (window.google_tag_manager) { waiting = true; msg.eventCallback = done; msg.eventTimeout = 1000; setTimeout(done, 1500); }
        if (msg.ecommerce) dl.push({ ecommerce: null });
        dl.push(msg);
      } catch (_) { /* analytics never breaks the page */ }
      if (!waiting) done();
    });
  };
})();

/* Interim matched photography (owner, 2026-09-02): a hand-picked stock photo per
 * piece so the storefront can be judged with real imagery before our own shoots
 * land. Keyed by product name; seller uploads always win. Shared here so the
 * storefront and the admin crop editor show the same cover. Delete this map
 * when the PHOTOGRAPHY-MANIFEST shoots replace it. */
window.TROVE_STOCK_IMG = (function () {
  const u = (id) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=72`;
  return {
    'Reeded Stoneware Mug': u('1495100497150-fe209c585f50'),
    'Lopapeysa Wool Sweater': u('1630013348455-c47fb12c8742'),
    'Hammered Brass Tray': u('1633015690070-df90035bca9d'),
    'Cedar & Smoke Candle': u('1612293905607-b003de9e54fb'),
    'Linen-Bound Notebook': u('1654542645844-590f5b8c146a'),
    'Waxed Canvas Weekender': u('1448582649076-3981753123b5'),
    'Glazed Serving Bowl': u('1552740844-4f8a8206c68d'),
    'Merino Watch Cap': u('1664289321749-07316ab5e374'),
    'Folded Leather Wallet': u('1628483211662-9bcc692c46dc'),
    'Botanical Room Mist': u('1608571702600-5a5419d31475'),
    'Glazed Ceramic Planter': u('1604762525953-2c80447cc4a6'),
    'Weighted Brass Clip': u('1572866314964-231d42916df3'),
    'Hand-Knotted Wool Throw': u('1674475760738-8c7af859f821'),
    'Fig & Vetiver Wax Melts': u('1643716991721-15b3e95660a7'),
    'Handwoven Linen Cushion Cover': u('1617597193786-a3afcf869f23'),
    'Dune Lines': u('1755686974373-08a7d29f1ccd'),
    'Falaj Gardens': u('1620509400919-a2ef8294f239'),
    'Walnut & Leather Valet Tray': u('1654124803546-aebfbf0959a5'),
    'Turned Teak Catch-All Bowl': u('1651589822716-2bb531112b8a'),
    'Raw Stone Signet Ring': u('1778759335295-b332b4eaac15'),
    'Hammered Silver Stacking Bands': u('1501046791521-e24baf06e55b'),
    'Desert Stone Pendant': u('1610694955371-d4a3e0ce4b52'),
  };
})();
