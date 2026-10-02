'use strict';
/**
 * Languages: English (the source) and Arabic (Modern Standard Arabic).
 *
 * Every public address has an Arabic twin under /ar (/ar, /ar/shop,
 * /ar/pieces/<id>-<slug>, /ar/makers/<slug>, /ar/services…). Slugs stay the
 * same. The /ar prefix is stripped by middleware() before routing, so every
 * route in app.js answers both languages; req.lang says which one.
 *
 * Interface strings live in dictionaries, docs/i18n/<lang>/<bundle>.json,
 * keyed by the English text itself (gettext style). The same dictionaries
 * feed three places:
 *   - translateHtml(): the server translates the static text of a page
 *     (text nodes + placeholder/title/aria-label/alt) before sending it,
 *     so an Arabic page is Arabic in its first paint and to crawlers;
 *   - the browser: finishPage() injects the page's dictionary as
 *     window.TROVE_I18N and docs/api.js exposes _t() / _tn() to page code;
 *   - server code (seo.js, site-pages.js, email.js): t(lang, key, vars).
 * A page names its bundles in <meta name="trove-i18n" content="a,b">.
 * A plural entry is an object of CLDR forms ({one, other} in English;
 * zero/one/two/few/many/other in Arabic) under the English plural key.
 *
 * Remembering the choice: an /ar page sets the trove_lang cookie (and
 * users.lang when signed in); an English page asked for with the cookie (or
 * a signed-in account) set to Arabic 302s to its /ar twin. The switch to
 * English is the English address with ?hl=en, which sets the cookie back.
 * Crawlers carry no cookie, so both languages stay indexable.
 *
 * Numbers stay Western digits. Prices in Arabic text are wrapped in Unicode
 * isolates (LRI … PDI) so 'AED 120' never scrambles inside right-to-left
 * text — iso() / money().
 */
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'ar'];
const DEFAULT_LANG = 'en';
const COOKIE = 'trove_lang';
const I18N_DIR = path.join(__dirname, '..', '..', 'docs', 'i18n');

/* ---------------- addresses ---------------- */

/** Paths that have an Arabic twin (mirrored in docs/api.js — test/i18n.test.js pins them equal). */
const LOCALIZED_RE = /^\/(?:|shop(?:\/[a-z0-9-]*)?|pieces\/[^/]+|makers\/[^/]+|services(?:\/[a-z0-9-]+|\/booking\/[A-Za-z0-9-]+|\/pay\/[A-Za-z0-9-]+)?|sell-on-trove|about|faq|contact|returns|delivery-returns|terms|privacy|seller-agreement|provider-agreement|services-terms|apply|login|reset|account|sell|provider|become-a-provider|help|help-centre|delivery|shipping|terms-of-sale|privacy-policy|our-story|how-curation-works)$/i;

