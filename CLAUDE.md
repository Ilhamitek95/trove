# Trove (trove-vu4z.onrender.com)

Curated multi-vendor marketplace, Dubai + Abu Dhabi only, currency AED (stored as integer **fils**). Owner is non-technical: do all code work yourself, give click-by-click steps for dashboards, never paste secrets into chat. Separate project from Daily Comps.

## Business model (locked — don't drift)

- Consignment "Rail A": Trove is merchant of record; commission **20%**, buyer service fee AED 9, delivery AED 25 (FREE over AED 500). Weekly Tuesday settlement runs; bank CSV export is the ONLY place IBANs decrypt.
- Rail B (Stripe Connect graduation) exists behind `RAIL_B_ENABLED=0` — off by default.
- Service area is Dubai + Abu Dhabi only, enforced server-side (`backend/src/service-area.js`).
- Prod is still demo-payments mode (no Stripe key) — checkout stops at the payment gate; that's the remaining go-live step, plus a compliance check before real money.

## Safety rules (never break)

- **Never push or deploy without the user explicitly saying so.**
- **`PAYOUT_ENC_KEY` (Render env) is irreplaceable** — if lost, all stored seller IBANs are unrecoverable. Never rotate or "clean up" this var.
- Copy guardrails are CI-enforced (`backend/test/copy-guardrails.test.js`): no carbon-neutral/greenwashing claims, no money-transmission phrases. Never fabricate reviews, ratings, or stats — live mode only shows real data.
- Prod DB never reseeds once users exist; `npm run seed` is for local dev only.
- The user's email is the ONLY admin on prod (bootstrapped from `ADMIN_EMAIL` env). Demo accounts on prod are re-passworded every boot from `DEMO_PASSWORD` env (local dev stays `demo1234`).

## Deploy & hosting

- Render web service `trove`, id `srv-d931flsm0tmc73b0qem0`, Blueprint from `render.yaml`, persistent disk at `/var/data` (SQLite DB + uploads + private docs live there).
- Auto-deploy on push to `main` **misses frequently** — don't wait: right after pushing, trigger a manual deploy via `POST https://api.render.com/v1/services/srv-d931flsm0tmc73b0qem0/deploys` with the `RENDER_API_KEY` user env var. Health check: `/api/health`.

## Dev gotchas

- Tests: `cd backend && npm test` (node:test suite, ~114 tests) — run before any push. Unset `ANTHROPIC_API_KEY` first (the user env var leaks in and breaks tags.test.js).
- Run locally: `cd backend && npm install && npm run seed && npm run dev` → http://localhost:4242 (Express also serves `docs/` statically — single origin).
- **Never round-trip repo files through PowerShell `Get-Content`/`Set-Content`** — it mojibakes UTF-8 (corrupted a route file once). Use the Edit/Write tools.
- Git commit messages containing double-quotes fail under PowerShell 5.1 quoting — avoid `"` in messages.
- Frontend is 4 self-contained HTML pages in `docs/` (trove.html storefront, trove-login, trove-account, trove-seller, plus trove-admin, trove-apply); shared client is `docs/api.js`. After editing inline JS, syntax-check with `node --check` via a temp extract.
- Product imagery is deterministic inline-SVG brand-motif tiles (`img()`/`prodImg()` per page — data URIs, no network) until real photography lands; see `docs/PHOTOGRAPHY-MANIFEST.md`. Layering rule: a positioned `.grad` div must never cover the image — give the `img` `position:absolute;inset:0;z-index:1`.
- Brand review (2026-07): Dream Avenue is the display face (`@font-face` per page, files pending in `docs/fonts/` — falls back to Georgia); official wordmark pending in `docs/img/` (typed-text fallback via `onerror`). NO italics anywhere; `*word*` CMS token renders an Orange accent. Never pair Charcoal with Orange (buttons are charcoal/cream); `#A85138`/`#7E6F67`/`#5E7E63` are banned. Categories = two-pillar taxonomy in `backend/src/categories.js` (house vs marketplace lists). UK English in all visible copy; "Trove" always capitalised in sentences (the lowercase wordmark is artwork).
- Browser QA gotcha: native `confirm()`/`prompt()` dialogs freeze automation — override (`window.confirm=()=>true`) before clicking buttons that trigger them.
- AI tag-writer (`backend/src/ai.js`, claude-haiku-4-5 via `AI_TAGS_MODEL`) needs `ANTHROPIC_API_KEY` (set on Render); endpoints 503 without it and the UI hides the button — degrade, don't error.
