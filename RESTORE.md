# Backups and how to restore them

Trove keeps three layers of copies:

1. **Render disk snapshots**: Render's own daily snapshot of the whole disk (`/var/data`: database, photos, private documents). Check they are on: Render → service **trove** → **Disks** → the disk → **Snapshots**. You should see one per day.
2. **Nightly copies on the server**: every night at 03:30 Dubai time the database is copied to `/var/data/backups/trove-YYYYMMDD-HHMM.db` (UTC time in the name). The newest 7 are kept. These copies help after a mistake, but they sit on the same disk as the live data.
3. **Encrypted off-site copies** (needs a one-off setup, see below): the same night, an encrypted copy of the database goes to cloud storage (Cloudflare R2 or any S3-compatible store), and the photos and private documents are mirrored there. The newest 14 database copies are kept. Files deleted on the server, such as an erased ID document, are deleted off-site the same night.

If a night's backup fails, the owner (`ADMIN_EMAIL`) gets an email that morning. Every Monday a short "Trove backups OK" email confirms the week. If off-site copies are not set up yet, that email says so.

---

## One-off setup: off-site copies (about 15 minutes)

### A. Create the storage (Cloudflare R2, free up to 10 GB)

1. Sign in at **dash.cloudflare.com** (a free account is fine).
2. In the left menu, click **R2 Object Storage**. If asked, turn R2 on (it asks for a card, but the first 10 GB are free).
3. Click **Create bucket**, name it `trove-backups`, leave the location on **Automatic**, then click **Create bucket**.
4. Go back to **R2 Object Storage** and click **Manage API tokens** (top right, sometimes under **{ } API**). Click **Create API token**.
5. Name the token `trove-backups`. Under **Permissions** choose **Object Read & Write**. Under **Specify bucket(s)** choose **Apply to specific buckets only** → `trove-backups`. Click **Create API Token**.
6. The next page shows three values. Copy them now, because the secret is shown only once:
   - **Access Key ID**
   - **Secret Access Key**
   - **Endpoint for S3 clients** (like `https://<long id>.r2.cloudflarestorage.com`). Use the address without `/trove-backups` at the end.

### B. Make the encryption key

1. Render → service **trove** → **Shell**.
2. Paste this and press Enter:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Copy the 64-character line it prints. **Save it in your password manager as "Trove backup key"**. Without it the off-site copies cannot be opened, and Render is not a safe place to keep the only copy.

### C. Give both to Trove

Render → service **trove** → **Environment** → **Add Environment Variable**, once for each line:

| Key | Value |
|---|---|
| `BACKUP_S3_ENDPOINT` | the endpoint from A6 |
| `BACKUP_S3_BUCKET` | `trove-backups` |
| `BACKUP_S3_KEY_ID` | the Access Key ID |
| `BACKUP_S3_SECRET` | the Secret Access Key |
| `BACKUP_ENC_KEY` | the 64-character key from B3 |

Click **Save Changes**. Render redeploys by itself.

Check it worked: the next morning, Cloudflare → R2 → `trove-backups` should show a `trove/` folder with `db/` and `files/`. The Monday email will say "Trove backups OK". To test straight away, open the Render Shell and run `npm run restore-backup -- --list`, which lists what is on the server and off-site.

Other S3-compatible stores (AWS S3, Backblaze B2) work the same way. Also set `BACKUP_S3_REGION` to the bucket's region (R2 uses the default, `auto`).

**Also keep `PAYOUT_ENC_KEY` in your password manager.** The database stores bank details and ID photos encrypted with it, so a restored copy needs the same key.

---

## Restoring the database

Use this when orders or accounts were damaged or deleted by mistake. Everything runs in **Render → service trove → Shell**, which opens in the right folder.

1. **See what is there:**
   `npm run restore-backup -- --list`
   Copies are named by date and time in UTC. Dubai is UTC + 4, so `trove-20261012-2330.db` was made at 03:30 on 13 Oct in Dubai.
2. **Check a copy (changes nothing):**
   - newest copy on the server: `npm run restore-backup -- --db=latest`
   - newest off-site copy: `npm run restore-backup -- --db=latest --remote`
   - a particular one: `npm run restore-backup -- --db=trove-20261012-2330.db` (add `--remote` for off-site)

   It prints whether the copy passes SQLite's integrity check and how many accounts, shops, pieces and orders it holds, plus the date of its newest order. Pick the newest copy from **before** the problem.
3. **Restore it:** run the same command again with `--yes` added at the end. It first saves the current database as `backups/trove-before-restore-….db`, so the restore itself can be undone, and then writes the copy into the live database.
4. **Restart:** Render → service **trove** → **Manual Deploy** → **Restart service**.
5. Open the site and the admin panel and check the orders you expect are there.

Anything that happened after the copy was made, such as new orders or sign-ups, is not in it. Look in Stripe for payments made since then. Stripe keeps its own record of every payment.

## Restoring photos and documents

If the photos or private documents are lost (for example on a new disk):

1. `npm run restore-backup -- --files` lists how many files are missing on the server.
2. `npm run restore-backup -- --files --yes` downloads and decrypts them back into place.

## If the whole disk or service is lost

1. First try Render's own disk snapshot: Render → service → **Disks** → **Snapshots** → **Restore**. This brings back everything at once.
2. If that is not possible, create the service again from `render.yaml`, set the same environment variables (including `PAYOUT_ENC_KEY` and the five `BACKUP_*` values from your password manager), then in the Shell run:
   - `npm run restore-backup -- --db=latest --remote --yes`
   - `npm run restore-backup -- --files --yes`
   - **Manual Deploy → Restart service**

## Practise once

Do one test restore when things are calm, so the steps are familiar:

1. Run `--list` and then `--db=latest --remote`, without `--yes`. This proves the off-site copy can be downloaded and decrypted, and changes nothing.
2. Optionally, run the same steps on a copy of the service, never on the live one.
