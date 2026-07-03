'use strict';
require('dotenv').config();
const db = require('./db');

// First-boot demo seed: SEED_DEMO=1 populates an EMPTY database with the demo
// catalogue. It never touches a database that already has users, so it is safe
// to leave on — once real accounts exist it does nothing.
if (process.env.SEED_DEMO === '1' && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  require('./seed');
}

// Super admin bootstrap: ADMIN_EMAIL (+ ADMIN_PASSWORD for first creation)
// guarantees the platform owner's account exists with the admin role. If the
// account already exists it is promoted, never re-passworded — change the
// password by changing it in the app, not the env.
if (process.env.ADMIN_EMAIL) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (existing) {
    if (existing.role !== 'admin') {
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(existing.id);
      console.log(`admin bootstrap: promoted ${email} to admin`);
    }
  } else if (process.env.ADMIN_PASSWORD) {
    const { hashPassword } = require('./middleware');
    db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?, 'admin')")
      .run(email, hashPassword(process.env.ADMIN_PASSWORD), process.env.ADMIN_NAME || 'Trove Admin');
    console.log(`admin bootstrap: created admin account ${email}`);
  } else {
    console.warn('admin bootstrap: ADMIN_EMAIL set but account missing and no ADMIN_PASSWORD to create it');
  }
}

// Demo-account lockdown: on a public deployment set DEMO_PASSWORD to replace
// the seeded accounts' well-known "demo1234" password (re-applied every boot,
// so changing the env changes the password). The house account also loses its
// admin role — on a live site the only admin should be the ADMIN_EMAIL owner.
// Real customer accounts are never touched. Leave unset in local dev.
if (process.env.DEMO_PASSWORD) {
  const { hashPassword } = require('./middleware');
  const DEMO_EMAILS = [
    'layla@email.com', 'hello@trove.com', 'mara@kilnandclay.com',
    'hello@northboundloom.com', 'hello@embergoods.com',
    'hello@fernapothecary.com', 'hello@foliopaper.com', 'nadia@sableandstone.com',
  ];
  const hash = hashPassword(process.env.DEMO_PASSWORD);
  const rotate = db.prepare('UPDATE users SET password_hash=? WHERE email=?');
  let rotated = 0;
  for (const email of DEMO_EMAILS) rotated += rotate.run(hash, email).changes;
  let demoted = 0;
  if ((process.env.ADMIN_EMAIL || '').trim().toLowerCase() !== 'hello@trove.com') {
    demoted = db.prepare("UPDATE users SET role='seller' WHERE email='hello@trove.com' AND role='admin'").run().changes;
  }
  if (rotated) console.log(`demo lockdown: rotated ${rotated} demo password(s)${demoted ? ', house account demoted to seller' : ''}`);
}

// One-time data fix: Trove now operates in Dubai & Abu Dhabi only, so the
// seeded demo shops move from their original international locations to the
// two emirates. Keyed on slug + exact old value, so a location a seller has
// since edited is never touched. (Fresh seeds already use the new values.)
{
  const MOVES = [
    ['kiln-and-clay',   'Lisbon, Portugal',   'Alserkal Avenue, Dubai'],
    ['northbound-loom', 'Reykjavík, Iceland', 'Al Quoz, Dubai'],
    ['ember-goods',     'Marrakech, Morocco', 'Deira, Dubai'],
    ['fern-apothecary', 'Portland, USA',      'Masdar City, Abu Dhabi'],
    ['folio-paper',     'Kyoto, Japan',       'Al Zahiyah, Abu Dhabi'],
    ['sable-and-stone', 'Muscat, Oman',       'Khalifa City, Abu Dhabi'],
  ];
  const move = db.prepare('UPDATE shops SET location=? WHERE slug=? AND location=?');
  let moved = 0;
  for (const [slug, from, to] of MOVES) moved += move.run(to, slug, from).changes;
  // Matching bio touch-ups where the old city was written into the story.
  moved += db.prepare(`UPDATE shops SET bio=REPLACE(bio,'in a workshop in the medina','in our Deira workshop') WHERE slug='ember-goods' AND bio LIKE '%in a workshop in the medina%'`).run().changes;
  moved += db.prepare(`UPDATE shops SET bio=REPLACE(bio,'a small studio in Muscat','a small studio in Khalifa City, Abu Dhabi') WHERE slug='sable-and-stone' AND bio LIKE '%a small studio in Muscat%'`).run().changes;
  if (moved) console.log(`service area: relocated ${moved} demo shop field(s) to Dubai/Abu Dhabi`);
}

const { createApp } = require('./app');
const { getStripe } = require('./stripe');

const app = createApp();
const PORT = process.env.PORT || 4242;

app.listen(PORT, () => {
  console.log(`trove running on http://localhost:${PORT}`);
  console.log(`  • storefront: http://localhost:${PORT}/trove.html`);
  console.log(`  • API:        http://localhost:${PORT}/api/health   (stripe ${getStripe() ? 'configured' : 'OFF'})`);
});
