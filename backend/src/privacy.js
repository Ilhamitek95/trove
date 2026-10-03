'use strict';
/**
 * PDPL tooling: what the Privacy Policy (backend/legal/privacy-v2.md, sections
 * 5 and 7) promises, carried out by code so the owner never edits the live
 * database by hand.
 *
 *   summary(email)            who this is, what Trove holds, and anything still
 *                             in progress that must finish before closing
 *   exportData(email)         a copy of their data (account, addresses, orders,
 *                             returns, reviews, bookings, messages, shop or
 *                             practice) as a JSON-ready object — references
 *                             only, never internal ids
 *   anonymise(email)          close the account and scrub the person out of
 *                             every record, keeping the order, payment, refund
 *                             and settlement rows the record-keeping rules need
 *   deleteIdDocuments(email)  remove a CLOSED shop's Emirates ID photos and
 *                             digits, home address and licence document now
 *   sweep()                   the nightly retention clean-up: contact messages
 *                             after two years, return photos a year after the
 *                             return closed, ID documents five years after a
 *                             shop closed
 *
 * A subject is an email address, so guest buyers (orders and bookings with no
 * account) are covered as well as account holders. Every action writes one
 * row to privacy_log with a hash of the address and counts only.
 *
 * The admin routes are in routes/privacy.routes.js; test/privacy.test.js pins
 * all of it, including that the policy text states these same periods.
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const db = require('./db');
const uploads = require('./uploads');

// The retention periods the Privacy Policy states (section 5). Change them
// only together with a new policy version.
const CONTACT_MESSAGE_DAYS = 730;    // two years
const RETURN_PHOTO_DAYS = 365;       // one year after the return closed
const ID_DOCUMENT_YEARS = 5;         // after the shop closed
const PLACEHOLDER_NAME = 'Deleted customer';

class PrivacyError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const norm = (e) => String(e == null ? '' : e).trim().toLowerCase();
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const hashOf = (email) => nodeCrypto.createHash('sha256').update(norm(email)).digest('hex');
const aed = (cents) => (Number(cents) || 0) / 100;
const json = (text, fallback) => { try { const v = JSON.parse(text); return v == null ? fallback : v; } catch (_) { return fallback; } };
// SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or an ISO string → epoch ms.
const ts = (v) => {
  if (!v) return NaN;
  const s = String(v);
  return Date.parse(/T/.test(s) ? s : s.replace(' ', 'T') + 'Z');
};

function log(action, email, detail) {
  db.prepare('INSERT INTO privacy_log (action, subject_hash, detail) VALUES (?,?,?)')
    .run(action, email ? hashOf(email) : '', JSON.stringify(detail || {}));
}

/** The account (if any) and the address everything else is matched on. */
function subject(email) {
  const e = norm(email);
  if (!EMAIL_RE.test(e)) throw new PrivacyError('Enter the email address the person wrote from');
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(e) || null;
  return { email: e, user };
}

/* ---- what belongs to a subject ---------------------------------------- */

function ordersOf({ email, user }) {
  return db.prepare(`SELECT * FROM orders WHERE lower(email) = ? ${user ? 'OR buyer_id = ?' : ''} ORDER BY id`)
    .all(...(user ? [email, user.id] : [email]));
}
function bookingsOf({ email, user }) {
  return db.prepare(`SELECT b.*, p.name AS provider_name FROM service_bookings b
    LEFT JOIN service_providers p ON p.id = b.provider_id
    WHERE lower(b.email) = ? ${user ? 'OR b.buyer_id = ?' : ''} ORDER BY b.id`)
    .all(...(user ? [email, user.id] : [email]));
}
function messagesOf({ email, user }) {
  return db.prepare(`SELECT * FROM contact_messages WHERE lower(email) = ? ${user ? 'OR user_id = ?' : ''} ORDER BY id`)
    .all(...(user ? [email, user.id] : [email]));
}
function returnsOf(orderIds, user) {
  if (!orderIds.length && !user) return [];
  const marks = orderIds.map(() => '?').join(',') || 'NULL';
  return db.prepare(`SELECT r.*, o.public_id FROM return_requests r JOIN orders o ON o.id = r.order_id
    WHERE r.order_id IN (${marks}) ${user ? 'OR r.buyer_id = ?' : ''} ORDER BY r.id`)
    .all(...orderIds, ...(user ? [user.id] : []));
}
const shopOf = (user) => (user ? db.prepare('SELECT * FROM shops WHERE user_id = ? AND is_house = 0 ORDER BY id LIMIT 1').get(user.id) || null : null);
const providerOf = (user) => (user ? db.prepare('SELECT * FROM service_providers WHERE user_id = ?').get(user.id) || null : null);

