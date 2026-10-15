'use strict';
/**
 * Didit — identity checks for makers (15 Oct 2026).
 *
 * A maker without a verified trade licence proves who they are by a Didit
 * check instead of sending Emirates ID photos for the admin to compare: they
 * scan their Emirates ID, take a live selfie, and Didit matches the face to
 * the card. The workflow (Didit console → Workflows → "Trove maker identity
 * (Emirates ID + selfie)") accepts only the UAE Identity Card and refuses
 * anyone under 18.
 *
 * Flow:
 *   1. Payouts → "Verify my Emirates ID": the maker ticks the consent box and
 *      POST /api/seller/identity/start creates a session (vendor_data
 *      'shop-<id>') and returns Didit's hosted URL; the browser goes there.
 *   2. Didit sends the maker back to /sell?verificationSessionId=…, and the
 *      dashboard calls POST /api/seller/identity/refresh.
 *   3. Didit also calls POST /api/identity/didit/webhook whenever the status
 *      changes (an "In Review" session the owner decides in the Didit
 *      console lands here). The hourly sweep re-reads open sessions too, so
 *      nothing depends on one delivery.
 *
 * Trust: the decision is ALWAYS read from Didit's API with Trove's key
 * (GET /v3/session/{id}/decision/). A webhook body only says "look again" —
 * its signature is checked, then it is ignored. Sessions Trove did not start
 * (identity_sessions) are ignored. And Trove applies its own rules on top of
 * Didit's "Approved": a UAE Identity Card, in date, with liveness and face
 * match both approved.
 *
 * What Trove keeps: the name on the ID, its last four digits, issue and
 * expiry dates, the session status and the decline reasons. Never the photos,
 * the selfie, the full ID number or the date of birth.
 *
 * Env: DIDIT_API_KEY + DIDIT_WORKFLOW_ID switch it on; DIDIT_WEBHOOK_SECRET
 * lets the webhook in. Without them the photo route is the only one.
 */
const crypto = require('crypto');
const db = require('./db');

const API = () => (process.env.DIDIT_API_URL || 'https://verification.didit.me').replace(/\/+$/, '');
const apiKey = () => (process.env.DIDIT_API_KEY || '').trim();
const workflowId = () => (process.env.DIDIT_WORKFLOW_ID || '').trim();
const webhookSecret = () => (process.env.DIDIT_WEBHOOK_SECRET || '').trim();
const enabled = () => !!(apiKey() && workflowId());

// Session statuses Didit may still change. 'In Review' waits for the owner's
// decision in the Didit console.
const OPEN = ['Not Started', 'In Progress', 'In Review', 'Resubmitted', 'Awaiting User'];
const MAX_SESSIONS_PER_DAY = 5;      // per shop — each finished check costs money
const SWEEP_MAX_AGE_DAYS = 30;       // stop re-reading sessions older than this

class DiditError extends Error {
  constructor(message, status = 502, code = 'didit_error') { super(message); this.status = status; this.code = code; }
}

/* ---- HTTP (the transport is swappable for tests) ---- */
const defaultTransport = (url, opts) => fetch(url, opts);
let transport = defaultTransport;
function _setTransport(fn) { transport = fn || defaultTransport; }

