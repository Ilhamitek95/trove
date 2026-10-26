'use strict';
require('dotenv').config();
// Boot-time checks (F209): production refuses to start without the session
// secret — before the database is even opened.
{
  const problems = require('./security').productionProblems();
  if (problems.length) {
    for (const p of problems) console.error(`FATAL: ${p}`);
    process.exit(1);
  }
}
// Production refuses to start without its Stripe keys: a live server must
// never take orders without payment (F211, src/stripe.js).
require('./stripe').assertPaymentsConfigured();
const db = require('./db');
// When each scheduled job last worked; a failure emails the owner once a day
// and shows on the admin Overview (src/job-runs.js).
const jobs = require('./job-runs');
// A promise nobody caught must not vanish into the log unseen.
process.on('unhandledRejection', (reason) => jobs.fail('unhandled', reason instanceof Error ? reason : new Error(String(reason))));

// First-boot demo seed (development only): SEED_DEMO=1 populates an EMPTY
// database with the demo catalogue. Never on production — an empty or
// replaced disk on the live, real-money site must stay empty rather than
// fill with demo shops whose logins are well known (F141).
if (process.env.SEED_DEMO === '1' && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  if (process.env.NODE_ENV === 'production') console.warn('SEED_DEMO is ignored in production — remove it from the environment.');
  else require('./seed');
}

// Super admin bootstrap: ADMIN_EMAIL (+ ADMIN_PASSWORD for first creation)
// guarantees the platform owner's account exists with the admin role. If the
// account already exists it is promoted, never re-passworded — change the
// password by changing it in the app, not the env. Only an account whose
// email has been CONFIRMED is promoted (F206): anyone can sign up with any
// address, so an unconfirmed account that happens to use ADMIN_EMAIL (say,
// after the owner changed it to an address with no Trove account yet) must
// not become the platform admin on the next restart.
if (process.env.ADMIN_EMAIL) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (existing) {
    if (existing.role !== 'admin' && existing.email_verified_at) {
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(existing.id);
      console.log(`admin bootstrap: promoted ${email} to admin`);
    } else if (existing.role !== 'admin') {
      console.warn('admin bootstrap: the ADMIN_EMAIL account has not confirmed its email, so it was NOT made admin — confirm it from the welcome email (or a password reset), then restart');
    }
  } else if (process.env.ADMIN_PASSWORD) {
    const { hashPassword } = require('./middleware');
    // Created by the server from the owner's own env value, so the address
    // is the owner's by definition (the emailed admin sign-in code goes there).
    db.prepare("INSERT INTO users (email, password_hash, name, role, email_verified_at) VALUES (?,?,?, 'admin', datetime('now'))")
      .run(email, hashPassword(process.env.ADMIN_PASSWORD), process.env.ADMIN_NAME || 'Trove Admin');
    console.log(`admin bootstrap: created admin account ${email}`);
  } else {
    console.warn('admin bootstrap: ADMIN_EMAIL set but account missing and no ADMIN_PASSWORD to create it');
  }
}

// Demo service providers: the Services Marketplace's counterpart to the demo
// shops. Idempotent (keyed on slug), so it only ever fills in what is missing
// — see src/demo-providers.js. Opt-in via DEMO_PROVIDERS=1 (the local seed
// creates them anyway): the live site was cleared of its demo data on
// 2026-09-22 (scripts/purge-demo.js) and must not grow them back at boot.
// Runs before the lockdown below so new accounts get the DEMO_PASSWORD
// rotation on the same boot.
if (process.env.DEMO_PROVIDERS === '1') {
  const created = require('./demo-providers').ensureDemoProviders(db);
  if (created) console.log(`demo providers: created ${created}`);
}

// Demo-account lockdown: on a public deployment set DEMO_PASSWORD to replace
// the seeded accounts' well-known "demo1234" password (re-applied every boot,
// so changing the env changes the password). The house account also loses its
// admin role — on a live site the only admin should be the ADMIN_EMAIL owner.
// Real customer accounts are never touched. Leave unset in local dev.
if (process.env.DEMO_PASSWORD) {
  const { hashPassword } = require('./middleware');
  const { DEMO_EMAILS } = require('./seed-guard');
  const hash = hashPassword(process.env.DEMO_PASSWORD);
  const rotate = db.prepare('UPDATE users SET password_hash=? WHERE email=?');
  let rotated = 0;
  for (const email of DEMO_EMAILS) rotated += rotate.run(hash, email).changes;
  let demoted = 0;
  if ((process.env.ADMIN_EMAIL || '').trim().toLowerCase() !== 'hello@trove.com') {
    demoted = db.prepare("UPDATE users SET role='seller' WHERE email='hello@trove.com' AND role='admin'").run().changes;
  }
  if (rotated) console.log(`demo lockdown: rotated ${rotated} demo password(s)${demoted ? ', house account demoted to seller' : ''}`);
}

