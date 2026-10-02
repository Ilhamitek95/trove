'use strict';
/**
 * Express app factory. server.js boots the process (env, seed, admin
 * bootstrap, crons) and calls createApp(); the test suite calls createApp()
 * directly against a temp database with the Stripe mock.
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const db = require('./db');
const SqliteStore = require('./session-store');
const { getStripe } = require('./stripe');
const fees = require('./fees');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const PORT = process.env.PORT || 4242;
  const traffic = require('./traffic');

  // gzip/brotli every text response (the storefront HTML alone is ~210 KB
  // raw, ~40 KB compressed). Mounted first so it wraps everything below.
  app.use(require('compression')());
  // One public address (the old *.onrender.com host 301s there) and the
  // security headers on every response — see security.js.
  const security = require('./security');
  app.use(security.canonicalHost());
  app.use(security.securityHeaders());
  const isProd = process.env.NODE_ENV === 'production';
  const crossSite = process.env.CROSS_SITE === '1';   // set ONLY when the frontend lives on a different domain than this API

  // CLIENT_URL = this site's public URL (used for Stripe return links).
  // For split hosting you may list several allowed origins, comma-separated.
  // RENDER_EXTERNAL_URL is set automatically by Render, so no config is needed there.
  const CLIENT_URL = process.env.CLIENT_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  // APP_ORIGINS = extra origins allowed to call the API (the Trove app's web build).
  // Kept separate from CLIENT_URL, which must stay a single URL for Stripe links.
  const APP_ORIGINS = (process.env.APP_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ALLOWED_ORIGINS = [...CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean), ...APP_ORIGINS];

  // Behind a hosting proxy (Render/Railway/Fly) so secure cookies are honoured.
  app.set('trust proxy', 1);

  /* --------------------------------------------------------------------------
   * STRIPE WEBHOOK — must read the RAW body, so it is mounted BEFORE
   * express.json. On payment success the order is marked paid and, on the
   * consignment rail, each supplier's purchase price is credited to the ledger.
   * ------------------------------------------------------------------------ */
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).end();
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook signature failed: ${err.message}`);
    }

    // A Services Marketplace booking paid through Trove (metadata.kind set by
    // src/service-bookings.js). Same guarantees as orders: signature checked
    // above, idempotent through webhook_events inside one transaction.
    const obj = event.data && event.data.object;
    if (event.type === 'payment_intent.succeeded' && obj && obj.metadata && obj.metadata.kind === 'service_booking') {
      require('./service-bookings').onPaymentSucceeded(event);
      return res.json({ received: true });
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const orderId = Number(pi.metadata.order_id);
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);

      if (order && order.status === 'pending') {
        // Paid effects live in src/paid-effects.js (shared with the demo-mode
        // checkout and the hourly sweep that catches a missed webhook).
        // ONE transaction for every database effect of this payment, with the
        // idempotency guard inside it: a redelivered event changes nothing,
        // and if anything throws the event id rolls back with the rest, so
        // Stripe's retry gets a clean second attempt.
        require('./paid-effects').completePaid(orderId, event.id, event.type, stripe);
      } else if (order && order.status === 'cancelled' && !order.refunded_at && !order.attention) {
        // Paid after the unpaid-checkout sweep cancelled it (the PaymentIntent
        // cancel lost the race): nothing was reserved for it, so refund it.
        const first = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?,?)').run(event.id, event.type).changes;
        if (first) {
          db.prepare("UPDATE orders SET attention='paid_after_cancel' WHERE id=?").run(order.id);
          require('./paid-effects').unavailablePostEffects(order, [], stripe, { soldOut: false });
        }
      }
    }

    // Card disputes and refunds made outside Trove (src/stripe-events.js):
    // applied once per event id; a failure rolls the id back so Stripe's
    // retry gets another go.
    if (require('./stripe-events').TYPES.includes(event.type)) {
      const first = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?,?)').run(event.id, event.type).changes;
      if (!first) return res.json({ received: true, duplicate: true });
      return require('./stripe-events').handle(event, stripe)
        .then(() => res.json({ received: true }))
        .catch((e) => {
          console.error(`stripe ${event.type} handling failed:`, e.message);
          db.prepare('DELETE FROM webhook_events WHERE event_id=?').run(event.id);
          res.status(500).json({ error: 'Could not apply the event — Stripe will retry' });
        });
    }

    if (event.type === 'account.updated') {
      const acct = event.data.object;
      db.prepare('UPDATE shops SET charges_enabled=?, payouts_enabled=? WHERE stripe_account_id=?')
        .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0, acct.id);
      // Graduation completes here: an admin verified the license and created
      // the Custom account; once Stripe enables payouts (and Rail B is on),
      // the supplier moves to the Connect rail.
      if (require('./config').railBEnabled() && acct.payouts_enabled) {
        const flipped = db.prepare(`UPDATE shops SET tier='connect', connect_queue=0
          WHERE stripe_account_id=? AND tier='consignment' AND license_verified_at IS NOT NULL`).run(acct.id).changes;
        if (flipped) console.log(`graduation: ${acct.id} is now on the Connect rail`);
      }
    }

    res.json({ received: true });
  });

  /* ---------------- Standard middleware ---------------- */
  // CORS only matters in split hosting; for single-origin the browser sends no Origin.
  app.use(cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true); // same-origin, curl, allowed list
      return cb(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: true,
  }));
  // rawBody is kept for HMAC-signed courier webhooks (routes/delivery.routes.js).
  app.use(express.json({ limit: '6mb', verify: (req, _res, buf) => { req.rawBody = buf; } })); // roomy enough for base64 image uploads
  app.use(session({
    store: new SqliteStore(),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,                          // HTTPS-only in production
      sameSite: crossSite ? 'none' : 'lax',    // 'none' needed when frontend is a different domain
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }));
  // Admin sessions need the emailed second step and last 12 hours (admin-2fa.js).
  app.use(require('./admin-2fa').guard);
  // Languages (src/i18n.js): /ar/<anything public> is the Arabic twin of
  // <anything public>; the prefix is stripped here so every route below
  // answers both, req.lang says which, and every HTML response is finished
  // (Arabic text, rtl, hreflang) on its way out.
  const i18n = require('./i18n');
  app.use(i18n.middleware({ base: () => (process.env.PUBLIC_URL || CLIENT_URL.split(',')[0].trim()).replace(/\/+$/, '') }));

  /* ---------------- Traffic limits (per client IP) ----------------
   * Safety net for one process on one instance: a scraper, a bot or a
   * runaway script cannot starve real shoppers. Ordinary browsing never gets
   * near these numbers (a page view is ~5 API calls).                       */
  const MIN = 60 * 1000;
  app.use('/api', traffic.rateLimit({ windowMs: MIN, max: 600, name: 'requests' }));
  const authLimiter = traffic.rateLimit({ windowMs: 10 * MIN, max: 30, name: 'sign-in attempts' });
  app.use('/api/auth', (req, res, next) => (req.method === 'POST' ? authLimiter(req, res, next) : next()));
  // The two other doors that create or extend an account share that budget.
  app.post(['/api/services/apply', '/api/seller/enable-services'], authLimiter);
  // Anonymous booking requests email and notify a provider, so a script can't
  // flood one: 10 requests an hour per address.
  const bookingLimiter = traffic.rateLimit({ windowMs: 60 * MIN, max: 10, name: 'booking requests' });
  app.post('/api/services/:id/book', bookingLimiter);
  app.use('/api/checkout', traffic.rateLimit({ windowMs: 10 * MIN, max: 60, name: 'checkout requests' }));
  // The contact form emails the owner: a handful per visitor is plenty.
  const contactLimiter = traffic.rateLimit({ windowMs: 10 * MIN, max: 5, name: 'messages' });
  app.post('/api/contact', contactLimiter);
  const beaconLimiter = traffic.rateLimit({ windowMs: MIN, max: 120, name: 'events' });
  app.use(['/api/track', '/api/search-log'], beaconLimiter);
  // Public catalogue reads: cache briefly in the browser/CDN. Searches (`q`)
  // are excluded because each one is logged for the trends feature, and any
  // signed-in path (my-…) is never cached.
  const catalogueCache = traffic.publicCache(30);
  const cacheCatalogue = (req, res, next) =>
    (req.method === 'GET' && !req.query.q && !/^\/my-/.test(req.path) ? catalogueCache(req, res, next) : next());
  app.use(['/api/products', '/api/shops', '/api/services'], cacheCatalogue);
  const siteCache = traffic.publicCache(300);
  app.use(['/api/config', '/api/content', '/api/legal', '/api/search/popular'], siteCache);

  /* ---------------- Routes ---------------- */
  app.get('/api/health', (_req, res) => res.json({ ok: true, stripe: !!getStripe(), delivery: require('./delivery').mode() }));
  // Public money rules, so the storefront shows the same fees the server charges.
  app.get('/api/config', (_req, res) => res.json({
    currency: process.env.CURRENCY || 'aed',
    serviceFeeCents: fees.SERVICE_FEE_CENTS,
    deliveryFeeCents: fees.DELIVERY_FEE_CENTS,
    freeDeliveryThresholdCents: fees.FREE_DELIVERY_THRESHOLD_CENTS,
    // Delivery estimate = a piece's make/pack time (leadDays) + this window.
    courierTransitMinDays: fees.COURIER_TRANSIT_MIN_DAYS,
    courierTransitMaxDays: fees.COURIER_TRANSIT_MAX_DAYS,
    leadDaysDefault: fees.LEAD_DAYS_DEFAULT,
    leadDaysMin: fees.LEAD_DAYS_MIN,
    leadDaysMax: fees.LEAD_DAYS_MAX,
    commissionPercent: fees.COMMISSION_PERCENT,
    platformFeePercent: fees.PLATFORM_FEE_PERCENT, // deprecated alias of commissionPercent
    railBEnabled: require('./config').railBEnabled(),
    vatRegistered: require('./config').vatRegistered(),
    serviceAreas: require('./service-area').SERVICE_AREAS,
    aiTagsEnabled: require('./ai').enabled(),
    googleClientId: require('./google-auth').clientId(),
    providerSubFeeCents: fees.PROVIDER_SUB_FEE_CENTS,
    serviceCommissionPercent: fees.SERVICE_COMMISSION_PERCENT,
    // Whether bookings can be paid through Trove by card — the server's own
    // answer (a Stripe secret key is configured), not the page's publishable key.
    serviceCardPayments: !!getStripe(),
    providerAgreementVersion: require('./config').PROVIDER_AGREEMENT_VERSION,
    servicesTermsVersion: require('./config').SERVICES_TERMS_VERSION,
  }));
  // Storefront search beacon — the shop page filters locally, so it reports
  // each search here. Anonymous by design: query text and hit count only.
  app.post('/api/search-log', (req, res) => {
    const { q, results } = req.body || {};
    require('./trends').logSearch(q, results);
    res.status(204).end();
  });
  // Storefront analytics beacon — one shopper action (a shop page opened, a
  // piece opened, a piece added to the basket) for the seller's dashboard.
  // The body never names the shop: it is resolved server-side from the piece,
  // so a beacon can only ever write into the numbers it belongs to. Always
  // 204, whatever the outcome — the reply must not confirm what exists.
  app.post('/api/track', (req, res) => {
    const { kind, productId, shop, visitor, source } = req.body || {};
    try {
      require('./analytics').track({ kind, productId, shopSlug: shop, visitor, source, userId: req.session.userId });
    } catch (e) { console.error('track failed:', e.message); }
    res.status(204).end();
  });
  // Popular searches for the storefront's no-result page. Anonymous term
  // text only, each re-checked against the live catalogue before serving.
  app.get('/api/search/popular', (_req, res) => {
    res.json({ terms: require('./trends').popularSearches(30, 6) });
  });
  // Storefront copy for the homepage + sell page — defaults with any
  // admin-saved overrides layered on top. Edited in /admin → Site content.
  app.get('/api/content', (req, res) => {
    res.json(require('./translate').siteContent(require('./content').getPublic(), req.lang));
  });
  // Legal documents, served with their hash so acceptance is verifiable.
  // Each version comes from config.js (see src/site-pages.js LEGAL), and the
  // same file is rendered into the page at /terms, /privacy, /seller-agreement…
  const sitePages = require('./site-pages');
  // ?lang=ar adds the Arabic convenience translation; version/markdown/sha256
  // stay the English ones, which acceptance records point at.
  app.get('/api/legal/:doc', (req, res) => {
    const d = sitePages.legalDoc(req.params.doc, req.lang);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json({ version: d.version, markdown: d.markdown, sha256: d.sha256, ...(d.arabic ? { arabic: d.arabic } : {}) });
  });

  // Admin → Activity: a lasting record of every admin write and every write
  // made in shop view (src/admin-audit.js), written after the response.
  app.use('/api', require('./admin-audit').middleware);
  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/products', require('./routes/products.routes'));
  app.use('/api/shops', require('./routes/shops.routes'));
  app.use('/api/seller', require('./routes/seller.routes'));
  app.use('/api/admin/privacy', require('./routes/privacy.routes'));
  app.use('/api/admin', require('./routes/admin.routes'));
  app.use('/api/admin', require('./routes/admin-bookings.routes'));
  app.use('/api/checkout', require('./routes/checkout.routes'));
  app.use('/api/account', require('./routes/account.routes'));
  app.use('/api/delivery', require('./routes/delivery.routes'));
  app.use('/api/services', require('./routes/services.routes'));
  app.use('/api/provider', require('./routes/provider.routes'));
  app.use('/api/contact', require('./routes/contact.routes'));

  // Unknown /api/* path → JSON 404 (so the SPA fallback below never swallows API calls).
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  /* ---------------- Static storefront (single-origin) ----------------
   * Serves docs/ from the same origin as the API, so session cookies are
   * first-party and there's one URL to deploy. "/" serves the storefront
   * directly; the old /trove.html (and friends) 301 to the clean root so
   * bookmarks and indexed links keep working.                               */
  const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');
  for (const legacy of ['/trove.html', '/trove', '/index.html', '/index']) {
    app.get(legacy, (_req, res) => res.redirect(301, '/'));
  }
  const seo = require('./seo');
  // Google Tag Manager rides in every page's <head>, except on private links
  // (a booking or reset token in the address): see src/gtm.js.
  const gtm = require('./gtm');
  const keepQuery = (req) => { const q = req.originalUrl.indexOf('?'); return q === -1 ? '' : req.originalUrl.slice(q); };
  const SITE_BASE = () => (process.env.PUBLIC_URL || CLIENT_URL.split(',')[0].trim()).replace(/\/+$/, '');

  // One address per page: a trailing slash, or capitals in a public path
  // (/Services, /services/, /Shop/Ceramics), 301 to the canonical spelling.
  // Express matches case-insensitively and ignores a trailing slash, so
  // without this every variant answered 200 with the same page. Booking and
  // payment links keep their case (their codes are case-sensitive).
  const CASE_FOLDED = /^\/(services|shop|makers|pieces|sell-on-trove|about|contact|faq|returns|delivery-returns|terms|privacy|seller-agreement|provider-agreement|services-terms|apply|login)(\/|$)/i;
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path;
    if (p.startsWith('/uploads/') || /\.[a-z0-9]+$/i.test(p) || /^\/services\/(booking|pay)\//i.test(p)) return next();
    let target = p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
    if (CASE_FOLDED.test(target) && target !== target.toLowerCase()) target = target.toLowerCase();
    if (target === p) return next();
    res.redirect(301, target + keepQuery(req));
  });
  // A miss: the branded 404 page, a real 404 status, never indexed.
  const fileCache = {};
  /** A docs/ page's source, re-read only when the file changes. */
  const docFile = (file) => {
    const f = path.join(DOCS_DIR, file);
    const stamp = require('fs').statSync(f).mtimeMs;
    const c = fileCache[file];
    if (!c || c.stamp !== stamp) fileCache[file] = { stamp, html: require('fs').readFileSync(f, 'utf8') };
    return fileCache[file].html;
  };
  const notFound = (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    if (req.accepts('html')) return res.status(404).type('html').set('Cache-Control', 'no-cache').send(gtm.forAddress(req, res, docFile('404.html')));
    res.status(404).json({ error: 'Not found' });
  };

  // Every page has one clean canonical address; the raw filename (and its
  // extensionless variant) 301s there, keeping the query string intact so
  // old bookmarks and Stripe return links keep working.
  const PAGES = {
    '/login': 'trove-login.html',
    '/reset': 'trove-login.html',      // password reset link (?token=…), a mode of the sign-in page
    '/account': 'trove-account.html',
    '/sell': 'trove-seller.html',
    '/apply': 'trove-apply.html',
    '/admin': 'trove-admin.html',
    '/services': 'trove-services.html',
    '/provider': 'trove-provider.html',
  };
  // One application for pieces, services or both: the old provider wizard
  // address lands on the same form with services preselected.
  app.get(['/become-a-provider', '/trove-provider-apply.html', '/trove-provider-apply'], (_req, res) => res.redirect(301, '/apply?for=services'));
  // Pages served as they are, plus the site-wide social tags when the page
  // has none of its own (signed-in surfaces get them without a canonical).
  const PUBLIC_FILES = new Set(['/apply']);
  const servePage = (clean, file) => (req, res) => {
    res.type('html').set('Cache-Control', 'no-cache')
      .send(gtm.forAddress(req, res, seo.withDefaultSocial(docFile(file), { base: SITE_BASE(), url: SITE_BASE() + clean, noindex: !PUBLIC_FILES.has(clean), path: clean })));
  };
  // The Services Marketplace directory, server-rendered (src/seo.js).
  app.get('/services', (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(seo.renderServicesDirectory(SITE_BASE(), req.lang)));
  for (const [clean, file] of Object.entries(PAGES)) {
    app.get(clean, servePage(clean, file));
    for (const legacy of ['/' + file, '/' + file.replace(/\.html$/, '')]) {
      if (legacy === clean) continue;
      app.get(legacy, (req, res) => {
        const q = req.originalUrl.indexOf('?');
        res.redirect(301, clean + (q === -1 ? '' : req.originalUrl.slice(q)));
      });
    }
  }

  /* ---------------- Server-rendered public pages ----------------
   * About, Contact, Help centre, Delivery & Returns and the legal documents
   * (src/site-pages.js): real text in the HTML, the shared header + footer,
   * canonical, Open Graph and Organization structured data.              */
  const html = (res, body) => res.type('html').set('Cache-Control', 'no-cache').send(gtm.forAddress(res.req, res, body));
  app.get('/about', (req, res) => html(res, sitePages.renderAbout(SITE_BASE(), req.lang)));
  app.get('/contact', (req, res) => html(res, sitePages.renderContact(SITE_BASE(), {
    lang: req.lang,
    sent: req.query.sent === '1',
    error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '',
  })));
  app.get('/faq', (req, res) => html(res, sitePages.renderFaq(SITE_BASE(), req.lang)));
  app.get(['/returns', '/delivery-returns'], (req, res) => html(res, sitePages.renderReturns(SITE_BASE(), req.lang)));
  for (const name of Object.keys(sitePages.LEGAL)) {
    const d = sitePages.LEGAL[name];
    app.get(d.path, (req, res) => html(res, sitePages.renderLegal(SITE_BASE(), name, req.lang)));
  }
  // Old and obvious addresses land on the right page.
  const REDIRECTS = {
    '/seller-agreement.html': '/seller-agreement', '/provider-agreement.html': '/provider-agreement', '/services-terms.html': '/services-terms',
    '/how-curation-works': '/about#curation', '/our-story': '/about', '/help': '/faq', '/help-centre': '/faq',
    '/delivery': '/returns', '/shipping': '/returns', '/terms-of-sale': '/terms', '/privacy-policy': '/privacy',
  };
  for (const [from, to] of Object.entries(REDIRECTS)) app.get(from, (_req, res) => res.redirect(301, to));

  /* ---------------- The storefront's own addresses ----------------
   * Every public view of the single-page storefront has a clean address,
   * served with its own head tags, structured data and text (src/seo.js).
   * The old query addresses 301 to them; anything unknown is a real 404.  */
  const page = (res, req, out) => {
    if (out.redirect) return res.redirect(301, out.redirect + keepQuery(req));
    if (out.notFound) return notFound(req, res);
    html(res, out.html);
  };
  app.get('/', (req, res) => {
    const target = seo.legacyTarget(req.query);
    if (target) return res.redirect(301, target);
    html(res, seo.renderHome(SITE_BASE(), req.lang));
  });
  app.get('/shop', (req, res) => page(res, req, seo.renderShop(SITE_BASE(), null, { search: req.query.q, lang: req.lang })));
  app.get('/shop/:cat([a-z0-9-]+)', (req, res) => page(res, req, seo.renderShop(SITE_BASE(), req.params.cat, { search: req.query.q, lang: req.lang })));
  app.get('/pieces/:ref', (req, res) => page(res, req, seo.renderPiece(SITE_BASE(), req.params.ref, req.lang)));
  app.get('/makers/:slug', (req, res) => page(res, req, seo.renderMaker(SITE_BASE(), req.params.slug, req.lang)));
  app.get('/sell-on-trove', (req, res) => html(res, seo.renderSell(SITE_BASE(), req.lang)));

  // A provider's public page: /services/<slug>, server-rendered; unknown or
  // unapproved providers are a real 404. Slugs never contain a dot, so asset
  // paths under /services/ fall through to the 404 instead of getting HTML.
  app.get('/services/:slug([a-z0-9-]+)', (req, res) => page(res, req, seo.renderProvider(SITE_BASE(), req.params.slug, req.lang)));
  // A booking's private pages (the link in the customer's emails): the same
  // services page opens the booking view. Never indexed — the URL is the key,
  // so it is never tagged either (src/gtm.js strips Tag Manager from it).
  const bookingPage = (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').set('Cache-Control', 'no-cache').send(gtm.forAddress(req, res, docFile('trove-services.html')));
  };
  app.get('/services/booking/:code([A-Za-z0-9-]+)', bookingPage);
  app.get('/services/pay/:ref([A-Za-z0-9-]+)', bookingPage);

  /* ---------------- Search engines ----------------
   * The public storefront is indexable; the signed-in surfaces (account,
   * seller/provider dashboards, admin, login) and the API are not. The
   * sitemap is built from the live catalogue on request.                    */
  const SITE = () => (process.env.PUBLIC_URL || CLIENT_URL.split(',')[0].trim()).replace(/\/+$/, '');
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send([
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /admin',
      'Disallow: /account',
      'Disallow: /sell',
      'Disallow: /provider',
      'Disallow: /login',
      // /sell and /provider are prefix rules; the agreements and the maker
      // pitch are public (the longest matching rule wins).
      'Allow: /seller-agreement',
      'Allow: /sell-on-trove',
      'Allow: /provider-agreement',
      'Disallow: /services/booking/',
      'Disallow: /services/pay/',
      'Disallow: /reset',
      // The Arabic twins (/ar/…) follow the same rules.
      'Disallow: /ar/account',
      'Disallow: /ar/sell',
      'Disallow: /ar/provider',
      'Disallow: /ar/login',
      'Allow: /ar/seller-agreement',
      'Allow: /ar/sell-on-trove',
      'Allow: /ar/provider-agreement',
      'Disallow: /ar/services/booking/',
      'Disallow: /ar/services/pay/',
      'Disallow: /ar/reset',
      '',
      `Sitemap: ${SITE()}/sitemap.xml`,
      '',
    ].join('\n'));
  });
  app.get('/sitemap.xml', (_req, res) => {
    const base = SITE();
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Every address in both languages, each naming its twin (hreflang).
    const urls = seo.sitemapEntries().flatMap((u) => {
      const en = base + u.loc;
      const ar = base + i18n.arUrl(u.loc);
      const alt = `<xhtml:link rel="alternate" hreflang="en" href="${esc(en)}"/><xhtml:link rel="alternate" hreflang="ar" href="${esc(ar)}"/><xhtml:link rel="alternate" hreflang="x-default" href="${esc(en)}"/>`;
      const tail = `${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority>`;
      return [`<url><loc>${esc(en)}</loc>${tail}${alt}</url>`, `<url><loc>${esc(ar)}</loc>${tail}${alt}</url>`];
    });
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
  });

  // For AI answer engines: a short, accurate summary and the full help text.
  app.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(sitePages.llmsTxt(SITE())));
  app.get('/llms-full.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(sitePages.llmsFullTxt(SITE())));

  app.use(express.static(DOCS_DIR, { index: 'trove.html', extensions: ['html'], setHeaders: traffic.staticHeaders }));

  // Seller-uploaded images (shop photos). Kept on the persistent disk in prod.
  app.use('/uploads', express.static(require('./uploads').UPLOADS_DIR, { maxAge: '30d', immutable: true }));

  // Anything left is a miss: branded 404 page for browsers, JSON for the rest
  // (unknown /api/* paths never reach here — they get their JSON 404 above).
  app.use(notFound);

  /* ---------------- Errors ---------------- */
  // A deliberate 4xx (a route or body-parser error with a status) keeps its
  // message — it is written for the person using the site. Anything 5xx is
  // logged in full here and answered generically: raw internals (SQLite
  // constraint names, env variable names) never reach the browser.
  app.use((err, _req, res, _next) => {
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 500) {
      console.error(err);
      return res.status(status).json({ error: err.expose === true ? err.message : 'Something went wrong on our side — please try again in a moment' });
    }
    console.error(err.message);
    res.status(status).json({ error: err.message || 'Something went wrong with that request' });
  });

  return app;
}

module.exports = { createApp };
