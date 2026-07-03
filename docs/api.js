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
    catch (_) { _config = { currency: 'aed', serviceFeeCents: 900, deliveryFeeCents: 2500, freeDeliveryThresholdCents: 50000, commissionPercent: 20, platformFeePercent: 20 }; }
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