// Bank-detail encryption sweep: once PAYOUT_ENC_KEY is set, any IBAN still
// stored in plaintext (pre-encryption rows, or a seed run without the key) is
// encrypted and masked, and the plaintext column cleared. Runs every boot and
// is a no-op once everything is swept. NOT a run-once migration on purpose —
// a keyless boot must not mark it done.
{
  const pcrypto = require('./crypto');
  if (pcrypto.hasKey()) {
    const rows = db.prepare("SELECT id, payout_iban FROM shops WHERE payout_iban != '' AND iban_encrypted IS NULL").all();
    const sweep = db.prepare("UPDATE shops SET iban_encrypted=?, iban_masked=?, payout_iban='' WHERE id=?");
    for (const r of rows) sweep.run(pcrypto.encrypt(r.payout_iban), pcrypto.maskIban(r.payout_iban), r.id);
    if (rows.length) console.log(`payout crypto: encrypted ${rows.length} stored IBAN(s)`);
  } else if (db.prepare("SELECT 1 FROM shops WHERE payout_iban != '' LIMIT 1").get()) {
    console.warn('payout crypto: PAYOUT_ENC_KEY not set — supplier IBANs remain in plaintext until it is');
  }
}

// One-time QA cleanup (2026-09-30): removes ONLY the test accounts, shop,
// provider and unpaid orders that review agents created on the live site
// (ilhamitek95+trove-qa-*@gmail.com). Runs once — guarded by the
// 'qa-cleanup-2026-09-30-r2' marker (bumped per QA pass) in schema_migrations — backs up first, skips
// and reports anything where money moved, and never crashes the boot. The
// summary is at GET /api/admin/maintenance/qa-cleanup. See src/qa-cleanup.js.
require('./qa-cleanup').bootOnce(db, { stripe: require('./stripe').getStripe() });

// The Trove Collection, the owner's own shop (2026-09-30): re-created once
// when no house shop exists, owned by the ADMIN_EMAIL account (after the
// admin bootstrap above). Guarded by the 'house-shop-2026-09-30' marker; a
// skip (no admin account yet) is logged and retried next boot. See
// src/house-shop.js.
require('./house-shop').bootOnce(db);

const { createApp } = require('./app');
const { getStripe } = require('./stripe');

const app = createApp();
const PORT = process.env.PORT || 4242;

// Search-trend hygiene: the log is a rolling 90-day signal, trimmed each boot.
try {
  const purged = require('./trends').purgeOld();
  if (purged) console.log(`search log: purged ${purged} entr${purged === 1 ? 'y' : 'ies'} older than 90 days`);
} catch (e) { console.error('search log purge failed:', e.message); }

// Analytics hygiene: visitor ids are scrubbed at 90 days (the counts stay, the
// identifiers go) and events themselves are dropped at a year.
try {
  const { scrubbed, removed } = require('./analytics').hygiene();
  if (scrubbed || removed) console.log(`analytics: scrubbed ${scrubbed} visitor id(s), removed ${removed} old event(s)`);
} catch (e) { console.error('analytics hygiene failed:', e.message); }

// Privacy retention (src/privacy.js — the periods the Privacy Policy states):
// contact messages after two years, return photos a year after the return
// closed, a closed shop's ID documents after five years. At boot and nightly.
function privacySweep() {
  try {
    const { messages, returnPhotos, idDocuments } = require('./privacy').sweep();
    if (messages || returnPhotos || idDocuments) console.log(`privacy retention: removed ${messages} message(s), ${returnPhotos} return photo(s), ID documents of ${idDocuments} closed shop(s)`);
    jobs.ok('privacy');
  } catch (e) { jobs.fail('privacy', e); }
}
privacySweep();

// Arabic for what people write (src/translate.js): a sweep shortly after
// boot and every hour queues anything public with missing or out-of-date
// Arabic; the background worker translates within the daily budget. Off
// without ANTHROPIC_API_KEY (Arabic pages then show the English).
require('./translate').start();

