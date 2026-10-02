'use strict';
/**
 * `npm run seed` EMPTIES the database (every order, shop, account and
 * payout record) before loading the demo catalogue. It is for a developer's
 * own machine. This guard makes it refuse to run when:
 *   - NODE_ENV is 'production' (the live site on Render), or
 *   - the database holds any account that is not one of the demo logins
 *     (so a real customer, maker or admin would be wiped),
 * unless `--force-wipe` is passed. Even then a VACUUM INTO backup is written
 * next to the database first (backups/trove-before-seed-*.db), the same way
 * scripts/purge-demo.js does.
 *
 * Tests (NODE_ENV=test) seed throwaway databases and are let through.
 */
const DEMO_EMAILS = Object.freeze([
  'layla@email.com', 'hello@trove.com', 'mara@kilnandclay.com',
  'hello@northboundloom.com', 'hello@embergoods.com',
  'hello@fernapothecary.com', 'hello@foliopaper.com', 'nadia@sableandstone.com',
  ...require('./demo-providers').DEMO_PROVIDER_EMAILS,
]);

/**
 * Why seeding must not run against this database, or null when it may.
 * { argv, env } default to the running process.
 */
function refusal(db, { argv = process.argv, env = process.env } = {}) {
  if (argv.includes('--force-wipe')) return null;
  if (env.NODE_ENV === 'test') return null;
  if (env.NODE_ENV === 'production') {
    return 'NODE_ENV is production: seeding would erase the live database (orders, makers, customers, payouts).';
  }
  const demo = new Set(DEMO_EMAILS);
  const real = db.prepare('SELECT email FROM users').all().map((u) => String(u.email || '').toLowerCase()).filter((e) => !demo.has(e));
  if (real.length) {
    return `this database has ${real.length} account(s) that are not demo logins; seeding would erase them and everything they own.`;
  }
  return null;
}

/**
 * Run before the wipe: exits the process with a message when seeding is
 * refused; otherwise backs up a non-empty database and returns the backup
 * path (or null when there was nothing to keep).
 */
function guard(db, opts = {}) {
  const why = refusal(db, opts);
  if (why) {
    console.error(`\nnpm run seed refused: ${why}\n` +
      'Seeding is for a local development database only. To clear demo data on the live site use\n' +
      '  npm run purge-demo   (dry run first; --yes backs up, then removes)\n' +
      'If you really mean to wipe THIS database, run: node src/seed.js --force-wipe\n');
    process.exit(2);
  }
  const env = opts.env || process.env;
  if (env.NODE_ENV === 'test') return null;
  const hasData = db.prepare('SELECT 1 FROM users LIMIT 1').get() || db.prepare('SELECT 1 FROM orders LIMIT 1').get();
  if (!hasData) return null;
  const { file } = require('./backup').run(new Date(), { prefix: 'trove-before-seed' });
  console.log(`Backup written before seeding: ${file}`);
  return file;
}

module.exports = { DEMO_EMAILS, refusal, guard };