/* ---- what must finish first ------------------------------------------- */

function returnWindowEnd(o) {
  if (o.return_window_ends_at) return ts(o.return_window_ends_at);
  if (!o.delivered_at) return NaN;
  const days = o.return_days || require('./fees').RETURN_WINDOW_DAYS;
  return ts(o.delivered_at) + days * 86400000;
}

/** Plain-English reasons the account cannot be closed yet ([] = it can). */
function blockers(s, now = Date.now()) {
  const out = [];
  if (s.user && s.user.role === 'admin') out.push('This is an admin account. Admin accounts are not closed from here.');
  for (const o of ordersOf(s)) {
    if (o.status === 'pending' && now - ts(o.created_at) < 2 * 86400000) out.push(`Order ${o.public_id} is waiting for payment.`);
    if (['paid', 'fulfilled'].includes(o.status) && !o.refunded_at) {
      if (!o.delivered_at) out.push(`Order ${o.public_id} has not been delivered yet.`);
      else if (!(returnWindowEnd(o) < now)) out.push(`Order ${o.public_id} is still inside its return window.`);
    }
  }
  const orderIds = ordersOf(s).map((o) => o.id);
  for (const r of returnsOf(orderIds, s.user)) {
    if (['requested', 'approved', 'collected'].includes(r.status)) out.push(`A return on order ${r.public_id} is still open.`);
  }
  for (const b of bookingsOf(s)) {
    if (['requested', 'awaiting_payment', 'confirmed'].includes(b.status)) out.push(`Booking ${b.code} is still open.`);
  }
  const shop = shopOf(s.user);
  if (shop) {
    const bal = require('./settlement').balances(shop.id);
    if (bal.pendingCents || bal.payableCents) out.push(`The shop ${shop.name} still has money to settle (pending or payable).`);
    const unpaidRun = db.prepare(`SELECT 1 FROM settlement_items si JOIN settlements st ON st.id = si.settlement_id
      WHERE si.shop_id = ? AND st.status <> 'paid' LIMIT 1`).get(shop.id);
    if (unpaidRun) out.push(`The shop ${shop.name} is in a settlement run that has not been marked paid.`);
    const openShip = db.prepare(`SELECT 1 FROM shipments sh JOIN orders o ON o.id = sh.order_id
      WHERE sh.shop_id = ? AND sh.status NOT IN ('delivered','cancelled') AND o.status IN ('paid','fulfilled') LIMIT 1`).get(shop.id);
    if (openShip) out.push(`The shop ${shop.name} has orders still to deliver.`);
  }
  const provider = providerOf(s.user);
  if (provider) {
    const owed = db.prepare(`SELECT 1 FROM provider_credits WHERE provider_id = ? AND paid_at IS NULL AND voided_at IS NULL
      AND amount_cents <> 0 LIMIT 1`).get(provider.id);
    if (owed) out.push(`The practice ${provider.name} has provider fees not yet paid.`);
    const open = db.prepare(`SELECT 1 FROM service_bookings WHERE provider_id = ?
      AND status IN ('requested','awaiting_payment','confirmed') LIMIT 1`).get(provider.id);
    if (open) out.push(`The practice ${provider.name} has open bookings.`);
  }
  return [...new Set(out)];
}

/* ---- summary ------------------------------------------------------------ */

