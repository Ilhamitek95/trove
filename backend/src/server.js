'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const db = require('./db');
const { stripe } = require('./stripe');

const app = express();
const PORT = process.env.PORT || 4242;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const FEE_PCT = Number(process.env.PLATFORM_FEE_PERCENT || 8);

/* ----------------------------------------------------------------------------
 * STRIPE WEBHOOK — must read the RAW body, so it is mounted BEFORE express.json.
 * On payment success we mark the order paid, decrement stock, and pay each shop
 * via a Transfer (the marketplace's 8% stays on the platform).
 * -------------------------------------------------------------------------- */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
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
      // Mark paid + decrement stock atomically.
      db.transaction(() => {
        db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(orderId);
        for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId)) {
          db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?').run(it.qty, it.product_id);
        }
      })();

      // Pay out each shop: subtotal for that shop minus the platform fee.
      const groups = db.prepare(`
        SELECT oi.shop_id, s.stripe_account_id, s.charges_enabled, SUM(oi.price_cents * oi.qty) AS cents
        FROM order_items oi JOIN shops s ON s.id = oi.shop_id
        WHERE oi.order_id = ? GROUP BY oi.shop_id`).all(orderId);

      for (const g of groups) {
        const fee = Math.round((g.cents * FEE_PCT) / 100);
        const payout = g.cents - fee;
        if (g.stripe_account_id && g.charges_enabled && payout > 0) {
          stripe.transfers.create({
            amount: payout,
            currency: order.currency,
            destination: g.stripe_account_id,
            transfer_group: `order_${orderId}`,
            metadata: { order_id: String(orderId), shop_id: String(g.shop_id) },
          }).then((tr) => {
            db.prepare('UPDATE order_items SET transfer_id=? WHERE order_id=? AND shop_id=?').run(tr.id, orderId, g.shop_id);
          }).catch((e) => console.error('Transfer failed for shop', g.shop_id, e.message));
        } else {
          console.warn(`Shop ${g.shop_id} not ready for payout — funds held on platform.`);
        }
      }
    }
  }

  if (event.type === 'account.updated') {
    const acct = event.data.object;
    db.prepare('UPDATE shops SET charges_enabled=?, payouts_enabled=? WHERE stripe_account_id=?')
      .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0, acct.id);
  }

  res.json({ received: true });
});

/* ---------------- Standard middleware ---------------- */
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 14 }, // set secure:true behind HTTPS
}));

/* ---------------- Routes ---------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, stripe: !!stripe }));
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/products', require('./routes/products.routes'));
app.use('/api/seller', require('./routes/seller.routes'));
app.use('/api/checkout', require('./routes/checkout.routes'));
app.use('/api/account', require('./routes/account.routes'));

/* ---------------- Errors ---------------- */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`trove API on http://localhost:${PORT}  (client: ${CLIENT_URL})`));
