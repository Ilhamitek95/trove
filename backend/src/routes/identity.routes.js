'use strict';
/**
 * POST /api/identity/didit/webhook — Didit says a session changed (src/didit.js).
 *
 * The signature (DIDIT_WEBHOOK_SECRET, five-minute window) only decides
 * whether Trove looks again: the decision itself is re-read from Didit's API
 * with Trove's key, and only for sessions Trove started. A failed re-read
 * answers 502 so Didit retries (twice, over about five minutes); the hourly
 * sweep catches anything after that.
 */
const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/didit/webhook', async (req, res) => {
  const didit = require('../didit');
  if (!didit.enabled() || !didit.webhookConfigured()) return res.status(503).json({ error: 'Identity checks are not configured' });
  if (!didit.verifyWebhook(req.rawBody, req.body, req.headers)) return res.status(401).json({ error: 'Invalid signature' });
  const b = req.body || {};
  const sessionId = typeof b.session_id === 'string' ? b.session_id : '';
  if (!['status.updated', 'data.updated'].includes(b.webhook_type) || !sessionId) return res.json({ received: true, ignored: true });
  if (!db.prepare('SELECT 1 FROM identity_sessions WHERE session_id=?').get(sessionId)) return res.json({ received: true, ignored: true });
  try {
    const out = await didit.refreshSession(sessionId);
    res.json({ received: true, status: out.effective || null });
  } catch (e) {
    console.error('didit webhook: could not re-read the decision:', e.message);
    res.status(502).json({ error: 'Could not read the decision' });
  }
});

module.exports = router;
