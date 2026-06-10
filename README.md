# trove

A curated multi-vendor marketplace — independent shops plus an own house label
(*trove label*). This repo holds both halves:

```
trove/
├── docs/        Static storefront + account + seller dashboard + login (GitHub Pages serves this)
│   ├── index.html          → redirects to trove.html
│   ├── trove.html          Storefront homepage (the hub)
│   ├── trove-login.html    Two-path sign in (shopper / seller)
│   ├── trove-account.html  Consumer "My Account"
│   └── trove-seller.html   Seller dashboard
└── backend/     Node + Express + SQLite API with Stripe Connect payouts
    ├── src/
    └── package.json
```

The `docs/` site is an interactive prototype (data lives in the browser). The
`backend/` is a working API that turns it into a real app: accounts, a products /
orders database, and Stripe Connect that splits one customer payment across the
shops in a cart, minus the platform fee.

---

## Run locally

**Frontend** — any static server from `docs/`:
```bash
cd docs && npx serve -l 3000      # http://localhost:3000
```

**Backend** — see `backend/README.md` for full detail:
```bash
cd backend
cp .env.example .env              # add your Stripe test key
npm install
npm run seed
npm run dev                       # http://localhost:4242
```

---

## Put it on GitHub

> Your GitHub credentials stay with you — run these yourself. The repo is already
> committed and ready to push.

**Option A — GitHub CLI** (`gh auth login` first):
```bash
cd trove
gh repo create trove --public --source=. --remote=origin --push
```

**Option B — manual.** Create an empty repo named `trove` on github.com (no README),
then:
```bash
cd trove
git remote add origin https://github.com/<your-username>/trove.git
git branch -M main
git push -u origin main
```

---

## Publish live

### Storefront → GitHub Pages (free, instant)
1. Push the repo (above).
2. On GitHub: **Settings → Pages**.
3. **Source:** *Deploy from a branch* → **Branch:** `main` → **Folder:** `/docs` → Save.
4. After a minute it's live at `https://<your-username>.github.io/trove/`
   (the index redirects to the storefront).

That publishes the full clickable prototype. It runs entirely in the browser, so
it works on Pages with no server.

### API → a Node host (Pages can't run servers)
The backend needs a Node host such as **Render**, **Railway**, or **Fly.io**.
On Render, for example: New → Web Service → point at this repo →
**Root directory** `backend`, **Build** `npm install`, **Start** `npm start`.
Add the environment variables from `.env.example` (Stripe keys, `SESSION_SECRET`,
and `CLIENT_URL` = your Pages URL).

> SQLite lives in a single file, which is wiped on each redeploy on ephemeral
> hosts. For anything real, attach a persistent disk or switch to Postgres
> (the schema ports directly). See `backend/README.md`.

### Connect the two
Once the API is hosted, set its public URL as the API base in the frontend and
add Stripe.js for card confirmation. The frontend wiring snippets are in
`backend/README.md` under *Wiring the existing front-end*.

---

## License
MIT — see [LICENSE](LICENSE).
