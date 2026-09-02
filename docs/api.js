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

  let _healthy = null;
  async function health() {
    if (_healthy !== null) return _healthy;
    try {
      const res = await fetch(API_BASE + '/api/health', { credentials: 'include' });
      _healthy = res.ok;
    } catch (_) { _healthy = false; }
    return _healthy;
  }

  async function me() {
    try { return await api('/api/auth/me'); }
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
