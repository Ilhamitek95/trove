#!/usr/bin/env node
'use strict';
/**
 * Clear the demo data out of a database, keeping one shop, one piece and one
 * service provider (each optional) plus every admin account. See src/purge.js.
 *
 *   npm run purge-demo -- --keep-shop=kiln-and-clay --keep-product=1 --keep-provider=noor-letters
 *
 * Without --yes it only PRINTS what would go. With --yes it writes a
 * VACUUM INTO backup next to the database first (backups/, see src/backup.js)
 * and then removes everything listed. Extra accounts to spare:
 * --keep-user=a@b.com,c@d.com
 *
 * On Render: the service's Shell tab opens in the backend folder already, so
 * the same command works there against the live database on /var/data.
 */
require('dotenv').config();

const args = Object.create(null);
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (!m) { console.error(`Unknown argument: ${a}`); process.exit(2); }
  args[m[1]] = m[2] === undefined ? true : m[2];
}
const opts = {
  keepShop: args['keep-shop'],
  keepProduct: args['keep-product'],
  keepProvider: args['keep-provider'],
  keepUsers: args['keep-user'] ? String(args['keep-user']).split(',').map((s) => s.trim()).filter(Boolean) : [],
};

const db = require('../src/db');
const purge = require('../src/purge');

let p;
try { p = purge.plan(db, opts); }
catch (e) { console.error(`\n${e.message}\n`); process.exit(2); }

const list = (rows, fmt) => (rows.length ? rows.map((r) => `    ${fmt(r)}`).join('\n') : '    (none)');
console.log(`\nDatabase: ${process.env.DB_PATH || 'backend/trove.db'}\n`);
console.log('KEEPING');
console.log(`  shop:      ${p.keep.shop ? `#${p.keep.shop.id} ${p.keep.shop.name} (${p.keep.shop.slug})` : '- none -'}`);
console.log(`  piece:     ${p.keep.product ? `#${p.keep.product.id} ${p.keep.product.name}` : '- none -'}`);
console.log(`  provider:  ${p.keep.provider ? `#${p.keep.provider.id} ${p.keep.provider.name} (${p.keep.provider.slug})` : '- none -'}`);
console.log(`  accounts:\n${list(p.keep.users, (u) => `${u.email} (${u.role})`)}`);
console.log('\nREMOVING');
console.log(`  accounts (${p.users.length}):\n${list(p.users, (u) => `${u.email} (${u.role})`)}`);
console.log(`  shops (${p.shops.length}):\n${list(p.shops, (s) => `#${s.id} ${s.name}${s.is_house ? ' [house line]' : ''}`)}`);
console.log(`  pieces (${p.products.length}):\n${list(p.products, (x) => `#${x.id} ${x.name} (shop ${x.shop_id})`)}`);
console.log(`  providers (${p.providers.length}):\n${list(p.providers, (x) => `#${x.id} ${x.name}`)}`);
console.log(`  service listings: ${p.services}`);
const nonEmpty = Object.entries(p.tables).filter(([, n]) => n > 0);
console.log(`  emptied tables: ${nonEmpty.length ? nonEmpty.map(([t, n]) => `${t} ${n}`).join(', ') : '(all already empty)'}`);
console.log(`  homepage picks pruned in: ${p.content.length ? p.content.join(', ') : '(nothing to prune)'}`);
console.log(`  files (${p.files.length}):\n${list(p.files, (f) => f)}`);

if (!args.yes) {
  console.log('\nDry run - nothing was changed. Add --yes to back up and proceed.\n');
  process.exit(0);
}

const r = purge.run(db, opts);
console.log(`\nBackup written: ${r.backup}`);
console.log(`Done. Removed ${r.users.length} account(s), ${r.shops.length} shop(s), ${r.products.length} piece(s), ${r.providers.length} provider(s), ${r.removedFiles.length} file(s).\n`);
