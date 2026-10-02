'use strict';
/**
 * The /contact form.
 *
 *   POST /api/contact                 anyone (rate-limited per IP in app.js):
 *                                     validate → store → email the owner
 *   GET  /api/contact/messages        admin: the latest messages
 *   PATCH /api/contact/messages/:id   admin: { handled: true|false }
 *
 * The message is written to contact_messages BEFORE the email goes out, and
 * the email is fire-and-forget, so nothing is lost if Resend is down or not
 * configured. It goes to CONTACT_EMAIL (env), else ADMIN_EMAIL, else the
 * company email in Site content.
 *
 * The form also works without JavaScript: a urlencoded post is answered with
 * a redirect back to /contact (?sent=1 or ?error=<code>) instead of JSON.
 * Only a short code travels in the address; the page looks it up in a fixed
 * list (site-pages CONTACT_ERRORS), so nobody can make a Trove link print
 * words of their own.
 */
const express = require('express');
const db = require('../db');
const email = require('../email');
const content = require('../content');
const { requireAdmin } = require('../middleware');
const { TOPICS, CONTACT_ERRORS } = require('../site-pages');

const router = express.Router();
const TOPIC_LABEL = Object.fromEntries(TOPICS);

const clean = (v) => String(v == null ? '' : v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();

/** The error code for a submission (a key of CONTACT_ERRORS), or null when it is fine. */
function problem(b) {
  const name = clean(b.name);
  const mail = clean(b.email);
  const message = clean(b.message);
  const orderRef = clean(b.orderRef);
  if (!name) return 'name';
  if (name.length > 80 || /[<>]/.test(name)) return 'name-chars';
  if (!mail || mail.length > 254 || !content.EMAIL_RE.test(mail)) return 'email';
  if (b.topic != null && b.topic !== '' && !TOPIC_LABEL[b.topic]) return 'topic';
  if (orderRef && !/^[A-Za-z0-9-]{1,30}$/.test(orderRef)) return 'order';
  if (message.length < 10) return 'short';
  if (message.length > 4000) return 'long';
  return null;
}

// The owner's own inbox comes before the public company address: until the
// troveathome.com mailbox exists (no MX record on 2026-10-02, F197) mail to
// hello@troveathome.com bounces, and a contact message must never vanish.
function recipient() {
  return (process.env.CONTACT_EMAIL || process.env.ADMIN_EMAIL || content.company().email || '').trim();
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function notifyOwner(row) {
  const to = recipient();
  if (!to) { console.log('contact: no CONTACT_EMAIL / company email / ADMIN_EMAIL — message stored only'); return; }
  const topic = TOPIC_LABEL[row.topic] || 'Something else';
  const html = `<div style="font-family:Quicksand,'Segoe UI',Helvetica,Arial,sans-serif;color:#292727;font-size:15px;line-height:1.6;max-width:560px">
<p style="font-size:13px;color:#7b716d;margin:0 0 6px">New message from the Trove contact form</p>
<p style="margin:0 0 4px"><b>${escHtml(row.name)}</b> · <a href="mailto:${escHtml(row.email)}" style="color:#292727">${escHtml(row.email)}</a></p>
<p style="margin:0 0 4px">About: ${escHtml(topic)}${row.order_ref ? ` · Order ${escHtml(row.order_ref)}` : ''}</p>
<div style="margin:14px 0;padding:14px 16px;background:#FDF7F5;border:1px solid #EFE5E0;border-radius:12px;white-space:pre-wrap">${escHtml(row.message)}</div>
<p style="font-size:13px;color:#7b716d">Reply by writing to ${escHtml(row.email)}. The message is also saved in the admin panel under Messages (no. ${row.id}).</p>
</div>`;
  email.send({ to, subject: `Contact form: ${topic}${row.order_ref ? ` · ${row.order_ref}` : ''} — ${row.name}`, html })
    .catch((e) => console.error('contact email failed:', e.message));
}

router.post('/', express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
  const b = req.body || {};
  const isForm = !!req.is('application/x-www-form-urlencoded');
  const reply = (status, payload, code) => {
    if (!isForm) return res.status(status).json(payload);
    const q = code ? `?error=${encodeURIComponent(code)}` : '?sent=1';
    return res.redirect(303, `/contact${q}`);
  };
  // The hidden "website" field is left empty by people and filled by bots:
  // answer as if it worked, store nothing.
  if (clean(b.website)) return reply(201, { ok: true });
  const code = problem(b);
  if (code) return reply(400, { error: CONTACT_ERRORS[code] }, code);
  const row = {
    name: clean(b.name),
    email: clean(b.email).toLowerCase(),
    topic: TOPIC_LABEL[b.topic] ? b.topic : 'other',
    order_ref: clean(b.orderRef).toUpperCase(),
    message: clean(b.message),
    user_id: req.session && req.session.userId ? req.session.userId : null,
  };
  const info = db.prepare(`INSERT INTO contact_messages (name, email, topic, order_ref, message, user_id)
    VALUES (@name, @email, @topic, @order_ref, @message, @user_id)`).run(row);
  row.id = info.lastInsertRowid;
  notifyOwner(row);
  return reply(201, { ok: true });
});

router.get('/messages', requireAdmin, (_req, res) => {
  const rows = db.prepare(`SELECT id, name, email, topic, order_ref, message, handled_at, created_at
    FROM contact_messages ORDER BY (handled_at IS NOT NULL), id DESC LIMIT 200`).all();
  res.json({
    messages: rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, topic: r.topic, topicLabel: TOPIC_LABEL[r.topic] || r.topic,
      orderRef: r.order_ref, message: r.message, handledAt: r.handled_at, createdAt: r.created_at,
    })),
    open: db.prepare('SELECT COUNT(*) AS n FROM contact_messages WHERE handled_at IS NULL').get().n,
  });
});

router.patch('/messages/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown message' });
  const done = !!(req.body && req.body.handled);
  const r = db.prepare(`UPDATE contact_messages SET handled_at = ${done ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(id);
  if (!r.changes) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true });
});

module.exports = router;
module.exports.problem = problem;