/** The path part of a local URL ('/shop?q=x#y' → '/shop'). */
const pathOf = (u) => String(u || '').split(/[?#]/)[0] || '/';
function isLocalizable(p) {
  const x = pathOf(p);
  return LOCALIZED_RE.test(x.length > 1 ? x.replace(/\/+$/, '') : x);
}
/** '/shop?q=1' → '/ar/shop?q=1'; '/' → '/ar'; anything else unchanged. */
function arUrl(u) {
  const s = String(u || '');
  if (!s.startsWith('/') || s.startsWith('//') || /^\/ar(?:[/?#]|$)/.test(s) || !isLocalizable(s)) return s;
  const p = pathOf(s);
  const rest = s.slice(p.length);
  return (p === '/' ? '/ar' : '/ar' + p) + rest;
}
/** '/ar/shop' → '/shop'; '/ar' → '/'. */
function stripAr(u) {
  const s = String(u || '');
  const m = /^\/ar(?=[/?#]|$)/.exec(s);
  if (!m) return s;
  const rest = s.slice(3);
  return !rest || rest[0] === '?' || rest[0] === '#' ? '/' + rest : rest;
}
/** The address of path p in a language. */
const localUrl = (lang, p) => (lang === 'ar' ? arUrl(p) : p);

/* ---------------- dictionaries ---------------- */
const cache = new Map();
function bundle(lang, name) {
  const f = path.join(I18N_DIR, lang, `${name}.json`);
  let stamp = 0;
  try { stamp = fs.statSync(f).mtimeMs; } catch (_) { return {}; }
  const key = `${lang}/${name}`;
  const c = cache.get(key);
  if (c && c.stamp === stamp) return c.data;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error(`i18n: ${key}.json is not valid JSON: ${e.message}`); }
  cache.set(key, { stamp, data });
  return data;
}
/** Every bundle that exists (file names without .json). */
function bundleNames(lang = 'en') {
  try { return fs.readdirSync(path.join(I18N_DIR, lang)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch (_) { return []; }
}
/** The merged dictionary of some bundles ('common' is always first). */
function dict(lang, names = []) {
  const out = {};
  for (const n of ['common', ...names.filter((x) => x && x !== 'common')]) Object.assign(out, bundle(lang, n));
  return out;
}

/** Prices inside Arabic text sit in a left-to-right isolate, so 'AED 120' never scrambles. */
const isoPrices = (s) => String(s).replace(/(^|[^⁦])(AED\s?\d(?:[\d,.]*\d)?)/g, '$1⁦$2⁩');
const fillVars = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : String(s));

/**
 * Server-side lookup: t(lang, key, vars, bundles). English (or a missing
 * entry) gives the key back, with {vars} filled in.
 */
function t(lang, key, vars, names = ['server']) {
  if (lang !== 'ar') return fillVars(key, vars);
  const v = dict('ar', names)[key];
  return isoPrices(fillVars(typeof v === 'string' && v ? v : key, vars));
}
const RULES = { ar: new Intl.PluralRules('ar'), en: new Intl.PluralRules('en') };
/** Plural: tn(lang, n, '{n} piece', '{n} pieces'). The Arabic entry sits under the English plural (other) key. */
function tn(lang, n, one, other, vars, names = ['server']) {
  const v = { n, ...(vars || {}) };
  if (lang !== 'ar') return fillVars(n === 1 ? one : other, v);
  const e = dict('ar', names)[other];
  if (e && typeof e === 'object') {
    const form = RULES.ar.select(n);
    return isoPrices(fillVars(e[form] || e.other || other, v));
  }
  return isoPrices(fillVars(typeof e === 'string' && e ? e : (n === 1 ? one : other), v));
}

/* ---------------- numbers ---------------- */
const LRI = '\u2066';
const PDI = '\u2069';
/** Left-to-right isolate for Arabic text ('AED 120', an order number, an email). */
const iso = (lang, s) => (lang === 'ar' ? LRI + s + PDI : String(s));
function money(lang, amount) {
  const n = Number(amount) || 0;
  const s = 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return iso(lang, s);
}
const moneyCents = (lang, c) => money(lang, (Number(c) || 0) / 100);
/** A date in the language (Western digits, Gregorian calendar). */
function date(lang, d, opts = { day: 'numeric', month: 'long', year: 'numeric' }) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return x.toLocaleDateString(lang === 'ar' ? 'ar-AE-u-nu-latn-ca-gregory' : 'en-GB', { timeZone: 'Asia/Dubai', ...opts });
}

/* ---------------- HTML ---------------- */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', middot: '·', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', rarr: '→', larr: '←', times: '×', copy: '©', bull: '•', pound: '£' };
const decode = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; }
  return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
});
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const norm = (s) => decode(s).replace(/\s+/g, ' ').trim();

const SKIP_TEXT = new Set(['script', 'style', 'textarea', 'svg', 'code', 'pre', 'noscript', 'math']);
const RAW = new Set(['script', 'style', 'textarea']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'stop', 'use']);
const T_ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-label', 'aria-roledescription', 'data-empty'];
const META_CONTENT = /\b(?:name|property)="(?:description|og:title|og:description|og:image:alt|twitter:title|twitter:description|apple-mobile-web-app-title)"/;

function trText(txt, d) {
  const key = norm(txt);
  if (!key) return txt;
  const v = d[key];
  if (typeof v !== 'string' || !v) return txt;
  const lead = txt.match(/^\s*/)[0];
  const trail = txt.match(/\s*$/)[0];
  return lead + escText(isoPrices(v)) + trail;
}
function trTag(tag, d, { translate, links }) {
  let out = tag;
  if (translate) {
    out = out.replace(/(\s)([a-z-]+)="([^"]*)"/gi, (m, sp, name, val) => {
      const n = name.toLowerCase();
      const isMetaContent = n === 'content' && /^<meta\b/i.test(tag) && META_CONTENT.test(tag);
      if (!T_ATTRS.includes(n) && !isMetaContent && !(n === 'value' && /^<input\b[^>]*type="(?:submit|button)"/i.test(tag))) return m;
      const v = d[norm(val)];
      return typeof v === 'string' && v ? `${sp}${name}="${escAttr(isoPrices(v))}"` : m;
    });
  }
  if (links && !/\sdata-lang-switch\b/.test(tag)) out = out.replace(/(\s(?:href|action)=")(\/[^"]*)"/gi, (m, a, u) => `${a}${arUrl(u)}"`);
  return out;
}
/** Index just past the close tag matching an open <name> whose content starts at i (nested same-name tags counted). */
function findClose(html, i, name) {
  const re = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'gi');
  re.lastIndex = i;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { depth -= 1; if (!depth) return { start: m.index, end: re.lastIndex }; } else if (!m[2]) depth += 1;
  }
  return null;
}

/**
 * Translate the static text of a page with a dictionary: text nodes,
 * the translatable attributes, and elements marked data-i18n (their whole
 * inner HTML is replaced — the key is the attribute's value, or the
 * element's normalised inner HTML when it has none). Script/style
 * contents are never touched; neither is text inside translate="no".
 * With links set, local addresses in href/action get their /ar twin.
 */
function translateHtml(html, d, { links = false } = {}) {
  const n = html.length;
  let out = '';
  let i = 0;
  let skip = null; // { name, depth }
  while (i < n) {
    const lt = html.indexOf('<', i);
    const end = lt === -1 ? n : lt;
    if (end > i) out += skip ? html.slice(i, end) : trText(html.slice(i, end), d);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      const stop = e === -1 ? n : e + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    let j = lt + 1;
    let q = null;
    while (j < n) {
      const c = html[j];
      if (q) { if (c === q) q = null; } else if (c === '"') q = c; else if (c === '>') break;
      j += 1;
    }
    const tag = html.slice(lt, j + 1);
    i = j + 1;
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (!m) { out += tag; continue; }
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    if (closing) {
      if (skip && skip.name === name && --skip.depth === 0) skip = null;
      out += tag;
      continue;
    }
    const selfClose = /\/>$/.test(tag) || VOID.has(name);
    if (skip) {
      if (skip.name === name && !selfClose) skip.depth += 1;
      out += trTag(tag, d, { translate: false, links });
      if (RAW.has(name)) { const c = findRawClose(html, i, name); out += html.slice(i, c); i = c; }
      continue;
    }
    // data-i18n: the element's inner HTML is one dictionary entry.
    const di = /\sdata-i18n(?:="([^"]*)")?(?=[\s>/])/.exec(tag);
    if (di && !selfClose) {
      const close = findClose(html, i, name);
      if (close) {
        const inner = html.slice(i, close.start);
        const key = di[1] ? decode(di[1]) : inner.replace(/\s+/g, ' ').trim();
        const v = d[key];
        out += trTag(tag, d, { translate: true, links });
        out += typeof v === 'string' && v ? isoPrices(v) : translateHtml(inner, d, { links });
        out += html.slice(close.start, close.end);
        i = close.end;
        continue;
      }
    }
    out += trTag(tag, d, { translate: true, links });
    if (RAW.has(name)) { const c = findRawClose(html, i, name); out += html.slice(i, c); i = c; continue; }
    if (!selfClose && (SKIP_TEXT.has(name) || /\stranslate="no"/i.test(tag))) skip = { name, depth: 1 };
  }
  return out;
}
function findRawClose(html, i, name) {
  const re = new RegExp(`</${name}\\s*>`, 'gi');
  re.lastIndex = i;
  const m = re.exec(html);
  return m ? m.index : html.length;
}

/** The bundles a page asks for: <meta name="trove-i18n" content="storefront">. */
function pageBundles(html) {
  const m = html.match(/<meta name="trove-i18n" content="([^"]*)"/);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}


/** hreflang alternates + the language's canonical, from the page's English canonical. */
function alternates(html, lang, base) {
  const m = html.match(/<link rel="canonical" href="([^"]*)">/);
  if (!m) return html;
  const href = decode(m[1]);
  const b = String(base || '').replace(/\/+$/, '');
  if (!b || !href.startsWith(b)) return html;
  const enPath = stripAr(href.slice(b.length) || '/');
  if (!isLocalizable(enPath)) return html;
  const en = b + enPath;
  const ar = b + arUrl(enPath);
  const own = lang === 'ar' ? ar : en;
  const tags = [
    `<link rel="canonical" href="${escAttr(own)}">`,
    `<link rel="alternate" hreflang="en" href="${escAttr(en)}">`,
    `<link rel="alternate" hreflang="ar" href="${escAttr(ar)}">`,
    `<link rel="alternate" hreflang="x-default" href="${escAttr(en)}">`,
  ].join('\n');
  let out = html.replace(m[0], tags);
  out = out.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escAttr(own)}">`);
  return out;
}

