'use strict';
/**
 * A tiny express-session store backed by the existing better-sqlite3 database.
 * Avoids a second native dependency (e.g. connect-sqlite3 → sqlite3) and keeps
 * logins alive across server restarts — important on hosts that restart often.
 */
const session = require('express-session');
const db = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   TEXT NOT NULL,
  expire INTEGER NOT NULL
)`);

const DAY = 1000 * 60 * 60 * 24;
const expiryOf = (sess) =>
  sess && sess.cookie && sess.cookie.expires
    ? new Date(sess.cookie.expires).getTime()
    : Date.now() + 14 * DAY;

class SqliteStore extends session.Store {
  constructor() {
    super();
    // Drop anything already expired on boot.
    try { db.prepare('DELETE FROM sessions WHERE expire < ?').run(Date.now()); } catch (_) {}
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expire < Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      db.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`)
        .run(sid, JSON.stringify(sess), expiryOf(sess));
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    try { db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expiryOf(sess), sid); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