function summary(email) {
  const s = subject(email);
  const orders = ordersOf(s);
  const shop = shopOf(s.user);
  const provider = providerOf(s.user);
  const b = blockers(s);
  const found = !!(s.user || orders.length || bookingsOf(s).length || messagesOf(s).length);
  return {
    email: s.email,
    account: s.user ? {
      name: s.user.name, role: s.user.role, createdAt: s.user.created_at,
      anonymisedAt: s.user.anonymised_at || null,
    } : null,
    counts: {
      orders: orders.length,
      returns: returnsOf(orders.map((o) => o.id), s.user).length,
      reviews: s.user ? db.prepare('SELECT COUNT(*) n FROM reviews WHERE buyer_id = ?').get(s.user.id).n : 0,
      bookings: bookingsOf(s).length,
      messages: messagesOf(s).length,
      addresses: s.user ? db.prepare('SELECT COUNT(*) n FROM addresses WHERE user_id = ?').get(s.user.id).n : 0,
    },
    shop: shop ? {
      name: shop.name, status: shop.status, closedAt: shop.closed_at || null,
      idDocumentsOnFile: hasIdDocuments(shop),
    } : null,
    provider: provider ? { name: provider.name, status: provider.status } : null,
    blocked: require('./customer-block').describe(require('./customer-block').find({ email: s.email, userId: s.user && s.user.id })),
    found,
    blockers: b,
    canAnonymise: found && !(s.user && s.user.anonymised_at) && !b.length,
  };
}

/* ---- export -------------------------------------------------------------- */

