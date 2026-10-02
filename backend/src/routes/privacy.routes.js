'use strict';
/**
 * Admin privacy tools (src/privacy.js) — the buttons behind a 'Privacy and
 * my data' request, so nobody edits the live database by hand.
 *
 *   GET  /api/admin/privacy/lookup?email=            what Trove holds + what must finish first
 *   GET  /api/admin/privacy/export?email=            download a copy of their data (JSON file)
 *   POST /api/admin/privacy/anonymise                { email, confirm: <same email> }
 *   POST /api/admin/privacy/delete-id-documents      { email } — closed shops only
 *
 * Admin only. Never cached: the payloads are personal data.
 */
const express = require('express');
const { requireAdmin } = require('../middleware');
const privacy = require('../privacy');

const router = express.Router();

router.use(requireAdmin, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const fail = (res, e, next) => {
  if (e instanceof privacy.PrivacyError) return res.status(e.status).json({ error: e.message, blockers: e.blockers || [] });
  return next(e);
};

router.get('/lookup', (req, res, next) => {
  try { res.json(privacy.summary(req.query.email)); } catch (e) { fail(res, e, next); }
});

router.get('/export', (req, res, next) => {
  try {
    const data = privacy.exportData(req.query.email);
    const day = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="trove-personal-data-${day}.json"`);
    res.type('application/json').send(JSON.stringify(data, null, 2));
  } catch (e) { fail(res, e, next); }
});

router.post('/anonymise', (req, res, next) => {
  const b = req.body || {};
  if (String(b.confirm || '').trim().toLowerCase() !== String(b.email || '').trim().toLowerCase() || !b.email) {
    return res.status(400).json({ error: 'Type the email address again to confirm' });
  }
  try { res.json(privacy.anonymise(b.email)); } catch (e) { fail(res, e, next); }
});

router.post('/delete-id-documents', (req, res, next) => {
  try { res.json(privacy.deleteIdDocuments((req.body || {}).email)); } catch (e) { fail(res, e, next); }
});

module.exports = router;
