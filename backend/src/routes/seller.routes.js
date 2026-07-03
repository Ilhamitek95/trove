'use strict';
const express = require('express');
const db = require('../db');
const { requireSeller } = require('../middleware');
const { requireStripe } = require('../stripe');
const fees = require('../fees');
const shipments = require('../shipments');
const uploads = require('../uploads');

const router = express.Router();
const CLIENT = () => process.env.CLIENT_URL || 'http://localhost:3000';
// The buyer's delivery address is snapshotted as JSON on the order at checkout.
function parseShip(json) { try { return json ? JSON.parse(json) : null; } catch (_) { return null; } }

// Never let encrypted blobs or plaintext bank numbers leave the API — the UI
// only ever needs the masked IBAN.
function publicShop(shop) {
  const { iban_encrypted, payout_iban, ...safe } = shop;
  return safe;
}

/* ---------------- Shop profile ---------------- */
router.get('/me', requireSeller, (req, res) => res.json({ shop: publicShop(req.shop) }));

router.patch('/me', requireSeller, (req, res) => {
  const { name, bio, location, color } = req.body || {};
  if (location != null) {
    const { SERVICE_AREAS, isServiceable } = require('../service-area');
    if (!isServiceable(location))
      return res.status(400).json({ error: `Trove shops are based in ${SERVICE_AREAS.join(' and ')} only` });
  }
  db.prepare('UPDATE shops SET name=COALESCE(?,name), bio=COALESCE(?,bio), location=COALESCE(?,location), color=COALESCE(?,color) WHERE id=?')
    .run(name, bio, location, color, req.shop.id);
  res.json({ shop: publicShop(db.prepare('SELECT * FROM shops WHERE id=?').get(req.shop.id)) });
});

// Upload (or remove) the shop's photo. Body: { image: <data URL> } to set,
// { image: null } to go back to the colour tile. The old file is cleaned up.
router.post('/me/image', requireSeller, (req, res, next) => {
  try {
    const { image } = req.body || {};
    let url = '';
    if (image) url = uploads.saveDataUrl(image, 'shops', `shop-${req.shop.id}`);
    uploads.removeByUrl(req.shop.image);
    db.prepare('UPDATE shops SET image=? WHERE id=?').run(url, req.shop.id);
    res.json({ shop: publicShop(db.prepare('SELECT * FROM shops WHERE id=?').get(req.shop.id)) });
  } catch (e) { next(e); }
});

/* ---------------- Products ---------------- */
const toCents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

router.get('/products', requireSeller, (req, res) => {
  res.json({ products: db.prepare('SELECT * FROM products WHERE shop_id=? ORDER BY created_at DESC').all(req.shop.id) });
});

// Personalisation settings arrive as { enabled, required, prompt, maxLen }.
const persoCols = (p) => p ? [p.enabled ? 1 : 0, p.required ? 1 : 0, String(p.prompt || '').slice(0, 300), Math.min(1024, Math.max(1, parseInt(p.maxLen) || 256))] : [0, 0, '', 256];

