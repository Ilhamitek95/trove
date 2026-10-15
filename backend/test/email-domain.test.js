'use strict';
/**
 * F197, updated 2026-10-15 (hello@troveathome.com is a real inbox; owner:
 * noreply@ is for order emails, hello@ is for the company):
 *   - every email carries a plain-text part; it stays honestly no-reply
 *     unless EMAIL_REPLY_TO is set, and the no-reply footer names the
 *     company address to write to instead;
 *   - contact-form messages go to the company address, the owner's own
 *     inbox only when that is blank;
 *   - the Trove Collection's courier contact is the company address; a
 *     maker's is their own.
 */
const { testEnv } = require('./helpers');
testEnv({ ADMIN_EMAIL: 'owner@test.local' });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('send: plain-text part always; reply-to only when EMAIL_REPLY_TO is set', async () => {
  const email = require('../src/email');
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ id: 'x' }) }; };
  process.env.RESEND_API_KEY = 're_test';
  try {
    await email.send({ to: 'buyer@test.local', subject: 'Hi', html: '<style>p{}</style><p>Your order <b>TRV-1</b> &amp; more</p><p><a href="https://troveathome.com/account">See your order</a></p>' });
    const b = calls[0].body;
    assert.equal(b.reply_to, undefined, 'no reply-to while no inbox is named');
    assert.equal(b.text, 'Your order TRV-1 & more\nSee your order (https://troveathome.com/account)');
    process.env.EMAIL_REPLY_TO = 'hello@troveathome.com';
    await email.send({ to: 'buyer@test.local', subject: 'Hi', html: '<p>x</p>' });
    assert.equal(calls[1].body.reply_to, 'hello@troveathome.com');
  } finally {
    global.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_REPLY_TO;
  }
});

test('the footer matches: no-reply without EMAIL_REPLY_TO, an invitation to reply with it (English and Arabic)', () => {
  const email = require('../src/email');
  const msg = () => email.adminAlert({ subject: 'S', title: 'T', lines: ['x'] }).html;
  assert.match(msg(), /replies aren't read/);
  assert.match(msg(), /Write to us at <a href="mailto:hello@troveathome\.com"[^>]*>hello@troveathome\.com<\/a>/);
  assert.match(email.textOf(msg()), /Questions\? Write to us at hello@troveathome\.com\./);
  assert.match(email.kit('ar').layout('t', '<p>x</p>'), /راسلنا على <a href="mailto:hello@troveathome\.com"/);
  process.env.EMAIL_REPLY_TO = 'hello@troveathome.com';
  try {
    assert.match(msg(), /Reply to this email and a real person will read it/);
    assert.doesNotMatch(msg(), /replies aren't read/);
    assert.doesNotMatch(msg(), /Write to us at/);
    const { layout } = email.kit('ar');
    assert.match(layout('t', '<p>x</p>'), /ردّ على هذه الرسالة/);
  } finally { delete process.env.EMAIL_REPLY_TO; }
});

test('textOf: readable text from a real email template, without the hidden preview line', () => {
  const email = require('../src/email');
  const msg = email.adminAlert({ subject: 'S', title: 'Backups OK', lines: ['Line one', 'Line two'] });
  const t = email.textOf(msg.html);
  assert.ok(t.startsWith('trove.'), t.slice(0, 40));
  assert.ok(t.includes('Backups OK'));
  assert.ok(t.includes('Line one\nLine two'));
  assert.doesNotMatch(t, /<\/?[a-z][^>]*>/i, 'no tags left');
  assert.doesNotMatch(t, /[​-‍]/, 'no invisible filler');
});

test('contact messages go to the company address; the owner inbox is only the fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'contact.routes.js'), 'utf8');
  assert.match(src, /CONTACT_EMAIL \|\| content\.company\(\)\.email \|\| process\.env\.ADMIN_EMAIL/);
  const oto = fs.readFileSync(path.join(__dirname, '..', 'src', 'delivery', 'oto-live.js'), 'utf8');
  assert.doesNotMatch(oto, /'hello@troveathome\.com'/, 'the address comes from Site content, never hard-coded');
  assert.match(oto, /shop\.is_house && require\('\.\.\/content'\)\.company\(\)\.email\) \|\| shop\.owner_email/);
});
