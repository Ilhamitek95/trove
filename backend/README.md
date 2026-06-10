# trove — backend

API for the trove multi-vendor marketplace: accounts & sessions, a products/orders
database, and **Stripe Connect** payouts that split one customer payment across
multiple shops, minus your platform fee.

Stack: Node + Express + SQLite (`better-sqlite3`) + Stripe. SQLite keeps it
zero-config for development; the schema maps cleanly onto Postgres for production.

---

## Run it

```bash
cd trove-backend
cp .env.example .env          # then fill in your Stripe test key
npm install
npm run seed                  # demo users, shops, products
npm run dev                   # http://localhost:4242
```

Demo logins (password `demo1234`): `layla@email.com` (buyer), `mara@kilnandclay.com`
(seller), `hello@trove.com` (house label / admin).

Serve the storefront HTML from a real origin (not `file://`) so cookies and CORS
work — e.g. from the folder with `trove.html`: `npx serve -l 3000`. Make sure
`CLIENT_URL` in `.env` matches.

### Stripe webhooks (for payouts)

Payouts happen when Stripe confirms payment, so you need the webhook running:

```bash
stripe login
stripe listen --forward-to localhost:4242/api/stripe/webhook
# paste the printed whsec_... into STRIPE_WEBHOOK_SECRET in .env, then restart
```

---

## How the money flows (separate charges & transfers)

1. **Onboarding** — a seller hits `POST /api/seller/connect`; we create a Stripe
   **Express** account and return a hosted onboarding link. Stripe collects their
   identity and bank details — those never touch your servers.
2. **Checkout** — `POST /api/checkout` recomputes every price from the DB (the
   client is never trusted), groups the cart by shop, saves a `pending` order, and
   opens **one** PaymentIntent on the platform tagged with `transfer_group=order_<id>`.
   The client confirms it with Stripe.js.
3. **Payout** — on the `payment_intent.succeeded` webhook we mark the order paid,
   decrement stock, and create a **Transfer** to each shop's connected account for
   that shop's subtotal minus `PLATFORM_FEE_PERCENT`. Your fee (and Stripe's
   processing fee) stay on the platform. This is why a cart spanning three shops
   "just works" — one charge in, three transfers out.

---

## Endpoints

```
GET    /api/health

POST   /api/auth/register     {email,password,name,role?,shopName?}
POST   /api/auth/login        {email,password}
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/products          ?q= &category= &house=1 &shop=slug
GET    /api/products/:id

# seller (must own a shop)
GET    /api/seller/me
PATCH  /api/seller/me
GET    /api/seller/products
POST   /api/seller/products
PATCH  /api/seller/products/:id
DELETE /api/seller/products/:id
GET    /api/seller/orders
POST   /api/seller/connect            -> { url }   (onboarding)
GET    /api/seller/connect/status     -> { chargesEnabled, payoutsEnabled }
POST   /api/seller/connect/login-link -> { url }   (Express dashboard)

# buyer (must be signed in)
GET    /api/account/orders
GET    /api/account/addresses
POST   /api/account/addresses
PATCH  /api/account/addresses/:id
DELETE /api/account/addresses/:id

POST   /api/checkout          {items:[{productId,qty}], email, address}
POST   /api/stripe/webhook    (Stripe only; raw body)
```

---

## Wiring the existing front-end

The HTML prototypes currently hold data in memory. To go live, point them at the
API. Always send `credentials:'include'` so the session cookie travels.

```js
const API = 'http://localhost:4242';

// storefront — load products
const { products } = await (await fetch(`${API}/api/products`, { credentials:'include' })).json();

// seller dashboard — change a price
await fetch(`${API}/api/seller/products/${id}`, {
  method:'PATCH', credentials:'include',
  headers:{ 'Content-Type':'application/json' },
  body: JSON.stringify({ price: 72 }),
});

// seller dashboard — connect Stripe (replaces the simulated flow)
const { url } = await (await fetch(`${API}/api/seller/connect`, { method:'POST', credentials:'include' })).json();
window.location = url;

// checkout — create the payment, then confirm with Stripe.js
const r = await (await fetch(`${API}/api/checkout`, {
  method:'POST', credentials:'include',
  headers:{ 'Content-Type':'application/json' },
  body: JSON.stringify({ items: cart.map(c => ({ productId:c.pid, qty:c.qty })), address }),
})).json();
// const stripe = Stripe('pk_test_...');
// await stripe.confirmPayment({ clientSecret: r.clientSecret, ... });
```

---

## Production checklist

- Swap SQLite → Postgres; move sessions to a real store (Redis/Postgres) and set
  `cookie.secure = true` behind HTTPS.
- Serve API and client on the same parent domain (or configure CORS + cookies for
  cross-site) and use a real domain in the Connect `return_url`.
- Verify webhooks in the live environment; handle `charge.refunded`,
  `transfer.failed`, and reversals.
- Add rate limiting, input validation (zod/Joi), and Helmet.
- Use idempotency keys on PaymentIntent/Transfer creation.