function exportData(email) {
  const s = subject(email);
  const company = require('./content').company();
  const orders = ordersOf(s);
  const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');
  const ships = db.prepare('SELECT status, carrier, tracking_number, delivered_at, created_at FROM shipments WHERE order_id = ? ORDER BY id');
  const shop = shopOf(s.user);
  const provider = providerOf(s.user);
  const out = {
    about: `A copy of the personal data ${company.legalName || 'Trove'} (Trove) holds about ${s.email}, `
      + 'made in answer to a request under the UAE Personal Data Protection Law. Amounts are in AED.',
    generatedAt: new Date().toISOString(),
    controller: company.legalName || 'Trove',
    account: s.user ? {
      name: s.user.name, email: s.user.email, mobile: s.user.phone || '',
      accountType: s.user.role, createdAt: s.user.created_at,
      emailVerified: !!s.user.email_verified_at,
      closedAndAnonymisedAt: s.user.anonymised_at || null,
    } : null,
    addresses: s.user ? db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY id').all(s.user.id).map((a) => ({
      label: a.label, name: a.name, line: a.line, city: a.city, country: a.country, phone: a.phone || '', isDefault: !!a.is_default,
    })) : [],
    orders: orders.map((o) => ({
      reference: o.public_id, placedAt: o.created_at, status: o.status,
      email: o.email, mobile: o.phone || '',
      deliveryAddress: json(o.shipping_json, null),
      subtotal: aed(o.subtotal_cents), delivery: aed(o.shipping_cents), total: aed(o.total_cents),
      deliveredAt: o.delivered_at || null, refundedAt: o.refunded_at || null,
      items: orderItems.all(o.id).map((i) => ({
        piece: i.name_snapshot, quantity: i.qty, unitPrice: aed(i.price_cents),
        options: json(i.options, []), extras: json(i.extras, []), personalisation: i.personalization || '',
      })),
      deliveries: ships.all(o.id).map((d) => ({ status: d.status, courier: d.carrier || '', trackingNumber: d.tracking_number || '', deliveredAt: d.delivered_at || null })),
    })),
    returns: returnsOf(orders.map((o) => o.id), s.user).map((r) => ({
      order: r.public_id, reason: r.reason, details: r.details || '', status: r.status,
      refund: r.refund_cents == null ? null : aed(r.refund_cents), requestedAt: r.created_at,
      photos: json(r.images, []),
    })),
    reviews: s.user ? db.prepare(`SELECT r.*, p.name AS product_name, sh.name AS shop_name FROM reviews r
      LEFT JOIN products p ON p.id = r.product_id JOIN shops sh ON sh.id = r.shop_id WHERE r.buyer_id = ? ORDER BY r.id`)
      .all(s.user.id).map((r) => ({
        about: r.product_name || r.shop_name, rating: r.rating, text: r.body || '', photos: json(r.images, []),
        status: r.status, writtenAt: r.created_at,
      })) : [],
    bookings: bookingsOf(s).map((b) => ({
      reference: b.code, service: b.title, provider: b.provider_name || '', requestedAt: b.created_at,
      name: b.name, email: b.email, mobile: b.phone, area: b.area, preferredDate: b.preferred_date || '',
      serviceDate: b.service_date || null, note: b.notes || '', status: b.status,
      payment: b.payment_method, amount: b.amount_cents ? aed(b.amount_cents) : aed(b.price_cents),
    })),
    messages: messagesOf(s).map((m) => ({
      sentAt: m.created_at, name: m.name, email: m.email, topic: m.topic, orderReference: m.order_ref || '', message: m.message,
    })),
    shop: shop ? {
      name: shop.name, address: `/makers/${shop.slug}`, bio: shop.bio || '', location: shop.location || '',
      status: shop.status, openedAt: shop.created_at, closedAt: shop.closed_at || null,
      application: {
        whatYouMake: shop.pitch_products || '', links: shop.pitch_links || '', instagram: shop.pitch_instagram || '',
        experience: shop.pitch_experience || '', whoMakes: shop.pitch_maker || '', channels: shop.pitch_channels || '',
        capacity: shop.pitch_capacity || '', phone: shop.pitch_phone || '',
      },
      collectionAddress: shop.pickup_address || '', collectionPhone: shop.pickup_phone || '',
      bank: { bankName: shop.payout_bank_name || '', accountName: shop.payout_account_name || '', iban: shop.iban_masked || '' },
      emiratesId: {
        lastFourDigits: shop.emirates_id_last4 || '', issueDate: shop.emirates_id_issue || '', expiryDate: shop.emirates_id_expiry || '',
        frontPhotoOnFile: !!shop.eid_front_file, backPhotoOnFile: !!shop.eid_back_file,
      },
      homeAddress: shop.seller_address || '',
      licence: { number: shop.license_number || '', documentOnFile: !!shop.license_image },
      sellerAgreement: { version: shop.agreement_version || '', acceptedAt: shop.agreement_accepted_at || null },
    } : null,
    servicesPractice: provider ? (() => {
      const pay = db.prepare('SELECT account_name, bank_name, iban_masked FROM provider_payout_details WHERE provider_id = ?').get(provider.id);
      return {
        name: provider.name, address: `/services/${provider.slug}`, bio: provider.bio || '', location: provider.location || '',
        status: provider.status, joinedAt: provider.created_at, categories: json(provider.categories, []),
        application: {
          services: provider.pitch_services || '', experience: provider.pitch_experience || '',
          instagram: provider.pitch_instagram || '', links: provider.pitch_links || '', phone: provider.pitch_phone || '',
        },
        bank: pay ? { bankName: pay.bank_name, accountName: pay.account_name, iban: pay.iban_masked } : null,
        providerAgreement: { version: provider.agreement_version || '', acceptedAt: provider.agreement_accepted_at || null },
      };
    })() : null,
  };
  log('export', s.email, { orders: out.orders.length, bookings: out.bookings.length, messages: out.messages.length });
  return out;
}

/* ---- close and anonymise ------------------------------------------------- */

const imagesIn = (text) => json(text, []).filter((u) => typeof u === 'string');