/* ---------------- Scheduled jobs (single process, guarded) ---------------- */
if (process.env.NODE_ENV !== 'test' && process.env.CRON_DISABLED !== '1') {
  const cron = require('node-cron');
  let settling = false;
  // Fortnightly settlement run — every other Tuesday, 06:00 Dubai time. The
  // cron fires every Tuesday; settlement.isRunDate() keeps only the Tuesdays
  // on the fixed fortnightly calendar (fees.SETTLEMENT_ANCHOR_DATE +
  // multiples of SETTLEMENT_INTERVAL_DAYS). Creates the DRAFT only; an admin
  // reviews, exports the bank CSV, and marks it paid in the panel.
  cron.schedule('0 6 * * 2', () => {
    if (settling) return;
    const settlement = require('./settlement');
    const today = settlement.dubaiToday();
    if (!settlement.isRunDate(today)) {
      console.log(`settlement: ${today} is an off week — next run ${settlement.nextRunDate(today)}`);
      return;
    }
    settling = true;
    try {
      const result = settlement.run(today);
      const line = result
        ? `fortnightly settlement #${result.settlementId}: ${result.items.length} supplier(s), AED ${(result.totalCents / 100).toFixed(2)}`
        : 'fortnightly settlement: nothing payable this run';
      console.log(line);
      jobs.ok('settlement', line);
    } catch (e) {
      // The owner is emailed (once a day at most): makers are waiting on this.
      jobs.fail('settlement', e, { lines: ['No draft settlement was created this run Tuesday, so makers have not been paid. Open Trove payouts and press Run settlement once it is fixed.'] });
    } finally {
      settling = false;
    }
  }, { timezone: 'Asia/Dubai' });

  // Nightly cap scan — flags consignment suppliers whose trailing-30-day paid
  // settlements crossed the graduation threshold (banner + admin queue).
  cron.schedule('0 2 * * *', () => {
    try {
      const n = require('./graduation').scanCaps();
      if (n) console.log(`graduation scan: flagged ${n} supplier(s)`);
    } catch (e) {
      jobs.fail('nightly-checks', e);
    }
    // Emirates ID expiry: remind makers 30 days ahead and at expiry (identity.js).
    try {
      const { reminded, expired } = require('./identity').sweepIdExpiry();
      if (reminded || expired) console.log(`emirates id: reminded ${reminded}, expired ${expired}`);
      jobs.ok('nightly-checks');
    } catch (e) {
      jobs.fail('nightly-checks', e);
    }
  }, { timezone: 'Asia/Dubai' });

  // Nightly privacy retention sweep (02:30 Dubai), before the backup.
  cron.schedule('30 2 * * *', privacySweep, { timezone: 'Asia/Dubai' });

  // Nightly backup (03:30 Dubai, the quietest hour): the local VACUUM INTO
  // copy (backup.js), then the encrypted off-site copy of the database,
  // photos and private documents when BACKUP_S3_* are set; a failure emails
  // ADMIN_EMAIL, Mondays bring a short 'backups OK' (offsite-backup.js).
  let backingUp = false;
  cron.schedule('30 3 * * *', () => {
    if (backingUp) return;
    backingUp = true;
    // offsite-backup emails the owner itself on a failure, so the job record
    // here is quiet (no second email) — it only feeds the Background jobs card.
    require('./offsite-backup').nightly()
      .then((r) => { if (r && r.error) jobs.fail('backup', r.error, { quiet: true }); else jobs.ok('backup', r && r.local ? require('path').basename(String(r.local.file)) : ''); })
      .catch((e) => jobs.fail('backup', e, { quiet: true }))
      .finally(() => { backingUp = false; });
  }, { timezone: 'Asia/Dubai' });

  // Hourly sweeps — expired sessions (otherwise they only leave on a
  // restart) and unpaid checkouts older than a day (PaymentIntent cancelled,
  // order cancelled — see order-sweep.js).
  let sweepingOrders = false;
  cron.schedule('15 * * * *', () => {
    try {
      const n = db.prepare('DELETE FROM sessions WHERE expire < ?').run(Date.now()).changes;
      if (n) console.log(`sessions: swept ${n} expired`);
      // Spent or expired emailed links (kept a month for the reset cooldown
      // and any question about them) and old webhook ids (Stripe retries for
      // three days; half a year is plenty for de-duplication) — F472.
      const t = require('./accounts').purgeOldTokens();
      const w = db.prepare("DELETE FROM webhook_events WHERE received_at < datetime('now', '-180 days')").run().changes;
      if (t || w) console.log(`housekeeping: removed ${t} old sign-in link(s), ${w} old webhook id(s)`);
    } catch (e) {
      console.error('session sweep failed:', e);
    }
    if (sweepingOrders) return;
    sweepingOrders = true;
    const sweeps = require('./order-sweep');
    sweeps.sweepUnpaid()
      .then(({ cancelled, skipped, recovered }) => { if (cancelled || skipped || recovered) console.log(`unpaid checkouts: cancelled ${cancelled}, completed ${recovered || 0} paid with no webhook, left ${skipped} for the payment webhook`); })
      .then(() => sweeps.sweepPaidMissing())
      .then(({ recovered }) => { if (recovered) console.warn(`payment webhook missed: completed ${recovered} paid order(s)`); })
      // Courier upkeep: retry failed bookings, flag uncollected parcels, read the OTO wallet.
      .then(() => sweeps.sweepCourier())
      .then((c) => { if (c.retried && c.retried.tried) console.log(`courier retries: ${c.retried.ok} booked, ${c.retried.failed} still failing`); })
      .then(() => jobs.ok('order-sweep'))
      .catch((e) => jobs.fail('order-sweep', e))
      .finally(() => { sweepingOrders = false; });
    // Pack-by reminders: maker once when the day passes, admin once two days on.
    require('./order-sweep').sweepPackBy()
      .then(({ reminded, escalated, failed }) => { if (reminded || escalated) console.log(`pack-by: reminded ${reminded} maker(s), escalated ${escalated} to admin`); if (!failed) jobs.ok('pack-by'); })
      .catch((e) => jobs.fail('pack-by', e));
    // Didit checks still open (started, in progress, in review): re-read
    // them, so a missed webhook never leaves a maker waiting (didit.js).
    require('./didit').sweepOpen()
      .then(({ checked, changed }) => { if (changed) console.log(`identity checks: re-read ${checked}, ${changed} changed`); jobs.ok('identity'); })
      .catch((e) => jobs.fail('identity', e, { quiet: true }));
    // Service bookings nobody can act on: unpaid past their date, or requests
    // with no answer (provider reminded at 2 days, closed at 7).
    require('./service-bookings').sweepStale()
      .then(({ expired, reminded, closed }) => { if (expired || reminded || closed) console.log(`service bookings: closed ${expired} unpaid past their date, reminded ${reminded} provider(s), closed ${closed} unanswered request(s)`); jobs.ok('service-bookings'); })
      .catch((e) => jobs.fail('service-bookings', e));
  });
}