/**
 * The last step of every HTML response. English: hreflang alternates only.
 * Arabic: the page's static text translated, lang="ar" dir="rtl", the
 * Arabic fonts + docs/rtl.css, the dictionary for the page's own script,
 * /ar links, the Arabic canonical + og:locale + JSON-LD inLanguage.
 */
function finishPage(html, { lang = 'en', base = '', path: reqPath = '/', query = '' } = {}) {
  if (typeof html !== 'string' || !/<html\b/i.test(html)) return html;
  let out = alternates(html, lang, base);
  out = langSwitch(out, lang, reqPath, query);
  if (lang !== 'ar') return out;
  const names = pageBundles(out);
  const d = dict('ar', names);
  out = translateHtml(out, d, { links: true });
  out = out.replace(/<html\b([^>]*)>/i, (m, attrs) => {
    let a = attrs.replace(/\slang="[^"]*"/i, '').replace(/\sdir="[^"]*"/i, '');
    return `<html lang="ar" dir="rtl"${a}>`;
  });
  out = out.replace('<meta property="og:locale" content="en_GB">', '<meta property="og:locale" content="ar_AE">\n<meta property="og:locale:alternate" content="en_GB">');
  out = out.replace(/"inLanguage":"en"/g, '"inLanguage":"ar"');
  const data = `<script>window.TROVE_LANG="ar";window.TROVE_I18N=${JSON.stringify(d).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};</script>`;
  if (/<meta charset="utf-8">/i.test(out)) out = out.replace(/<meta charset="utf-8">/i, (m) => `${m}\n${data}`);
  else out = out.replace(/<head>/i, (m) => `${m}\n${data}`);
  // docs/rtl.css: the right-to-left layout and the Arabic faces (added to
  // the brand's own font families by unicode-range, so they load only here).
  out = out.replace('</head>', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="/rtl.css">\n</head>');
  return out;
}

/**
 * The header's English / العربية switch (<a data-lang-switch>): its address
 * is this page in the other language — English asked for with ?hl=en, which
 * makes the server forget a remembered Arabic choice.
 */
function langSwitch(html, lang, reqPath, query) {
  if (!html.includes('data-lang-switch')) return html;
  const p = isLocalizable(reqPath) ? reqPath : '/';
  const params = new URLSearchParams(String(query || '').replace(/^\?/, ''));
  params.delete('hl');
  const qs = params.toString();
  const target = lang === 'ar'
    ? `${p}?${qs ? `${qs}&` : ''}hl=en`
    : arUrl(p) + (qs ? `?${qs}` : '');
  return html.replace(/<a\b([^>]*\bdata-lang-switch\b[^>]*)>([\s\S]*?)<\/a>/g, (m, attrs, inner) => {
    let a = attrs.replace(/\shref="[^"]*"/, ` href="${escAttr(target)}"`);
    if (lang !== 'ar') return `<a${a}>${inner}</a>`;
    a = a.replace(/\shreflang="[^"]*"/, ' hreflang="en"').replace(/\slang="[^"]*"/, ' lang="en"').replace(/\stitle="[^"]*"/, ' title="Read Trove in English"');
    return `<a${a}>${inner.replace('العربية', 'English')}</a>`;
  });
}

/* ---------------- request plumbing ---------------- */
function cookieLang(req) {
  const m = /(?:^|;\s*)trove_lang=(en|ar)\b/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function setCookie(res, lang) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
}
function saveUserLang(req, lang) {
  const uid = req.session && req.session.userId;
  if (!uid) return;
  try { require('./db').prepare("UPDATE users SET lang=? WHERE id=? AND COALESCE(lang,'en')<>?").run(lang, uid, lang); } catch (_) { /* never breaks a page */ }
}
function userLang(req) {
  const uid = req.session && req.session.userId;
  if (!uid) return null;
  try { const r = require('./db').prepare('SELECT lang FROM users WHERE id=?').get(uid); return r && LANGS.includes(r.lang) ? r.lang : null; } catch (_) { return null; }
}
/** The language of an API call: ?lang=ar or the X-Trove-Lang header (sent by docs/api.js). */
function apiLang(req) {
  const q = req.query && req.query.lang;
  const h = req.get && req.get('x-trove-lang');
  return q === 'ar' || h === 'ar' ? 'ar' : 'en';
}

/**
 * Mounted before the routes (after the session). Strips /ar, remembers
 * the choice, sends a remembered Arabic reader to the /ar twin, and
 * finishes every HTML response (finishPage) and local redirect.
 */
function middleware({ base } = {}) {
  return (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/api') { req.lang = apiLang(req); return next(); }
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    const m = /^\/ar(\/.*)?$/i.exec(req.path);
    const qi = req.url.indexOf('?');
    const query = qi === -1 ? '' : req.url.slice(qi);
    if (m) {
      if (req.path.slice(0, 3) !== '/ar' || req.path === '/ar/') {
        const rest = req.path.slice(3).replace(/\/+$/, '');
        return res.redirect(301, '/ar' + rest + query);
      }
      req.lang = 'ar';
      const rest = m[1] || '/';
      req.url = (isLocalizable(rest.toLowerCase()) ? rest : '/__ar-miss') + query;
      if (isGet && req.accepts('html')) { setCookie(res, 'ar'); saveUserLang(req, 'ar'); }
    } else {
      req.lang = 'en';
      if (isGet && isLocalizable(req.path) && req.accepts('html')) {
        res.vary('Cookie');
        if (req.query.hl === 'en' || req.query.hl === 'ar') {
          const want = req.query.hl;
          setCookie(res, want);
          saveUserLang(req, want);
          const params = new URLSearchParams(query.slice(1));
          params.delete('hl');
          const qs = params.toString();
          const target = req.path + (qs ? `?${qs}` : '');
          return res.redirect(302, want === 'ar' ? arUrl(target) : target);
        }
        const remembered = cookieLang(req) || userLang(req);
        if (remembered === 'ar') {
          if (!cookieLang(req)) setCookie(res, 'ar');
          return res.redirect(302, arUrl(req.path) + query);
        }
      }
    }
    const lang = req.lang;
    const send = res.send.bind(res);
    res.send = (body) => {
      const ct = String(res.get('Content-Type') || '');
      if (typeof body === 'string' && (/html/.test(ct) || (!ct && /^\s*(<!--[\s\S]*?-->\s*)?<(!doctype|html)/i.test(body)))) {
        try {
          const qi2 = req.url.indexOf('?');
          body = finishPage(body, { lang, base: typeof base === 'function' ? base() : base, path: req.path, query: qi2 === -1 ? '' : req.url.slice(qi2) });
        } catch (e) { console.error('i18n: finishPage failed:', e.message); }
      }
      return send(body);
    };
    if (lang === 'ar') {
      const redirect = res.redirect.bind(res);
      res.redirect = (a, b) => {
        const [status, url] = typeof a === 'number' ? [a, b] : [302, a];
        return redirect(status, typeof url === 'string' ? arUrl(url) : url);
      };
    }
    next();
  };
}

module.exports = {
  LANGS, DEFAULT_LANG, COOKIE, I18N_DIR, LOCALIZED_RE, isLocalizable, arUrl, stripAr, localUrl,
  bundle, bundleNames, dict, t, tn, iso, isoPrices, money, moneyCents, date, decode, norm,
  translateHtml, finishPage, pageBundles, middleware, apiLang, cookieLang, escText, escAttr,
};