function anonymise(email) {
  const s = subject(email);
  if (s.user && s.user.anonymised_at) throw new PrivacyError('This account has already been closed and anonymised', 409);
  const b = blockers(s);
  if (b.length) throw new PrivacyError('Some things need to finish before this account can be closed', 409, { blockers: b });
  const orders = ordersOf(s);
  const bookings = bookingsOf(s);
  const messages = messagesOf(s);
  if (!s.user && !orders.length && !bookings.length && !messages.length) throw new PrivacyError('Trove holds nothing under that email address', 404);

  const placeholder = `deleted-${nodeCrypto.randomBytes(6).toString('hex')}@deleted.invalid`;
  const files = [];            // public uploads to remove once the rows are committed
  const done = { orders: 0, bookings: 0, messages: 0, returns: 0, reviews: 0, addresses: 0, sessions: 0 };

  db.transaction(() => {
    // Orders stay (tax and commercial records); the person leaves them.
    const scrubOrder = db.prepare('UPDATE orders SET email = ?, phone = \'\', shipping_json = ? WHERE id = ?');
    const scrubPerso = db.prepare("UPDATE order_items SET personalization = '[removed]' WHERE order_id = ? AND COALESCE(personalization, '') <> ''");
    for (const o of orders) {
      const ship = json(o.shipping_json, null);
      const kept = ship && typeof ship === 'object'
        ? { name: PLACEHOLDER_NAME, line: '', city: ship.city || '', emirate: ship.emirate || '', country: ship.country || '' }
        : null;
      scrubOrder.run(placeholder, kept ? JSON.stringify(kept) : null, o.id);
      scrubPerso.run(o.id);
      done.orders++;
    }
    // Return requests: the refund record stays; the words and photos go.
    for (const r of returnsOf(orders.map((o) => o.id), s.user)) {
      files.push(...imagesIn(r.images));
      db.prepare("UPDATE return_requests SET details = '', images = '[]' WHERE id = ?").run(r.id);
      done.returns++;
    }
    // Bookings: amounts and dates stay; who booked goes.
    for (const bk of bookings) {
      db.prepare("UPDATE service_bookings SET name = ?, email = ?, phone = '', notes = '' WHERE id = ?").run(PLACEHOLDER_NAME, placeholder, bk.id);
      done.bookings++;
    }
    for (const m of messages) db.prepare('DELETE FROM contact_messages WHERE id = ?').run(m.id);
    done.messages = messages.length;
    db.prepare('DELETE FROM auth_tokens WHERE lower(email) = ?').run(s.email);

    if (s.user) {
      const uid = s.user.id;
      for (const r of db.prepare('SELECT images FROM reviews WHERE buyer_id = ?').all(uid)) files.push(...imagesIn(r.images));
      done.reviews = db.prepare('DELETE FROM reviews WHERE buyer_id = ?').run(uid).changes;
      done.addresses = db.prepare('DELETE FROM addresses WHERE user_id = ?').run(uid).changes;
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(uid);
      // Signed out everywhere: every stored session for this account goes.
      for (const row of db.prepare('SELECT sid, sess FROM sessions').all()) {
        if (json(row.sess, {}).userId === uid) { db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid); done.sessions++; }
      }
      // A password nobody knows: the account can never be signed in to again.
      const pw = require('./middleware').hashPassword(nodeCrypto.randomBytes(24).toString('hex'));
      db.prepare(`UPDATE users SET name = ?, email = ?, password_hash = ?, phone = NULL, stripe_customer_id = NULL,
        email_verified_at = NULL, password_set = 0, role = CASE WHEN role = 'admin' THEN role ELSE 'buyer' END,
        anonymised_at = datetime('now') WHERE id = ?`).run(PLACEHOLDER_NAME, placeholder, pw, uid);

      const shop = shopOf(s.user);
      if (shop) {
        // Off Trove; application, collection and bank details go. ID
        // documents stay for the retention period (sweep) unless deleted now.
        db.prepare(`UPDATE shops SET status = 'suspended', closed_at = COALESCE(closed_at, datetime('now')),
          pitch_products = '', pitch_links = '', pitch_instagram = '', pitch_experience = '', pitch_maker = '',
          pitch_channels = '', pitch_capacity = '', pitch_phone = '', pickup_address = '', pickup_phone = '',
          payout_iban = '', iban_encrypted = NULL, payout_account_name = '' WHERE id = ?`).run(shop.id);
        db.prepare("UPDATE products SET status = 'hidden' WHERE shop_id = ?").run(shop.id);
      }
      const provider = providerOf(s.user);
      if (provider) {
        db.prepare(`UPDATE service_providers SET status = 'suspended', pitch_services = '', pitch_experience = '',
          pitch_instagram = '', pitch_links = '', pitch_phone = '' WHERE id = ?`).run(provider.id);
        db.prepare("UPDATE services SET status = 'hidden' WHERE provider_id = ?").run(provider.id);
        db.prepare('DELETE FROM provider_payout_details WHERE provider_id = ?').run(provider.id);
      }
    }
    log('anonymise', s.email, done);
  })();
  for (const f of files) uploads.removeByUrl(f);
  return { ok: true, ...done, photosRemoved: files.length };
}

