'use strict';
/**
 * Trade licence scans encrypted at rest, like Emirates ID photos (F259).
 *
 * Licence images used to be plain files under PRIVATE_DIR/licenses, stored as
 * an ABSOLUTE path in shops.license_image. New uploads are now AES-256-GCM
 * encrypted with PAYOUT_ENC_KEY (uploads.saveEncryptedPrivate) and stored as
 * a path RELATIVE to the private root ending in .enc. This sweep converts
 * the existing plain files the same way and rewrites the column:
 *
 *   - only when the key is configured (without it there is nothing to
 *     encrypt with, and the admin route keeps serving the plain file);
 *   - one shop at a time: a file that is missing, outside the private root
 *     or not a real image is left exactly as it is;
 *   - the plain files are deleted only after the migration transaction has
 *     committed (ctx.afterCommit), so neither a failure part-way nor a later
 *     migration rolling the boot back can leave a row pointing at a deleted
 *     file.
 *
 * GET /api/admin/shops/:id/license-image reads both forms, never cached.
 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: '026-C-licence-encryption',
  up(db, ctx) {
    const crypto = require('../crypto');
    if (!crypto.hasKey()) return;
    const uploads = require('../uploads');
    const root = path.resolve(process.env.PRIVATE_DIR || path.join(uploads.UPLOADS_DIR, '..', 'private'));
    const rows = db.prepare("SELECT id, license_image FROM shops WHERE license_image IS NOT NULL AND license_image <> ''").all();
    const plainFiles = [];
    for (const r of rows) {
      const file = String(r.license_image);
      if (!path.isAbsolute(file) || file.endsWith('.enc')) continue; // already encrypted (relative .enc)
      const abs = path.resolve(file);
      let written = null;
      try {
        if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) continue;
        const buf = fs.readFileSync(abs);
        if (!uploads.sniffImageType(buf)) continue;
        const rel = path.join('licenses', `${path.basename(abs).replace(/\.[a-z0-9]+$/i, '')}.enc`);
        fs.mkdirSync(path.join(root, 'licenses'), { recursive: true });
        written = path.join(root, rel);
        fs.writeFileSync(written, crypto.encryptBuffer(buf));
        db.prepare('UPDATE shops SET license_image=? WHERE id=?').run(rel, r.id);
        plainFiles.push(abs);
      } catch (e) {
        if (written) { try { fs.unlinkSync(written); } catch (_) { /* never written */ } }
        console.warn(`licence encryption: shop ${r.id} left as it was (${e.message})`);
      }
    }
    const removePlain = () => {
      for (const f of plainFiles) { try { fs.unlinkSync(f); } catch (_) { /* already gone */ } }
      if (plainFiles.length) console.log(`licence encryption: ${plainFiles.length} licence scan(s) encrypted`);
    };
    if (ctx && ctx.afterCommit) ctx.afterCommit(removePlain); else removePlain();
  },
};
