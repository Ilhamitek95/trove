'use strict';
/**
 * Traffic hygiene for a single-instance deployment — the pieces that let one
 * Node process on a Render Standard instance serve ~10K visitors a day with
 * headroom, without adding a second service:
 *
 *   • rateLimit()     — small in-memory per-IP limiter (fixed window). Guards
 *                       the endpoints a bot or a runaway script can hammer:
 *                       sign-in/sign-up, checkout, the anonymous beacons, and
 *                       the API as a whole. Answers 429 JSON once the window
 *                       is spent. Behind Render's proxy req.ip is the real
 *                       client (app.set('trust proxy', 1)).
 *   • publicCache()   — Cache-Control for the read-only public JSON the
 *                       storefront fetches on every visit (catalogue, shops,
 *                       site copy, fees). Nothing in those responses depends
 *                       on who is asking, so a browser (and the CDN in front
 *                       of Render) may hold them briefly instead of hitting
 *                       SQLite for every page view. Never applied to searches
 *                       (they feed the trends log) or anything session-bound.
 *   • staticHeaders() — long browser/CDN cache for fonts, images and icons;
 *                       HTML is always revalidated so a deploy shows at once.
 */

const WINDOW_SWEEP_MS = 60 * 1000;

/**
 * The client's address behind Render's edge. Render (and the Cloudflare layer
 * in front of it) puts the real client first in X-Forwarded-For and, when
 * present, in CF-Connecting-IP; keying on the LAST hop instead would put
 * every shopper in one bucket behind a shared proxy address.
 */
function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim() || req.ip || 'unknown';
  return req.ip || 'unknown';
}

function rateLimit({ windowMs, max, name = 'requests', keyFn = clientKey }) {
  const hits = new Map(); // key → { count, resetAt }
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < WINDOW_SWEEP_MS) return;
    lastSweep = now;
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  const mw = (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === '1') return next();
    const now = Date.now();
    sweep(now);
    const key = keyFn(req);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    if (entry.count > max) {
      const retry = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many ${name} — please try again in a moment.` });
    }
    next();
  };
  mw.reset = () => hits.clear();
  return mw;
}

/** Cache-Control for anonymous, user-independent GET responses. */
function publicCache(seconds, { swr = seconds * 5 } = {}) {
  const value = `public, max-age=${seconds}, stale-while-revalidate=${swr}`;
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') res.set('Cache-Control', value);
    next();
  };
}

// Files that only change with a deploy and are safe to hold for a week.
const LONG_LIVED = /\.(woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico|css|js)$/i;
const ASSET_MAX_AGE = 7 * 24 * 60 * 60;

/** express.static setHeaders hook: long cache for assets, revalidate HTML. */
function staticHeaders(res, filePath) {
  if (LONG_LIVED.test(filePath)) {
    res.set('Cache-Control', `public, max-age=${ASSET_MAX_AGE}, stale-while-revalidate=86400`);
  } else {
    res.set('Cache-Control', 'no-cache');
  }
}

module.exports = { rateLimit, publicCache, staticHeaders, clientKey, ASSET_MAX_AGE };
