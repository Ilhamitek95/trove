'use strict';
/**
 * Emails are matched case-insensitively from now on (auth routes lowercase on
 * both register and login), so stored emails must be lowercase too or the
 * account becomes unreachable. Folds existing rows; a row whose lowercased
 * email would collide with another account is left untouched and logged
 * rather than crashing the boot.
 */
module.exports = {
  id: '005-lowercase-emails',
  up(db) {
    const rows = db.prepare("SELECT id, email FROM users WHERE email != lower(email)").all();
    for (const r of rows) {
      const lower = r.email.toLowerCase();
      const clash = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(lower, r.id);
      if (clash) {
        console.warn(`005-lowercase-emails: case-fold collision between users ${r.id} and ${clash.id}, leaving ${r.id} as-is`);
        continue;
      }
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(lower, r.id);
    }
  },
};