async function call(method, path, body) {
  let res;
  try {
    res = await transport(API() + path, {
      method,
      headers: { 'x-api-key': apiKey(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new DiditError(`Didit ${method} ${path} → ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never echo the key; Didit's own message is safe to log.
    const detail = typeof j.detail === 'string' ? j.detail : Object.values(j || {}).flat().filter((x) => typeof x === 'string').join(' ');
    const e = new DiditError(`Didit ${method} ${path} → ${res.status} ${detail}`.trim(), res.status >= 500 ? 502 : 503);
    e.httpStatus = res.status;
    e.noCredits = /enough credits/i.test(detail);
    throw e;
  }
  return j;
}

/* ---- reading a decision ---- */
const first = (a) => (Array.isArray(a) && a.length ? a[0] : null);
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
const dubaiToday = (now = Date.now()) => new Date(now + 4 * 3600000).toISOString().slice(0, 10);

/**
 * The Emirates ID number (784-YYYY-NNNNNNN-C, 15 digits) from whichever field
 * Didit put it in; any other number with 4+ digits as a fallback. Only the
 * last four digits ever leave this function's caller.
 */
function idNumber(idv) {
  if (!idv) return '';
  const cands = [idv.personal_number, idv.document_number, idv.mrz && idv.mrz.optional_data, idv.mrz && idv.mrz.personal_number,
    idv.mrz && idv.mrz.document_number].map((x) => String(x || '').replace(/\D/g, '')).filter((x) => x.length >= 4);
  return cands.find((x) => x.length === 15 && x.startsWith('784')) || cands[0] || '';
}

/** Decline reasons a maker can act on: Didit's error-level warnings, short. */
function reasonsOf(d) {
  const feats = ['id_verifications', 'liveness_checks', 'face_matches'];
  const out = [];
  for (const f of feats) for (const item of (Array.isArray(d[f]) ? d[f] : [])) {
    for (const w of (Array.isArray(item.warnings) ? item.warnings : [])) {
      if (w && w.log_type === 'error' && w.short_description && !out.includes(w.short_description)) out.push(String(w.short_description).slice(0, 120));
    }
  }
  return out.slice(0, 5);
}

/**
 * Didit's decision → what Trove keeps, plus Trove's own verdict:
 *   { status, effective, refusal, name, document: { type, country, last4,
 *     expiry, issue, status }, liveness, faceMatch, reasons }
 * `effective` is the status Trove acts on: Didit's 'Approved' becomes
 * 'Declined' when the result is not a UAE Identity Card in date with
 * liveness and face match approved (`refusal` says which).
 */
function summarise(d, now = Date.now()) {
  d = d || {};
  const idv = first(d.id_verifications);
  const live = first(d.liveness_checks);
  const face = first(d.face_matches);
  const num = idNumber(idv);
  const doc = idv ? {
    type: idv.document_type || null,
    country: idv.issuing_state || null,
    last4: num ? num.slice(-4) : null,
    expiry: isoDate(idv.expiration_date),
    issue: isoDate(idv.date_of_issue),
    status: idv.status || null,
  } : null;
  const name = idv ? String(idv.full_name || [idv.first_name, idv.last_name].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const status = String(d.status || '');
  let refusal = null;
  if (status === 'Approved') {
    if (!doc || doc.status !== 'Approved') refusal = 'The ID check was not approved';
    else if (doc.country !== 'ARE' || !/identity card/i.test(String(doc.type || ''))) refusal = 'Not a UAE Emirates ID';
    else if (!doc.expiry || doc.expiry <= dubaiToday(now)) refusal = 'The Emirates ID has expired';
    else if (!doc.last4) refusal = 'The Emirates ID number could not be read';
    else if (!live || live.status !== 'Approved') refusal = 'The live selfie was not approved';
    else if (!face || face.status !== 'Approved') refusal = 'The selfie did not match the ID photo';
  }
  const reasons = reasonsOf(d);
  if (refusal && !reasons.includes(refusal)) reasons.unshift(refusal);
  return {
    status,
    effective: refusal ? 'Declined' : status,
    refusal,
    name,
    document: doc,
    liveness: live ? live.status || null : null,
    faceMatch: face ? face.status || null : null,
    reasons: reasons.slice(0, 5),
  };
}

/* ---- sessions ---- */
const vendorData = (shopId) => `shop-${shopId}`;

/**
 * Start (or resume) a check for this shop. Didit returns the same unfinished
 * session for the same vendor_data, so a second click resumes it.
 * Returns { url, sessionId, status }.
 */
async function startSession(shop, user, { lang = 'en', siteUrl } = {}) {
  if (!enabled()) throw new DiditError('Identity checks are not switched on', 503, 'not_configured');
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM identity_sessions
    WHERE shop_id=? AND created_at > datetime('now', '-1 day')`).get(shop.id).n;
  if (recent >= MAX_SESSIONS_PER_DAY) throw new DiditError('You have started several checks today. Please try again tomorrow, or send photos of your Emirates ID instead.', 429, 'too_many');
  const base = (siteUrl || require('./accounts').siteUrl()).replace(/\/+$/, '');
  const s = await call('POST', '/v3/session/', {
    workflow_id: workflowId(),
    vendor_data: vendorData(shop.id),
    callback: `${base}${lang === 'ar' ? '/ar' : ''}/sell`,
    metadata: { trove_shop_id: shop.id },
    language: lang === 'ar' ? 'ar' : 'en',
  });
  const sessionId = String(s.session_id || '');
  const url = String(s.url || '');
  if (!sessionId || !/^https:\/\//.test(url)) throw new DiditError('Didit did not return a verification link');
  const status = String(s.status || 'Not Started');
  db.transaction(() => {
    db.prepare(`INSERT INTO identity_sessions (shop_id, user_id, session_id, status, consent_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET consent_at=datetime('now'), updated_at=datetime('now')`)
      .run(shop.id, user ? user.id : null, sessionId, status);
    db.prepare("UPDATE shops SET didit_session_id=?, didit_status=?, didit_updated_at=datetime('now') WHERE id=?")
      .run(sessionId, status, shop.id);
  })();
  return { url, sessionId, status };
}

/**
 * Apply a decision to Trove: the session row always, and the shop when this
 * is its latest session or the decision approves it. Idempotent.
 * Returns { applied, shopId, effective } or { ignored }.
 */
function applyDecision(decision, now = Date.now()) {
  const sessionId = String((decision && decision.session_id) || '');
  const row = sessionId && db.prepare('SELECT * FROM identity_sessions WHERE session_id=?').get(sessionId);
  if (!row) return { ignored: 'unknown session' };
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(row.shop_id);
  if (!shop) return { ignored: 'shop gone' };
  // Didit's metadata names the shop too: a session moved between shops is refused.
  if (decision.vendor_data && decision.vendor_data !== vendorData(shop.id)) return { ignored: 'vendor mismatch' };
  const sum = summarise(decision, now);
  const effective = sum.effective || row.status;
  const stored = { ...sum, name: undefined }; // the name lives on the shop only
  const decided = !OPEN.includes(effective) || effective === 'In Review';
  db.transaction(() => {
    db.prepare(`UPDATE identity_sessions SET status=?, summary=?, updated_at=datetime('now'),
        decided_at=CASE WHEN ? THEN COALESCE(decided_at, datetime('now')) ELSE decided_at END WHERE id=?`)
      .run(effective, JSON.stringify(stored), decided ? 1 : 0, row.id);
    if (effective === 'Approved') {
      const d = sum.document;
      const verifiedByDidit = shop.verification_method === 'didit' && !!shop.identity_checked_at;
      if (row.status === 'Approved') {
        // A re-read of a session that already approved the shop. Still the
        // shop's verification: take any correction a Didit reviewer made.
        // Otherwise the admin withdrew it (Admin → Shops → untick) or a newer
        // check replaced it, and a repeated webhook must not bring it back.
        if (verifiedByDidit && shop.didit_session_id === sessionId) {
          db.prepare(`UPDATE shops SET emirates_id_last4=?, emirates_id_expiry=?, emirates_id_issue=?, identity_name=?,
              eid_reminder_for = CASE WHEN COALESCE(emirates_id_expiry,'') = ? THEN eid_reminder_for ELSE NULL END WHERE id=?`)
            .run(d.last4, d.expiry, d.issue || '', sum.name || null, d.expiry, shop.id);
        }
      } else if (verifiedByDidit && shop.didit_session_id !== sessionId && String(shop.emirates_id_expiry || '') > d.expiry) {
        // A late approval of an older check never replaces a newer ID.
      } else {
        // The first approval of this session (a first check, or a renewed ID).
        db.prepare(`UPDATE shops SET
            verification_method = CASE WHEN license_verified_at IS NOT NULL THEN 'trade_licence' ELSE 'didit' END,
            identity_checked_at = datetime('now'), identity_checked_by = NULL,
            emirates_id_last4 = ?, emirates_id_expiry = ?, emirates_id_issue = ?, identity_name = ?,
            eid_reminder_for = CASE WHEN COALESCE(emirates_id_expiry,'') = ? THEN eid_reminder_for ELSE NULL END,
            didit_session_id = ?, didit_status = 'Approved', didit_updated_at = datetime('now')
          WHERE id = ?`).run(d.last4, d.expiry, d.issue || '', sum.name || null, d.expiry, sessionId, shop.id);
        console.log(`identity: Didit verified shop ${shop.slug} (ID ending ${d.last4}, expires ${d.expiry})`);
      }
    } else if (shop.didit_session_id === sessionId) {
      db.prepare("UPDATE shops SET didit_status=?, didit_updated_at=datetime('now') WHERE id=?").run(effective, shop.id);
    }
  })();
  if (sum.refusal) console.warn(`identity: Didit approved session ${sessionId} for shop ${shop.slug}, but Trove refused it: ${sum.refusal}`);
  return { applied: true, shopId: shop.id, effective };
}

/** Re-read one session from Didit and apply it. */
async function refreshSession(sessionId, now = Date.now()) {
  const decision = await call('GET', `/v3/session/${encodeURIComponent(sessionId)}/decision/`);
  if (!decision.session_id) decision.session_id = sessionId;
  return applyDecision(decision, now);
}

/** The shop's latest session, re-read (the dashboard's return from Didit). */
async function refreshShop(shop) {
  if (!enabled() || !shop || !shop.didit_session_id) return { ignored: 'no session' };
  return refreshSession(shop.didit_session_id);
}

/**
 * Hourly: re-read sessions Didit may still change (started, in progress, in
 * review), oldest first, so a missed webhook never strands a maker.
 */
async function sweepOpen({ limit = 25 } = {}) {
  if (!enabled()) return { checked: 0, changed: 0 };
  const rows = db.prepare(`SELECT session_id, status FROM identity_sessions
    WHERE status IN (${OPEN.map(() => '?').join(',')}) AND created_at > datetime('now', ?)
    ORDER BY updated_at ASC LIMIT ?`).all(...OPEN, `-${SWEEP_MAX_AGE_DAYS} days`, limit);
  let changed = 0;
  for (const r of rows) {
    const out = await refreshSession(r.session_id);
    if (out.applied && out.effective !== r.status) changed++;
  }
  return { checked: rows.length, changed };
}

/* ---- webhook signatures ---- */
function shortenFloats(x) {
  if (Array.isArray(x)) return x.map(shortenFloats);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shortenFloats(v)]));
  return x;
}
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') return Object.keys(x).sort().reduce((a, k) => { a[k] = sortKeys(x[k]); return a; }, {});
  return x;
}
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * True when the request is Didit's, signed with DIDIT_WEBHOOK_SECRET and no
 * older than five minutes: X-Signature over the exact raw bytes, else
 * X-Signature-V2 over the sorted compact JSON. The deprecated envelope-only
 * X-Signature-Simple is not accepted.
 */
function verifyWebhook(rawBody, body, headers, now = Date.now()) {
  const secret = webhookSecret();
  if (!secret) return false;
  const h = (k) => headers[k] || headers[k.toLowerCase()] || '';
  const ts = parseInt(h('x-timestamp'), 10);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(now / 1000) - ts) > 300) return false;
  const raw = h('x-signature');
  if (raw && rawBody && sameHex(hmac(secret, rawBody), raw)) return true;
  const v2 = h('x-signature-v2');
  if (v2 && body && typeof body === 'object' && sameHex(hmac(secret, Buffer.from(JSON.stringify(sortKeys(shortenFloats(body))), 'utf8')), v2)) return true;
  return false;
}