/* ---- identity documents ----------------------------------------------------- */

function hasIdDocuments(shop) {
  return !!(shop.eid_front_file || shop.eid_back_file || shop.license_image || shop.seller_address
    || shop.emirates_id_last4 || shop.emirates_id_expiry);
}

function privateRoot() {
  return path.resolve(process.env.PRIVATE_DIR || path.join(uploads.UPLOADS_DIR, '..', 'private'));
}
/** Licence images are stored as an absolute path; delete only inside the private root. */
function removeLicenceFile(file) {
  if (!file) return;
  const abs = path.resolve(String(file));
  if (!abs.startsWith(privateRoot() + path.sep)) return;
  try { fs.unlinkSync(abs); } catch (_) { /* already gone */ }
}

function wipeIdDocuments(shop) {
  uploads.removeEncryptedPrivate(shop.eid_front_file);
  uploads.removeEncryptedPrivate(shop.eid_back_file);
  removeLicenceFile(shop.license_image);
  db.prepare(`UPDATE shops SET eid_front_file = NULL, eid_front_mime = NULL, eid_back_file = NULL, eid_back_mime = NULL,
    license_image = '', seller_address = '', emirates_id_last4 = '', emirates_id_issue = '', emirates_id_expiry = ''
    WHERE id = ?`).run(shop.id);
}

/** Delete a closed shop's ID documents now (the policy's 'sooner on request'). */
function deleteIdDocuments(email) {
  const s = subject(email);
  const shop = shopOf(s.user);
  if (!shop) throw new PrivacyError('There is no shop on that account', 404);
  if (!shop.closed_at) throw new PrivacyError('Close the account first: ID documents are only deleted once the shop is closed', 409);
  const had = hasIdDocuments(shop);
  wipeIdDocuments(shop);
  log('delete_id_documents', s.email, { removed: had });
  return { ok: true, removed: had };
}

/* ---- nightly retention sweep -------------------------------------------- */

function sweep() {
  const messages = db.prepare(`DELETE FROM contact_messages WHERE created_at < datetime('now', '-${CONTACT_MESSAGE_DAYS} days')`).run().changes;

  let returnPhotos = 0;
  const oldReturns = db.prepare(`SELECT id, images FROM return_requests
    WHERE status IN ('refunded','declined','cancelled') AND images <> '[]'
      AND COALESCE(refunded_at, decided_at, created_at) < datetime('now', '-${RETURN_PHOTO_DAYS} days')`).all();
  for (const r of oldReturns) {
    for (const f of imagesIn(r.images)) { uploads.removeByUrl(f); returnPhotos++; }
    db.prepare("UPDATE return_requests SET images = '[]' WHERE id = ?").run(r.id);
  }

  let idDocuments = 0;
  const closed = db.prepare(`SELECT * FROM shops WHERE closed_at IS NOT NULL
    AND closed_at < datetime('now', '-${ID_DOCUMENT_YEARS} years')`).all();
  for (const shop of closed) {
    if (!hasIdDocuments(shop)) continue;
    wipeIdDocuments(shop);
    idDocuments++;
  }
  if (messages || returnPhotos || idDocuments) log('sweep', '', { messages, returnPhotos, idDocuments });
  return { messages, returnPhotos, idDocuments };
}

module.exports = {
  summary, exportData, anonymise, deleteIdDocuments, sweep, blockers, PrivacyError,
  CONTACT_MESSAGE_DAYS, RETURN_PHOTO_DAYS, ID_DOCUMENT_YEARS, PLACEHOLDER_NAME,
};
