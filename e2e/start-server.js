'use strict';
/**
 * Boots the real Trove server (backend/src/server.js) on a throwaway database
 * for the browser journeys. Every run starts from a fresh temp folder seeded
 * with the local demo catalogue, so nothing here can touch a real database.
 *
 * Every outside service is switched off explicitly — dotenv never overrides a
 * variable that is already set, so backend/.env can't switch them back on:
 *   no Stripe key      → demo-payments checkout (the storefront places real
 *                        orders without a card form; tests also blank the
 *                        publishable key in config.js, see tests/fixtures.js)
 *   no courier token   → mock delivery (hand-cranked via /api/delivery/mock/deliver)
 *   no Resend key      → emails are logged as "skipped"
 *   no Anthropic key   → the AI tag button is hidden
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = String(process.env.E2E_PORT || 4390);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-e2e-'));

Object.assign(process.env, {
  NODE_ENV: 'development',          // lets tests use the mock courier hand-crank
  PORT,
  CLIENT_URL: `http://localhost:${PORT}`,
  DB_PATH: path.join(dir, 'trove.db'),
  UPLOADS_DIR: path.join(dir, 'uploads'),
  PRIVATE_DIR: path.join(dir, 'private'),
  SEED_DEMO: '1',                   // demo shops, buyer layla@email.com, house line (password demo1234)
  DEMO_PROVIDERS: '1',              // demo service providers
  CRON_DISABLED: '1',
  RATE_LIMIT_DISABLED: '1',
  SESSION_SECRET: 'e2e-session-secret',
  PAYOUT_ENC_KEY: '7d2c4e9a1f3b5a6c8e0d2f4a6b8c0e1d3f5a7b9c1e3d5f7a9b1c3e5d7f9a1b3c',
  ADMIN_EMAIL: 'admin@e2e.test',
  ADMIN_PASSWORD: 'e2e-admin-pass',
  ADMIN_NAME: 'E2E Admin',
  DEMO_PASSWORD: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  STRIPE_MOCK: '',
  RESEND_API_KEY: '',
  EMAIL_FROM: '',
  OTO_REFRESH_TOKEN: '',
  OTO_WEBHOOK_SECRET: '',
  QUIQUP_CLIENT_ID: '',
  QUIQUP_CLIENT_SECRET: '',
  ANTHROPIC_API_KEY: '',
  GOOGLE_CLIENT_ID: '',
  RAIL_B_ENABLED: '0',
  VAT_REGISTERED: '',
});

console.log(`[e2e] throwaway database in ${dir}`);
process.chdir(path.join(__dirname, '..', 'backend'));
require('../backend/src/server.js');
