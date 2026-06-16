# trove

A curated multi-vendor marketplace — independent shops plus an own house label
(*trove label*). Shoppers browse and buy; sellers run a shop and get paid via
Stripe; one customer payment is split across the shops in a cart, minus the
platform fee.

```
trove/
├── docs/        The storefront, account, login and seller pages + api.js + config.js
└── backend/     Node + Express + SQLite API with Stripe Connect — also serves docs/
```

**This is now a working app, not just a prototype.** The pages talk to the
backend for real: sign-up / sign-in, a real product database, a cart that checks
out through Stripe, buyer orders & addresses, and a seller dashboard with product
management and Stripe Connect payouts.

The backend serves the storefront from the **same address** (“single-origin”), so
there is **one thing to run and one thing to deploy**, and logins just work.

---

## Run it locally

You only need to run the backend — it serves the website too.

```bash
cd backend
cp .env.example .env       # then open .env and add your Stripe TEST keys (optional for browsing)
npm install
npm run seed               # loads the demo shops + products
npm run dev                # then open http://localhost:4242
```

Open **http://localhost:4242** — that's the full site, running on live data.

Demo logins (password `demo1234`):
`layla@email.com` (shopper) · `mara@kilnandclay.com` (seller) · `hello@trove.com` (house label).

> Without Stripe keys everything works except taking a real payment — the checkout
> button will report that Stripe isn't configured. Add test keys (below) to take
> test payments.

### Stripe test payments locally

```bash
# in backend/.env add:  STRIPE_SECRET_KEY=sk_test_...
# and in docs/config.js set: STRIPE_PUBLISHABLE_KEY: "pk_test_..."
stripe login
stripe listen --forward-to localhost:4242/api/stripe/webhook
# paste the printed whsec_... into STRIPE_WEBHOOK_SECRET in .env, then restart
```
Use Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.

---

## Go live — step by step

You'll do these once. Anything that needs a password or a card is yours to do; the
code is ready for all of it.

### 1 · Get your Stripe keys
1. Create/sign in to Stripe → **stripe.com**.
2. **Developers → API keys**. You'll use the **test** keys first (they start
   `pk_test_` and `sk_test_`), then switch to **live** keys when you're happy.
3. Keep this tab open — you'll copy two keys shortly.

### 2 · Put the code on GitHub
> Run these yourself so your GitHub login stays with you. The repo is ready to push.
```bash
cd trove
gh repo create trove --private --source=. --remote=origin --push   # needs `gh auth login` first
# — or — create an empty repo named "trove" on github.com, then:
git remote add origin https://github.com/<your-username>/trove.git
git branch -M main && git push -u origin main
```

### 3 · Deploy on Render (one web service)
1. Go to **render.com** → **New + → Web Service** → connect your `trove` repo.
2. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Starter (recommended) so you can attach a disk; Free works
     but sleeps when idle and **wipes data on each redeploy**.
3. **Advanced → Add Disk** (for data that survives redeploys):
   - **Mount Path:** `/var/data` · **Size:** 1 GB
4. **Environment variables** (Add from the Environment tab):
   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | a long random string |
   | `STRIPE_SECRET_KEY` | your `sk_test_…` (later `sk_live_…`) |
   | `STRIPE_WEBHOOK_SECRET` | set in step 5 |
   | `CLIENT_URL` | your Render URL, e.g. `https://trove.onrender.com` |
   | `DB_PATH` | `/var/data/trove.db` (only if you added the disk) |
   | `PLATFORM_FEE_PERCENT` | `8` |
   | `CURRENCY` | `aed` |
5. Click **Create Web Service**. When it's live you'll have a URL like
   `https://trove.onrender.com`.

### 4 · Add your publishable key to the site
1. Edit `docs/config.js` → set `STRIPE_PUBLISHABLE_KEY: "pk_test_…"` (later `pk_live_…`).
2. Leave `API_URL: ""` (the backend serves the site, so same address).
3. Commit & push — Render redeploys automatically.

### 5 · Turn on payouts (Stripe webhook)
1. Stripe **Developers → Webhooks → Add endpoint**.
2. **Endpoint URL:** `https://trove.onrender.com/api/stripe/webhook`
3. **Events:** `payment_intent.succeeded` and `account.updated`.
4. Reveal the **Signing secret** (`whsec_…`) → paste into Render's
   `STRIPE_WEBHOOK_SECRET` env var → save (Render redeploys).

### 6 · First data
- To load the demo shops/products: Render → your service → **Shell** → `npm run seed`.
- For a real launch, skip the seed and create your own shops by registering sellers
  and adding products in the seller dashboard. (Running `seed` erases existing data.)

### 7 · Test, then switch to live
- Visit your URL, sign up, add to cart, and pay with the test card
  `4242 4242 4242 4242`. As a seller, connect Stripe from **Payments**.
- When you're ready for real money: swap the **test** keys for **live** keys in
  Render (`STRIPE_SECRET_KEY`) and `docs/config.js` (`STRIPE_PUBLISHABLE_KEY`),
  add a **live** webhook (step 5 with live keys), and complete Stripe's account
  activation.

### 8 · (Optional) Your own domain
Render → your service → **Settings → Custom Domains** → add your domain and follow
the DNS instructions at your registrar. Then update `CLIENT_URL` to the new domain.

---

## Good to know

- **Money flow.** One PaymentIntent is charged on checkout; when Stripe confirms it,
  the webhook pays each shop their share via a Stripe Transfer, keeping your 8% fee.
  See `backend/README.md` for the full detail and API reference.
- **Prices are server-trusted.** The backend recomputes every price from the
  database at checkout — the browser can't change what it's charged.
- **Still local-only (no backend yet):** saved/wishlist items, “following” shops,
  saved cards (cards are entered securely with Stripe at checkout), the seller
  sales chart, and marking orders fulfilled. These are clearly labelled in the UI
  and are the natural next features to build.
- **Data persistence.** SQLite lives in one file. On a host without a persistent
  disk it resets on each redeploy — attach a disk (step 3) or move to Postgres
  later (the schema ports directly).

---

## License
MIT — see [LICENSE](LICENSE).