router.post('/products', requireSeller, (req, res) => {
  const { name, description = '', category = 'Home', price, compareAt, stock = 0, status = 'draft', imageSeed = 'new', personalization } = req.body || {};
  if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
  const catErr = require('../categories').categoryError(category);
  if (catErr) return res.status(422).json({ error: catErr.message });
  const info = db.prepare(`INSERT INTO products (shop_id,name,description,category,price_cents,compare_at_cents,stock,status,image_seed,
      personalization_enabled,personalization_required,personalization_prompt,personalization_char_limit)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.shop.id, name, description, category, toCents(price), toCents(compareAt), stock, status, imageSeed, ...persoCols(personalization));
  res.status(201).json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid) });
});

router.patch('/products/:id', requireSeller, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=? AND shop_id=?').get(req.params.id, req.shop.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.category != null) {
    const catErr = require('../categories').categoryError(b.category);
    if (catErr) return res.status(422).json({ error: catErr.message });
  }
  db.prepare(`UPDATE products SET name=COALESCE(?,name), description=COALESCE(?,description), category=COALESCE(?,category),
    price_cents=COALESCE(?,price_cents), compare_at_cents=?, stock=COALESCE(?,stock), status=COALESCE(?,status) WHERE id=?`)
    .run(b.name, b.description, b.category, toCents(b.price),
         b.compareAt === undefined ? p.compare_at_cents : toCents(b.compareAt),
         b.stock, b.status, p.id);
  if (b.personalization !== undefined) {
    db.prepare(`UPDATE products SET personalization_enabled=?, personalization_required=?, personalization_prompt=?, personalization_char_limit=? WHERE id=?`)
      .run(...persoCols(b.personalization), p.id);
  }
  res.json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(p.id) });
});

router.delete('/products/:id', requireSeller, (req, res) => {
  const r = db.prepare('DELETE FROM products WHERE id=? AND shop_id=?').run(req.params.id, req.shop.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/* ---------------- Orders & shipment tracking ---------------- */
router.get('/orders', requireSeller, (req, res) => {
  const rows = db.prepare(`
    SELECT sh.*, o.public_id, o.email, o.created_at AS order_created, o.status AS order_status, o.shipping_json,
           s.name AS shop_name, s.color, s.is_house
    FROM shipments sh
    JOIN orders o ON o.id = sh.order_id
    JOIN shops  s ON s.id = sh.shop_id
    WHERE sh.shop_id = ?
    ORDER BY o.created_at DESC, sh.id DESC`).all(req.shop.id);
  res.json({ orders: rows.map((r) => ({
    ...shipments.shape(r),
    order: { publicId: r.public_id, email: r.email, createdAt: r.order_created, status: r.order_status, ship: parseShip(r.shipping_json) },
  })) });
});

// Advance a shipment's tracking: status + courier + tracking number.
// 'delivered' goes through the shared markDelivered funnel (same path as the
// courier webhook) so the 7-day return-window clock is stamped exactly once;
// stepping BACK from delivered is blocked once the credit is in a settlement.
router.patch('/shipments/:id', requireSeller, (req, res, next) => {
  try {
    const sh = db.prepare('SELECT * FROM shipments WHERE id=? AND shop_id=?').get(req.params.id, req.shop.id);
    if (!sh) return res.status(404).json({ error: 'Shipment not found' });
    const { status, carrier, trackingNumber, trackingUrl, note } = req.body || {};
    if (status && !shipments.LABELS[status]) return res.status(400).json({ error: 'Invalid status' });

    const undoingDelivery = sh.status === 'delivered' && status && status !== 'delivered';
    if (undoingDelivery) shipments.assertUndoable(sh); // 409 once settled

    db.transaction(() => {
      db.prepare(`UPDATE shipments SET status=COALESCE(?,status), carrier=COALESCE(?,carrier),
          tracking_number=COALESCE(?,tracking_number), tracking_url=COALESCE(?,tracking_url), updated_at=datetime('now')
        WHERE id=?`).run(status === 'delivered' ? null : (status || null), carrier ?? null, trackingNumber ?? null, trackingUrl ?? null, sh.id);
      if (undoingDelivery) {
        db.prepare('UPDATE shipments SET delivered_at=NULL, return_window_ends_at=NULL WHERE id=?').run(sh.id);
      }
      if (status && status !== sh.status && status !== 'delivered') {
        db.prepare('INSERT INTO shipment_events (shipment_id, status, note) VALUES (?,?,?)')
          .run(sh.id, status, note || shipments.noteFor(status, carrier ?? sh.carrier, trackingNumber ?? sh.tracking_number));
        shipments.deriveOrderStatus(sh.order_id);
      }
    })();
    if (status === 'delivered') shipments.markDelivered(sh.id, 'seller');

    const row = db.prepare('SELECT sh.*, s.name AS shop_name, s.color, s.is_house FROM shipments sh JOIN shops s ON s.id=sh.shop_id WHERE sh.id=?').get(sh.id);
    res.json({ shipment: shipments.shape(row) });
  } catch (e) { next(e); }
});

/* ---------------- Payout setup (consignment suppliers) ---------------- */
// The old free-form bank endpoint is gone: payout details now arrive as one
// verified package — Emirates ID last-4, IBAN in the supplier's own name
// (encrypted at rest), and acceptance of the Seller Agreement.
router.patch('/payout', requireSeller, (_req, res) => {
  res.status(410).json({ error: 'This endpoint has been replaced by POST /api/seller/payout-setup' });
});

router.post('/payout-setup', requireSeller, (req, res, next) => {
  try {
    const pcrypto = require('../crypto');
    const cfg = require('../config');
    const b = req.body || {};

    const last4 = String(b.emiratesIdLast4 || '').trim();
    if (!/^\d{4}$/.test(last4)) return res.status(400).json({ error: 'Enter the last 4 digits of your Emirates ID' });
    const expiry = String(b.emiratesIdExpiry || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry <= new Date().toISOString().slice(0, 10))
      return res.status(400).json({ error: 'Your Emirates ID expiry date must be in the future' });
    const issue = String(b.emiratesIdIssue || '').trim();
    if (issue && !/^\d{4}-\d{2}-\d{2}$/.test(issue)) return res.status(400).json({ error: 'Emirates ID issue date must be YYYY-MM-DD' });

    const iban = String(b.iban || '').replace(/\s+/g, '').toUpperCase();
    if (!/^AE\d{21}$/.test(iban)) return res.status(400).json({ error: 'Enter a valid UAE IBAN (AE followed by 21 digits)' });
    const accountName = String(b.accountName || '').trim().slice(0, 120);
    const bankName = String(b.bankName || '').trim().slice(0, 120);
    if (!accountName || !bankName) return res.status(400).json({ error: 'Bank name and the account holder name are required' });

    if (b.acceptAgreement !== true) return res.status(400).json({ error: 'You need to accept the Seller Agreement' });
    if (!pcrypto.hasKey()) return res.status(503).json({ error: 'Payout setup is temporarily unavailable (encryption key not configured)' });

    // Hash the exact agreement text being accepted.
    const file = require('path').join(__dirname, '..', '..', 'legal', `seller-agreement-${cfg.AGREEMENT_VERSION}.md`);
    const agreementHash = pcrypto.sha256(require('fs').readFileSync(file, 'utf8'));

    db.prepare(`UPDATE shops SET
        emirates_id_last4=?, emirates_id_issue=?, emirates_id_expiry=?,
        payout_bank_name=?, payout_account_name=?,
        iban_encrypted=?, iban_masked=?, payout_iban='',
        agreement_version=?, agreement_accepted_at=datetime('now'), agreement_hash=?
      WHERE id=?`)
      .run(last4, issue, expiry, bankName, accountName,
        pcrypto.encrypt(iban), pcrypto.maskIban(iban),
        cfg.AGREEMENT_VERSION, agreementHash, req.shop.id);
    res.json({ shop: publicShop(db.prepare('SELECT * FROM shops WHERE id=?').get(req.shop.id)) });
  } catch (e) { next(e); }
});

// Supplier money view: pending (return window still open), payable (next
// settlement run — may be negative after refunds), settled to date, and the
// settlement history with purchase-note downloads. Every figure derives from
// the single eligibility rule in src/settlement.js.
router.get('/settlements', requireSeller, (req, res) => {
  const settlement = require('../settlement');
  const bal = settlement.balances(req.shop.id);
  const history = db.prepare(`
    SELECT si.id, si.amount_cents, si.credit_cents, si.debit_cents, si.item_count,
           si.bank_reference, st.run_date, st.status, st.paid_at,
           (SELECT pn.id FROM purchase_notes pn WHERE pn.settlement_item_id = si.id ORDER BY pn.id DESC LIMIT 1) AS note_id
    FROM settlement_items si JOIN settlements st ON st.id = si.settlement_id
    WHERE si.shop_id=? ORDER BY si.id DESC`).all(req.shop.id);
  const legacyPaid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t FROM payouts WHERE shop_id=? AND status='paid'").get(req.shop.id).t;
  res.json({
    tier: req.shop.tier,
    commissionPercent: fees.COMMISSION_PERCENT,
    payoutSetupComplete: settlement.payoutSetupComplete(req.shop),
    pendingCents: bal.pendingCents,
    payableCents: bal.payableCents,
    settledCents: bal.settledCents + legacyPaid,
    history: history.map((h) => ({
      id: h.id, runDate: h.run_date, status: h.status, paidAt: h.paid_at,
      amountCents: h.amount_cents, creditCents: h.credit_cents, debitCents: h.debit_cents,
      itemCount: h.item_count, bankReference: h.bank_reference,
      purchaseNoteId: h.note_id || null,
    })),
  });
});

// GET /api/seller/purchase-notes/:id → a supplier downloads their own note.
router.get('/purchase-notes/:id', requireSeller, (req, res) => {
  const note = db.prepare('SELECT * FROM purchase_notes WHERE id=? AND shop_id=?').get(req.params.id, req.shop.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  res.sendFile(require('path').resolve(note.html_path));
});

/* ---------------- Stripe Connect (Express) ---------------- */
// POST /api/seller/connect -> creates/links a connected account, returns an onboarding URL.
router.post('/connect', requireSeller, async (req, res, next) => {
  try {
    const stripe = requireStripe();
    let acctId = req.shop.stripe_account_id;
    if (!acctId) {
      const acct = await stripe.accounts.create({
        type: 'express',
        email: req.user.email,
        business_profile: { name: req.shop.name },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      acctId = acct.id;
      db.prepare('UPDATE shops SET stripe_account_id=? WHERE id=?').run(acctId, req.shop.id);
    }
    const link = await stripe.accountLinks.create({
      account: acctId,
      refresh_url: `${CLIENT()}/trove-seller.html?connect=refresh`,
      return_url: `${CLIENT()}/trove-seller.html?connect=done`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (e) { next(e); }
});

// GET /api/seller/connect/status -> refreshes onboarding flags from Stripe.
router.get('/connect/status', requireSeller, async (req, res, next) => {
  try {
    if (!req.shop.stripe_account_id) return res.json({ connected: false });
    const stripe = requireStripe();
    const acct = await stripe.accounts.retrieve(req.shop.stripe_account_id);
    db.prepare('UPDATE shops SET charges_enabled=?, payouts_enabled=? WHERE id=?')
      .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0, req.shop.id);
    res.json({ connected: true, accountId: acct.id, chargesEnabled: acct.charges_enabled, payoutsEnabled: acct.payouts_enabled });
  } catch (e) { next(e); }
});

// POST /api/seller/connect/login-link -> one-time link into the Stripe Express dashboard.
router.post('/connect/login-link', requireSeller, async (req, res, next) => {
  try {
    if (!req.shop.stripe_account_id) return res.status(400).json({ error: 'Not connected yet' });
    const stripe = requireStripe();
    const link = await stripe.accounts.createLoginLink(req.shop.stripe_account_id);
    res.json({ url: link.url });
  } catch (e) { next(e); }
});

module.exports = router;
