'use strict';
/**
 * Response hardening for every page and API call:
 *
 *   securityHeaders()   HSTS (production only), nosniff, no framing, a
 *                       conservative referrer policy and a Content Security
 *                       Policy. The CSP is deliberately permissive where the
 *                       site needs it — the pages carry inline scripts,
 *                       inline event handlers and inline styles, so
 *                       'unsafe-inline' stays — and names every third party
 *                       the pages actually load: Stripe (Elements, 3-D
 *                       Secure, wallets), Google sign-in, Google Fonts, and
 *                       images from anywhere over https (Unsplash stock,
 *                       Google avatars) plus data:/blob: previews. What it
 *                       buys: no framing of /admin or checkout (clickjacking),
 *                       no plugins, no <base> hijack, and scripts only from
 *                       this site, Stripe and Google. A CSP that works beats a
 *                       strict one that breaks checkout; CSP_REPORT_ONLY=1
 *                       switches it to report-only if something ever breaks.
 *
 *   canonicalHost()     301s a GET/HEAD on any other host name (the
 *                       *.onrender.com address, an IP) to the one public
 *                       address, keeping the path and query. CANONICAL_HOST
 *                       sets it (default troveathome.com in production, off
 *                       elsewhere; 'off' disables it). /api/health is never
 *                       redirected (Render's health check), nor localhost, and
 *                       POSTs (Stripe/courier webhooks) are never redirected.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com https://*.stripecdn.com https://accounts.google.com https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com https://*.stripe.network https://*.stripecdn.com https://accounts.google.com https://maps.googleapis.com",
  "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://*.stripe.network https://*.stripecdn.com https://accounts.google.com https://pay.google.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders() {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
      res.set('Strict-Transport-Security', 'max-age=31536000');
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set(process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', CSP);
    next();
  };
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$|\.(local|localhost|test)$/;

function canonicalHost() {
  return (req, res, next) => {
    const env = process.env.CANONICAL_HOST;
    const target = (env != null && env !== ''
      ? env
      : (process.env.NODE_ENV === 'production' ? 'troveathome.com' : '')).trim().toLowerCase();
    if (!target || target === 'off') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/api/health') return next();
    const host = String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '');
    if (!host || host === target || LOCAL.test(host)) return next();
    res.redirect(301, `https://${target}${req.originalUrl}`);
  };
}

module.exports = { securityHeaders, canonicalHost, CSP };
