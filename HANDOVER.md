# Trove — handover

Last updated 15 October 2026 (laptop session, afternoon). The detailed engineering notes live in `CLAUDE.md`; this file is the plain-English version. Start every session with `git pull`.

## What is live

- **troveathome.com** runs on Render (service `srv-d931flsm0tmc73b0qem0`). Stripe takes real money. The courier is OTO.
- **Test shop, piece and services removed (15 Oct, 08:00 UTC).** Kiln & Clay, its mug and Noor Letters are gone; a backup was saved first (`/var/data/backups/trove-20261015-0800.db`). The site now shows only the Trove Collection (coming soon), and Shop all says the first pieces are on their way. For a future clean-up: The clean-up script now always keeps your admin account and the Trove Collection, and handles everything added since September. When the shop is empty, the homepage hides its empty shelves and the Makers section, and Shop all says the first pieces are on their way, with a Sell on Trove button. To run it:
  1. Render dashboard → service **trove** → **Shell**.
  2. Paste `cd /opt/render/project/src/backend && node scripts/purge-demo.js` and press Enter. This only lists what would go. Paste the list to Claude to check.
  3. Then paste `node scripts/purge-demo.js --yes` and press Enter. It saves a backup first, then removes everything listed.
  4. Sign in to /admin again (everyone is signed out), with the email code.
- **hello@troveathome.com now receives email (new, 15 Oct, afternoon).** troveathome.com was added to the Serein Consultancy LLC Google Workspace as a second domain. hello@troveathome.com is an extra address on ilhami@sereinstudio.uk, so its mail lands in that Gmail inbox. It costs nothing, because no new licence was needed. A test email arrived on 15 Oct. Google DKIM signing is switched on for the domain. **hello@ is now the company address everywhere (`9f32fd3`):** contact-form messages go to hello@ (your Gmail only if the company email in Admin → Site content is ever blanked), the Trove Collection's courier contact is hello@, and every order email still comes from noreply@ but its footer now says 'Questions? Write to us at hello@troveathome.com' (English and Arabic). The site's pages already showed hello@. Your admin sign-in and owner alerts stay on your Gmail.
- **Trove's own cookie banner (new, 15 Oct, later).** The cookie banner is now drawn by Trove itself in the brand look (cream card, charcoal buttons, Cormorant title), in English and Arabic, the same way Josephine's works. iubenda still runs behind it, out of sight: it keeps the legal record of every choice and tells Google what was agreed. Visitors choose Accept, Reject (the same size and colour as Accept), or Choose, which lets them switch measurement on or off. 'Cookie settings' at the foot of every page reopens it. It only asks about measurement (Google Analytics and the anonymous visitor count for makers), which is what the Privacy Policy says. Advertising stays off whatever anyone chooses. The code is in `docs/consent.js` and `backend/src/gtm.js`.
- **Identity checks through Didit (new, 15 Oct).** A maker without a verified trade licence now proves who they are on the Payouts tab: they tick a consent box, scan their Emirates ID and take a selfie on Didit's secure page, and come straight back. If Didit approves it, and it is a UAE Emirates ID that is in date, Trove counts the maker as verified and pays them in the next settlement run. No admin tick is needed.
- Trove keeps only the result: the name on the ID, its last four digits, its issue and expiry dates, and whether it passed. It never stores the photos, the selfie, the full ID number or the date of birth.
- Sending ID photos for the admin to check still works as a fallback.
- **Privacy Policy v3** (English and Arabic) names Didit and explains this.

## Where things are set up

- **Didit console:** business.didit.me, organisation "Trove At Home", application "My Application" (Live).
  - Workflow "Trove maker identity (Emirates ID + selfie)": UAE ID card only, liveness, face match, under-18s declined.
  - API key "Trove production (troveathome.com)": can create sessions and read decisions for that one workflow, nothing else.
  - Webhook "Trove production" sends status changes to troveathome.com. A signed test was delivered successfully on 15 Oct.
- **Email for troveathome.com (GoDaddy DNS):** MX `@` → smtp.google.com (priority 1); TXT `@` SPF `v=spf1 include:_spf.google.com ~all`; TXT `google._domainkey` (Google DKIM, 2048-bit); two `google-site-verification` TXT records on `@` (one for Search Console, one for Workspace — never delete either). Resend's sending records (`send` MX/TXT, `resend._domainkey`) and `_dmarc` are unchanged. The site still sends its own emails through Resend from noreply@troveathome.com. **Your rule (15 Oct): noreply@ is for order emails, hello@ is for the company.** Order emails stay no-reply.
- **Render settings:** `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` and `DIDIT_WEBHOOK_SECRET`. Deleting `DIDIT_API_KEY` switches Didit off and makers go back to sending photos.

## How to handle things

- **A check "In Review":** Didit could not decide alone. It shows in Admin → Needs you. Open the Didit console, find it under Verifications, and approve or decline it. Trove updates by itself within a minute (or within the hour at the latest).
- **Withdrawing a verification:** Admin → Shops → Undo ID check. The maker then has to verify again before the next payment.
- **Didit out of credits:** makers see "not available right now, send photos instead" and you get one email a day. Top up at business.didit.me.

## Open items for the owner

1. **Didit billing changes on 1 November 2026.** The 500 free checks a month become $10 of credit a month, about 30 checks. The balance is $0. Decide whether to add credit.
2. **Seller Agreement v5 still describes only the photo route.** A v6 naming Didit would make it match, but every maker would be asked to accept it again. Your call; it could go with the lawyer review.
3. **Run one real check.** Nobody has done a full check with a real Emirates ID yet. A maker account (not the admin) is needed, since the Trove Collection never needs one.
4. Didit's decline reasons (for example "Document is a screen capture") show in English on Arabic pages.
5. **Optional — Stripe support email:** Stripe has no public support email set. To show hello@ on Stripe receipts: Stripe dashboard → Settings → Business → Public details → Support email → hello@troveathome.com → Save.
6. **Sending as hello@ from Gmail:** in Gmail (ilhami@sereinstudio.uk) → Settings → See all settings → Accounts → Send mail as → Add another email address → hello@troveathome.com. No code is needed, because it is your own alias.
7. Older open items are unchanged: iubenda dashboard TCF switch (the iubenda panel no longer shows, so this is now housekeeping only), `BACKUP_ENC_KEY` and `PAYOUT_ENC_KEY` into your password manager, delete `SEED_DEMO` on Render, lawyer review, SMS provider, uptime monitor.

## Memory text to re-record on the other machine

> Trove: own cookie banner LIVE 15 Oct 2026 — docs/consent.js (EN+AR) over iubenda (record only, banner parked; callbacks + purposes '1,4' in src/gtm.js IUB_SETTINGS/IUB_CALLBACKS; ads always denied; footer Cookie settings opens our Choose step).
>
> Trove: Didit identity checks LIVE 15 Oct 2026 (src/didit.js, migration 028, Privacy v3). Didit org "Trove At Home"; workflow ff425389-a734-4560-91fd-dd80bc331730; key "Trove production" (sessions write, decisions read, that workflow only); webhook → troveathome.com/api/identity/didit/webhook. Render env DIDIT_API_KEY / DIDIT_WORKFLOW_ID / DIDIT_WEBHOOK_SECRET. Decisions are always re-read from Didit's API. Open: credits from 1 Nov, Seller Agreement v6 decision, first real end-to-end check.
