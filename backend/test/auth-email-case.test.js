'use strict';
const { testEnv, startApp } = require('./helpers');
testEnv({});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let ctx, db;

before(async () => {
  ctx = await startApp();
  db = ctx.db;
});
after(async () => { await ctx.close(); });

test('emails are case- and whitespace-insensitive for register and login', async () => {
  const reg = await ctx.api('POST', '/api/auth/register', {
    body: { email: '  Casey.Buyer@Example.COM ', password: 'testpass123', name: 'Casey' },
  });
  assert.equal(reg.status, 201);

  const stored = db.prepare("SELECT email FROM users WHERE email = 'casey.buyer@example.com'").get();
  assert.ok(stored, 'email stored lowercased');

  for (const email of ['casey.buyer@example.com', 'Casey.Buyer@example.com', 'CASEY.BUYER@EXAMPLE.COM', ' casey.buyer@example.com ']) {
    const res = await ctx.api('POST', '/api/auth/login', { body: { email, password: 'testpass123' } });
    assert.equal(res.status, 200, `login should succeed for ${JSON.stringify(email)}`);
  }

  const wrong = await ctx.api('POST', '/api/auth/login', { body: { email: 'casey.buyer@example.com', password: 'testpass123 ' } });
  assert.equal(wrong.status, 401, 'password itself stays exact');

  // Registering again with different casing hits the existing account, not a duplicate.
  const dupe = await ctx.api('POST', '/api/auth/register', {
    body: { email: 'CASEY.BUYER@EXAMPLE.COM', password: 'different-pw', name: 'Casey Again' },
  });
  assert.equal(dupe.status, 409);
  assert.match(dupe.data.error, /already exists/);
});

test('migration 005 folds pre-existing mixed-case emails so they can log in', async () => {
  const { hashPassword } = require('../src/middleware');
  db.prepare("INSERT INTO users (email,password_hash,name,role) VALUES ('Legacy.User@Example.com',?,'Legacy','buyer')")
    .run(hashPassword('testpass123'));
  db.prepare("DELETE FROM schema_migrations WHERE id='005-lowercase-emails'").run();
  require('../src/migrations/index').run(db);

  const folded = db.prepare("SELECT email FROM users WHERE email = 'legacy.user@example.com'").get();
  assert.ok(folded, 'legacy email folded to lowercase');
  const login = await ctx.api('POST', '/api/auth/login', { body: { email: 'Legacy.User@example.COM', password: 'testpass123' } });
  assert.equal(login.status, 200);
});
