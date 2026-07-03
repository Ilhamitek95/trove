# trove

A curated multi-vendor marketplace — independent shops plus an own house label
(*trove label*). Shoppers buy from Trove; Trove **purchases each sold piece
from its supplier** (list price minus a 20% margin) and settles with suppliers
weekly by bank transfer once the buyer's return window closes. See
[Payment architecture: two rails](#payment-architecture-two-rails).

```
trove/
├── docs/        The storefront, account, login and seller pages + api.js + config.js
└── backend/     Node + Express + SQLite API with Stripe Connect — also serves docs/
```

**This is now a working app, not just a prototype.** The pages talk to the
backend for real: sign-up / sign-in, a real product database, a cart that checks
out through Stripe, buyer orders & addresses, and a seller dashboard with product
management, delivery tracking and weekly supplier settlements.

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
   | `PRIVATE_DIR` | `/var/data/private` (purchase notes + license images) |
   | `PAYOUT_ENC_KEY` | 64 hex chars — encrypts supplier IBANs (see `.env.example`) |
   | `COMMISSION_PERCENT` | `20` |
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

## Payment architecture: two rails

Trove deliberately runs on a **purchase-and-resale** model, never as a payment
processor for its sellers.

**Rail A — Consignment (the default, and the only rail at launch).** Trove is
the merchant of record. Buyers pay Trove's own Stripe account (a standard
PaymentIntent — no Connect). At the moment a payment succeeds, **Trove
purchases the sold goods from the supplier** at list price minus
`COMMISSION_PERCENT` (20%): title transfers, and the purchase price is
credited to the supplier's ledger. Suppliers onboard with an Emirates ID
last-4, an IBAN in their own name (encrypted at rest) and the Seller
Agreement — no trade license, no Stripe account.

**Rail B — Connect (feature-flagged: `RAIL_B_ENABLED`, default off).**
Suppliers whose trailing-30-day *paid* settlements reach
`GRADUATION_THRESHOLD_AED` (AED 12,000) are invited — not forced — to obtain a
UAE e-Trader license. After an admin verifies the license, Trove creates a
Stripe Connect **Custom** account for them (UAE platforms cannot use
Express/Standard accounts or `on_behalf_of`), and once Stripe enables payouts
their orders route as **destination charges**: the charge lands on the
supplier's account and Trove keeps `application_fee_amount` = margin + buyer
fees. Connect orders bypass the consignment ledger entirely. Sellers who
already hold a license can declare it at application time; they sell on
consignment and sit in the graduation queue until the flag turns on.

**The settlement eligibility rule** (one query in `backend/src/settlement.js`,
everything derives from it): *a supplier credit is payable when its parcel is
delivered, its 7-day return window closed before the run start, the order was
never refunded, and the supplier completed payout setup.*

```
sale (payment succeeds)
  └─ credit_sale on the ledger ..... "pending" while the parcel is undelivered
                                      or inside the 7-day return window
       └─ eligible ................. window closed, order not refunded
            └─ Tuesday run ......... settlement DRAFT (one bank line per supplier,
                                      reference "Purchase of handmade goods — PO #n")
                 └─ exported ....... bank CSV (the only place an IBAN is decrypted)
                      └─ paid ...... negative payout row + self-billed purchase note

refund (any time) ─ debit_refund only if the credit was already in a settlement;
                    it nets against the supplier's NEXT run — negative balances
                    carry forward, never clawed back mid-cycle. An unsettled
                    credit simply becomes permanently ineligible.
```

Known deviations & properties, on purpose:

- **Mixed carts** (a connect-tier shop plus others) stay on the platform
  charge; the connect shop's share moves by Transfer in the webhook. A
  destination charge is only used when the whole order belongs to one
  fully-onboarded connect shop.
- **The cap lags real sales** by up to ~2 weeks (return window + weekly
  cadence) because it counts *paid settlements* — that is the point: it
  measures money actually moved.
- **Cancelling a shipment outside the refund flow** strands its credit as
  never-eligible; the admin refund is the sanctioned path.
- **Prohibited goods:** nothing ingestible or applied to skin can be listed
  (server-enforced 422) — a reseller of record must not carry that liability.
- A CI test (`backend/test/copy-guardrails.test.js`) fails the build if any
  copy drifts back into collecting-money-for-sellers language.

Env vars: `COMMISSION_PERCENT` (20) · `PAYOUT_ENC_KEY` (64 hex, required for
payout setup + CSV export) · `PRIVATE_DIR` · `RAIL_B_ENABLED` (0) ·
`VAT_REGISTERED` (0) · `GRADUATION_THRESHOLD_AED` (12000) · `QUIQUP_API_KEY` /
`QUIQUP_API_URL` / `QUIQUP_WEBHOOK_SECRET` (courier — the built-in mock runs
until these are set) · `CRON_DISABLED`.

Run the test suite with `cd backend && npm test`.

---

## Good to know

- **Money flow.** One PaymentIntent is charged on Trove's own Stripe account at
  checkout; when Stripe confirms it, Trove has purchased the goods from its
  suppliers (title transfers) and their purchase price accrues on the supplier
  ledger for the weekly settlement run. See
  [Payment architecture: two rails](#payment-architecture-two-rails) and
  `backend/README.md` for the full detail and API reference.
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
