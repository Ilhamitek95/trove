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
  const PORT = process.env.PORT || 4242;
  const isProd = process.env.NODE_ENV === 'production';
  const crossSite = process.env.CROSS_SITE === '1';   // set ONLY when the frontend lives on a different domain than this API

  // CLIENT_URL = this site's public URL (used for Stripe return links).
  // For split hosting you may list several allowed origins, comma-separated.
  // RENDER_EXTERNAL_URL is set automatically by Render, so no config is needed there.
  const CLIENT_URL = process.env.CLIENT_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const ALLOWED_ORIGINS = CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean);

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

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const orderId = Number(pi.metadata.order_id);
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);

      if (order && order.status === 'pending') {
        const cfg = require('./config');

        // Per-shop groups, used inside the transaction (ledger credits) and
        // after it (Rail B transfers for mixed carts).
        const groups = db.prepare(`
          SELECT oi.shop_id, s.stripe_account_id, s.charges_enabled, s.tier, SUM(oi.price_cents * oi.qty) AS cents
          FROM order_items oi JOIN shops s ON s.id = oi.shop_id
          WHERE oi.order_id = ? GROUP BY oi.shop_id`).all(orderId);

        // VAT is captured per order once Trove is registered. Prices are
        // VAT-inclusive: consignment rail owes 5/105 of the full amount
        // charged (Trove is the seller); connect rail only of the margin.
        const vat = !cfg.vatRegistered() ? 0
          : order.rail === 'connect' ? cfg.vatFromGross(fees.split(order.subtotal_cents).fee)
          : cfg.vatFromGross(order.total_cents);

        // ONE transaction for every database effect of this payment, with the
        // idempotency guard inside it: if the INSERT OR IGNORE of the event id
        // changes nothing, Stripe redelivered an event we fully processed —
        // bail out. If anything below throws, the event id rolls back with the
        // rest, so Stripe's retry gets a clean second attempt.
        const applied = db.transaction(() => {
          const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type) VALUES (?,?)').run(event.id, event.type);
          if (!seen.changes) return false;

          // Payment success is the moment Trove purchases the goods from its
          // suppliers: title transfers now, and the buyer-facing order is paid.
          db.prepare("UPDATE orders SET status='paid', title_transferred_at=datetime('now'), vat_amount_cents=? WHERE id=?").run(vat, orderId);
          for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId)) {
            db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?').run(it.qty, it.product_id);
          }
          // One shipment per shop, so each supplier fulfils and tracks their own items.
          for (const { shop_id } of db.prepare('SELECT DISTINCT shop_id FROM order_items WHERE order_id=?').all(orderId)) {
            const exists = db.prepare('SELECT id FROM shipments WHERE order_id=? AND shop_id=?').get(orderId, shop_id);
            if (!exists) {
              const r = db.prepare("INSERT INTO shipments (order_id, shop_id, status) VALUES (?,?, 'processing')").run(orderId, shop_id);
              db.prepare("INSERT INTO shipment_events (shipment_id, status, note) VALUES (?, 'processing', 'Order received — preparing your items')").run(r.lastInsertRowid);
            }
          }
          // Consignment ledger: record what Trove now owes each supplier —
          // their list price minus the purchase margin. Connect-rail orders
          // (destination charges) bypass the ledger entirely; the unique
          // index on (order, shop) is a second line of defence against
          // double credits.
          if (order.rail !== 'connect') {
            const credit = db.prepare("INSERT OR IGNORE INTO seller_balances (shop_id, order_id, type, amount_cents) VALUES (?,?, 'credit_sale', ?)");
            for (const g of groups) {
              if (g.tier === 'consignment') credit.run(g.shop_id, orderId, fees.split(g.cents).net);
            }
          }
          return true;
        })();

        if (applied) {
          // Book the courier pickup for every shipment of this order —
          // outside the transaction (network IO), failure never blocks the
          // payment and the seller stepper still works by hand.
          const delivery = require('./delivery');
          for (const sh of db.prepare('SELECT id FROM shipments WHERE order_id=?').all(orderId)) {
            delivery.bookPickup(sh.id).catch((e) => console.error('Pickup booking failed for shipment', sh.id, e.message));
          }
        }

        if (applied && order.rail !== 'connect') {
          // Rail B leftover: a mixed cart can contain a connect-tier shop's
          // items; those are paid per sale via a Transfer (never from the
          // consignment ledger). Only when the flag is on and the shop is
          // fully onboarded.
          for (const g of groups) {
            if (g.tier !== 'connect') continue;
            const { net } = fees.split(g.cents);
            if (cfg.railBEnabled() && g.stripe_account_id && g.charges_enabled && net > 0) {
              stripe.transfers.create({
                amount: net,
                currency: order.currency,
                destination: g.stripe_account_id,
                transfer_group: `order_${orderId}`,
                metadata: { order_id: String(orderId), shop_id: String(g.shop_id) },
              }).then((tr) => {
                db.prepare('UPDATE order_items SET transfer_id=? WHERE order_id=? AND shop_id=?').run(tr.id, orderId, g.shop_id);
              }).catch((e) => console.error('Transfer failed for shop', g.shop_id, e.message));
            } else {
              console.warn(`Shop ${g.shop_id} is connect-tier but not payable (flag ${cfg.railBEnabled() ? 'on' : 'off'}, onboarded ${!!(g.stripe_account_id && g.charges_enabled)}) — funds held on platform.`);
            }
          }
        }
      }
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
  app.use(express.json({ limit: '6mb' })); // roomy enough for base64 image uploads
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

  /* ---------------- Routes ---------------- */
  app.get('/api/health', (_req, res) => res.json({ ok: true, stripe: !!getStripe() }));
  // Public money rules, so the storefront shows the same fees the server charges.
  app.get('/api/config', (_req, res) => res.json({
    currency: process.env.CURRENCY || 'aed',
    serviceFeeCents: fees.SERVICE_FEE_CENTS,
    deliveryFeeCents: fees.DELIVERY_FEE_CENTS,
    freeDeliveryThresholdCents: fees.FREE_DELIVERY_THRESHOLD_CENTS,
    commissionPercent: fees.COMMISSION_PERCENT,
    platformFeePercent: fees.PLATFORM_FEE_PERCENT, // deprecated alias of commissionPercent
    railBEnabled: require('./config').railBEnabled(),
    vatRegistered: require('./config').vatRegistered(),
    serviceAreas: require('./service-area').SERVICE_AREAS,
    aiTagsEnabled: require('./ai').enabled(),
    googleClientId: require('./google-auth').clientId(),
  }));
  // Storefront search beacon — the shop page filters locally, so it reports
  // each search here. Anonymous by design: query text and hit count only.
  app.post('/api/search-log', (req, res) => {
    const { q, results } = req.body || {};
    require('./trends').logSearch(q, results);
    res.status(204).end();
  });
  // Popular searches for the storefront's no-result page. Anonymous term
  // text only, each re-checked against the live catalogue before serving.
  app.get('/api/search/popular', (_req, res) => {
    res.json({ terms: require('./trends').popularSearches(30, 6) });
  });
  // The seller agreement, served with its hash so acceptance is verifiable.
  app.get('/api/legal/seller-agreement', (_req, res) => {
    const fs = require('fs');
    const file = path.join(__dirname, '..', 'legal', `seller-agreement-${require('./config').AGREEMENT_VERSION}.md`);
    const markdown = fs.readFileSync(file, 'utf8');
    res.json({ version: require('./config').AGREEMENT_VERSION, markdown, sha256: require('./crypto').sha256(markdown) });
  });

  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/products', require('./routes/products.routes'));
  app.use('/api/shops', require('./routes/shops.routes'));
  app.use('/api/seller', require('./routes/seller.routes'));
  app.use('/api/admin', require('./routes/admin.routes'));
  app.use('/api/checkout', require('./routes/checkout.routes'));
  app.use('/api/account', require('./routes/account.routes'));
  app.use('/api/delivery', require('./routes/delivery.routes'));

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

  // Every page has one clean canonical address; the raw filename (and its
  // extensionless variant) 301s there, keeping the query string intact so
  // old bookmarks and Stripe return links keep working.
  const PAGES = {
    '/login': 'trove-login.html',
    '/account': 'trove-account.html',
    '/sell': 'trove-seller.html',
    '/apply': 'trove-apply.html',
    '/admin': 'trove-admin.html',
    '/seller-agreement': 'seller-agreement.html',
  };
  for (const [clean, file] of Object.entries(PAGES)) {
    app.get(clean, (_req, res) => res.sendFile(path.join(DOCS_DIR, file)));
    for (const legacy of ['/' + file, '/' + file.replace(/\.html$/, '')]) {
      if (legacy === clean) continue;
      app.get(legacy, (req, res) => {
        const q = req.originalUrl.indexOf('?');
        res.redirect(301, clean + (q === -1 ? '' : req.originalUrl.slice(q)));
      });
    }
  }

  app.use(express.static(DOCS_DIR, { index: 'trove.html', extensions: ['html'] }));

  // Seller-uploaded images (shop photos). Kept on the persistent disk in prod.
  app.use('/uploads', express.static(require('./uploads').UPLOADS_DIR, { maxAge: '30d', immutable: true }));

  // Anything left is a miss: branded 404 page for browsers, JSON for the rest
  // (unknown /api/* paths never reach here — they get their JSON 404 above).
  app.use((req, res) => {
    if (req.accepts('html')) return res.status(404).sendFile(path.join(DOCS_DIR, '404.html'));
    res.status(404).json({ error: 'Not found' });
  });

  /* ---------------- Errors ---------------- */
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  });

  return app;
}

module.exports = { createApp };
