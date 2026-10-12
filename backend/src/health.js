'use strict';
/**
 * What /api/health checks (F436). Render's health check and any outside
 * uptime monitor poll it, so it must fail when the site really cannot work:
 *
 *   db     the database answers a query
 *   disk   the data disk (where the database, photos and backups live)
 *          takes a small write — a full or read-only disk fails here
 *
 * Free space is measured at most every few minutes and reported as
 * diskFreePercent. Running low (under LOW_PERCENT) never fails the check —
 * that would take the site off Render's routing while it could still sell —
 * it emails the owner instead (job-runs: once a day) and shows on the admin
 * Overview's Background jobs card until there is room again.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const LOW_PERCENT = 10;
const MEASURE_EVERY_MS = 5 * 60 * 1000;
let lastMeasure = { at: 0, freePercent: null, low: false };

const dataDir = () => path.dirname(path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'trove.db')));

/** Free space on the data disk, measured at most every few minutes. */
function diskSpace(now = Date.now()) {
  if (now - lastMeasure.at < MEASURE_EVERY_MS) return lastMeasure;
  let freePercent = null;
  try {
    const s = fs.statfsSync(dataDir());
    if (s && s.blocks > 0) freePercent = Math.round((s.bavail / s.blocks) * 1000) / 10;
  } catch (_) { /* not every platform reports it */ }
  const low = freePercent != null && freePercent < LOW_PERCENT;
  const jobs = require('./job-runs');
  if (low) {
    jobs.fail('disk-space', new Error(`Only ${freePercent}% of the data disk is free`), {
      lines: ['Photos, backups and the database share this disk. When it is full, orders and sign-ups fail. Ask for old backups to be cleared or the disk to be made larger in Render.'],
    });
  } else if (lastMeasure.low) {
    jobs.ok('disk-space', `${freePercent}% free`);
  }
  lastMeasure = { at: now, freePercent, low };
  return lastMeasure;
}

/** { ok, db, disk, diskFreePercent } — ok is false when the database or the disk write fails. */
function check() {
  let dbOk = false;
  try { dbOk = db.prepare('SELECT 1 AS one').get().one === 1; } catch (e) { console.error('health: database check failed:', e.message); }
  let diskOk = false;
  try {
    fs.writeFileSync(path.join(dataDir(), '.health-check'), String(Date.now()));
    diskOk = true;
  } catch (e) { console.error('health: disk write failed:', e.message); }
  const space = diskSpace();
  return { ok: dbOk && diskOk, db: dbOk, disk: diskOk, diskFreePercent: space.freePercent };
}

function _reset() { lastMeasure = { at: 0, freePercent: null, low: false }; }

module.exports = { check, diskSpace, LOW_PERCENT, _reset };