const server = app.listen(PORT, () => {
  console.log(`trove running on http://localhost:${PORT}`);
  console.log(`  • storefront: http://localhost:${PORT}/`);
  console.log(`  • API:        http://localhost:${PORT}/api/health   (stripe ${getStripe() ? 'configured' : 'OFF'})`);
  // Without the signing secret every Stripe webhook is refused (400), so paid
  // orders only complete through the hourly sweep — say so loudly.
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('  ⚠ STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not — payment webhooks will be refused; set it on Render.');
  }
  otoBoot();
});

// OTO courier: confirm the account answers, then point its status + error
// webhooks at this server (idempotent — safe on every boot). Never blocks.
function otoBoot() {
  const delivery = require('./delivery');
  if (!delivery.isOto()) return console.log(`  • delivery:   ${delivery.mode()}`);
  const oto = require('./delivery/oto-live');
  oto.accountInfo()
    .then((a) => console.log(`  • delivery:   OTO connected (${(a && a.packageName) || 'plan unknown'}, wallet ${a && a.remainingCredit != null ? a.remainingCredit : '?'})`))
    // Store the wallet reading for Admin → Overview (and warn if it is already low).
    .then(() => require('./courier-ops').checkWallet().catch((e) => console.error('OTO wallet check failed:', e.message)))
    .then(() => {
      const secret = process.env.OTO_WEBHOOK_SECRET;
      const base = process.env.PUBLIC_URL || process.env.CLIENT_URL;
      // Without the webhooks parcels never move past 'packed', which also
      // blocks the return window and so every payout: the owner is told.
      if (!secret || !base || !/^https:/.test(base)) {
        return jobs.fail('oto-webhooks', new Error('OTO webhooks not registered: OTO_WEBHOOK_SECRET and an https PUBLIC_URL / CLIENT_URL are needed on Render'),
          { lines: ['Courier status updates will not reach Trove, so parcels stay at Packed and the return window (and maker payouts) never start.'] });
      }
      return oto.ensureWebhooks(base, secret).then((types) => {
        console.log(`OTO webhooks registered: ${types.join(', ')} → ${base}/api/delivery/oto-webhook`);
        jobs.ok('oto-webhooks', types.join(', '));
      });
    })
    .catch((e) => jobs.fail('oto-webhooks', e, { lines: ['The courier connection check at start-up failed, so courier status updates may not reach Trove.'] }));
}
// Render's proxy keeps upstream connections open for ~60 s; Node's 5 s default
// lets the proxy reuse a socket the app has just closed (sporadic 502s under
// load). Keep ours open longer than the proxy's.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

// A deploy (or restart) sends SIGTERM. Stop taking new connections, let the
// requests in flight finish and the emails already handed to Resend go out
// (a receipt queued just after a payment webhook), then exit — at most
// ~10 seconds, well inside Render's shutdown grace (F281/F436).
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: finishing in-flight requests and emails, then stopping`);
  const deadline = setTimeout(() => process.exit(0), 10 * 1000);
  deadline.unref();
  new Promise((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive sockets would otherwise hold close() open until the deadline.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  })
    .then(() => require('./email').drain(5000))
    .catch(() => {})
    .finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