/* ---- what the dashboards see ---- */
function latestSummary(shop) {
  if (!shop || !shop.didit_session_id) return null;
  const r = db.prepare('SELECT status, summary, updated_at FROM identity_sessions WHERE session_id=?').get(shop.didit_session_id);
  if (!r) return null;
  let s = null; try { s = r.summary ? JSON.parse(r.summary) : null; } catch (_) { s = null; }
  return { status: r.status, updatedAt: r.updated_at, reasons: (s && Array.isArray(s.reasons)) ? s.reasons : [] };
}

/** The maker's own view: is the check available, and where their latest one stands. */
function sellerState(shop) {
  const last = latestSummary(shop);
  return {
    available: enabled(),
    status: shop.didit_status || null,
    reasons: last && last.status === 'Declined' ? last.reasons : [],
    updatedAt: shop.didit_updated_at || null,
  };
}

/** The admin's view: the same plus the session id (to find it in the Didit console). */
function adminState(shop) {
  const last = latestSummary(shop);
  return {
    status: shop.didit_status || null,
    sessionId: shop.didit_session_id || null,
    updatedAt: shop.didit_updated_at || null,
    reasons: last ? last.reasons : [],
  };
}

module.exports = {
  enabled, webhookConfigured: () => !!webhookSecret(), OPEN, MAX_SESSIONS_PER_DAY, DiditError,
  startSession, refreshSession, refreshShop, applyDecision, sweepOpen, summarise, idNumber, verifyWebhook,
  sellerState, adminState, vendorData, _setTransport,
};
