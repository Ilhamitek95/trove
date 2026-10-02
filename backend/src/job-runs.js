'use strict';
/**
 * When each scheduled job last worked, and what went wrong when it didn't
 * (F145, table job_runs from migration 024-F3).
 *
 *   ok(job, note?)        a successful run
 *   fail(job, error)      a failed run: logged, stored, and the owner is
 *                         emailed — at most once per job per Dubai day, so a
 *                         job failing every hour never floods the inbox
 *   status()              every job for the admin Overview ('last backup …')
 *
 * The jobs that matter to a solo owner: paying makers (settlement), keeping
 * backups, and the courier's status updates (OTO webhook set-up), plus the
 * hourly sweeps that complete payments and nudge late parcels.
 */
const db = require('./db');

const LABELS = {
  settlement: 'Fortnightly settlement run',
  backup: 'Nightly database backup',
  'oto-webhooks': 'Courier status updates (OTO webhooks)',
  'order-sweep': 'Hourly payment and courier checks',
  'pack-by': 'Pack-by reminders',
  'nightly-checks': 'Nightly checks (sales cap, ID expiry)',
  privacy: 'Privacy retention sweep',
  unhandled: 'Unexpected server error',
};

const dubaiToday = (now = Date.now()) => new Date(now + 4 * 3600000).toISOString().slice(0, 10);

function ok(job, note = '') {
  try {
    db.prepare(`INSERT INTO job_runs (job, last_ok_at, last_ok_note) VALUES (?, datetime('now'), ?)
      ON CONFLICT(job) DO UPDATE SET last_ok_at=excluded.last_ok_at, last_ok_note=excluded.last_ok_note, failing=0`).run(job, String(note).slice(0, 300));
  } catch (e) { console.error(`job-runs: could not record ${job}:`, e.message); }
}

/**
 * Record a failure and tell the owner (once per job per day). Never throws —
 * it is called from catch blocks. Returns true when an email was queued.
 */
function fail(job, error, { lines = [] } = {}) {
  const msg = String((error && error.message) || error || 'unknown error').slice(0, 500);
  console.error(`${job} failed:`, error);
  try {
    const today = dubaiToday();
    db.prepare(`INSERT INTO job_runs (job, last_error_at, last_error, failing) VALUES (?, datetime('now'), ?, 1)
      ON CONFLICT(job) DO UPDATE SET last_error_at=excluded.last_error_at, last_error=excluded.last_error, failing=1`).run(job, msg);
    const claimed = db.prepare("UPDATE job_runs SET alerted_on=? WHERE job=? AND alerted_on<>?").run(today, job, today).changes === 1;
    if (!claimed) return false;
    require('./notify').alertOwner(`${LABELS[job] || job} failed`, error, { job, lines });
    return true;
  } catch (e) {
    console.error(`job-runs: could not record the ${job} failure:`, e.message);
    return false;
  }
}

/** Every job seen so far, for the admin: { job, label, lastOkAt, lastErrorAt, lastError, failing }. */
function status() {
  return db.prepare('SELECT * FROM job_runs ORDER BY job').all().map((r) => ({
    job: r.job, label: LABELS[r.job] || r.job,
    lastOkAt: r.last_ok_at || null, lastOkNote: r.last_ok_note || '',
    lastErrorAt: r.last_error_at || null, lastError: r.last_error || '',
    // Failing = it failed and has not worked since.
    failing: !!r.failing,
  }));
}

module.exports = { ok, fail, status, LABELS };
