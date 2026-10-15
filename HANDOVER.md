# Trove — handover

Last updated 15 October 2026 (laptop session). The detailed engineering notes live in `CLAUDE.md`; this file is the plain-English version. Start every session with `git pull`.

## What is live

- **troveathome.com** runs on Render (service `srv-d931flsm0tmc73b0qem0`). Stripe takes real money. The courier is OTO.
- **Identity checks through Didit (new, 15 Oct).** A maker without a verified trade licence now proves who they are on the Payouts tab: they tick a consent box, scan their Emirates ID and take a selfie on Didit's secure page, and come straight back. If Didit approves it, and it is a UAE Emirates ID that is in date, Trove counts the maker as verified and pays them in the next settlement run. No admin tick is needed.
- Trove keeps only the result: the name on the ID, its last four digits, its issue and expiry dates, and whether it passed. It never stores the photos, the selfie, the full ID number or the date of birth.
- Sending ID photos for the admin to check still works as a fallback.
- **Privacy Policy v3** (English and Arabic) names Didit and explains this.

## Where things are set up

- **Didit console:** business.didit.me, organisation "Trove At Home", application "My Application" (Live).
  - Workflow "Trove maker identity (Emirates ID + selfie)": UAE ID card only, liveness, face match, under-18s declined.
  - API key "Trove production (troveathome.com)": can create sessions and read decisions for that one workflow, nothing else.
  - Webhook "Trove production" sends status changes to troveathome.com. A signed test was delivered successfully on 15 Oct.
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
5. Older open items are unchanged: iubenda dashboard TCF switch, `BACKUP_ENC_KEY` and `PAYOUT_ENC_KEY` into your password manager, delete `SEED_DEMO` on Render, lawyer review, hello@ inbox, SMS provider, uptime monitor.

## Memory text to re-record on the other machine

> Trove: Didit identity checks LIVE 15 Oct 2026 (src/didit.js, migration 028, Privacy v3). Didit org "Trove At Home"; workflow ff425389-a734-4560-91fd-dd80bc331730; key "Trove production" (sessions write, decisions read, that workflow only); webhook → troveathome.com/api/identity/didit/webhook. Render env DIDIT_API_KEY / DIDIT_WORKFLOW_ID / DIDIT_WEBHOOK_SECRET. Decisions are always re-read from Didit's API. Open: credits from 1 Nov, Seller Agreement v6 decision, first real end-to-end check.
