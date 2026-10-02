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
const LONG_LIVED = /\.(woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico)$/i;
// Scripts and styles ship together with the (no-cache) HTML that calls them,
// so they may only be held for long under a version stamp (F130).
const CODE = /\.(css|js)$/i;
const ASSET_MAX_AGE = 7 * 24 * 60 * 60;
const CODE_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * express.static setHeaders hook: long cache for fonts/images; scripts and
 * styles cached for a year ONLY when the address carries ?v=<content hash>
 * (written into every page by versionAssets below — a new deploy changes the
 * hash, so the browser fetches the new file at once); an unstamped script
 * revalidates every time (cheap: ETag → 304). HTML always revalidates.
 */
function staticHeaders(res, filePath) {
  if (LONG_LIVED.test(filePath)) {
    res.set('Cache-Control', `public, max-age=${ASSET_MAX_AGE}, stale-while-revalidate=86400`);
  } else if (CODE.test(filePath) && res.req && typeof res.req.query.v === 'string' && /^[a-f0-9]{8,40}$/.test(res.req.query.v)) {
    res.set('Cache-Control', `public, max-age=${CODE_MAX_AGE}, immutable`);
  } else {
    res.set('Cache-Control', 'no-cache');
  }
}

/**
 * Stamps local <script src> / <link href> addresses of .js/.css files in
 * every HTML response with ?v=<first 10 hex of the file's SHA-1>, read from
 * docsDir (re-hashed only when the file changes). Mount BEFORE the i18n
 * middleware so the stylesheet it injects is stamped too.
 */
function versionAssets(docsDir) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const cache = new Map();
  const root = path.resolve(docsDir);
  const hashOf = (rel) => {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return null;
    let st;
    try { st = fs.statSync(file); } catch (_) { return null; }
    if (!st.isFile()) return null;
    const c = cache.get(file);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.v;
    const v = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    cache.set(file, { mtime: st.mtimeMs, size: st.size, v });
    return v;
  };
  const stamp = (html) => html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")((?!\/\/)[^"?#:]+\.(?:js|css))"/gi, (m, pre, url) => {
    const v = hashOf(url.replace(/^\/+/, ''));
    return v ? `${pre}${url}?v=${v}"` : m;
  });
  const mw = (req, res, next) => {
    const send = res.send.bind(res);
    res.send = (body) => {
      const ct = String(res.get('Content-Type') || '');
      const isHtml = /html/.test(ct) || (!ct && /^\s*(<!--[\s\S]*?-->\s*)?<(!doctype|html)/i.test(String(body)));
      if (typeof body === 'string' && isHtml && /<(script|link)\b/i.test(body)) {
        try { body = stamp(body); } catch (e) { console.error('versionAssets failed:', e.message); }
      }
      return send(body);
    };
    next();
  };
  mw.stamp = stamp;
  return mw;
}

module.exports = { rateLimit, publicCache, staticHeaders, versionAssets, clientKey, ASSET_MAX_AGE, CODE_MAX_AGE };
