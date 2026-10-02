'use strict';
/**
 * Image uploads — stored as plain files, served from /uploads.
 *
 * Images arrive as base64 data URLs in JSON (no multipart parser needed); the
 * client downsizes them first so payloads stay small. UPLOADS_DIR points at the
 * persistent disk in production (Render) so files survive deploys.
 */
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

const TYPES = {
  'image/jpeg': { ext: 'jpg',  magic: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  'image/png':  { ext: 'png',  magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  'image/webp': { ext: 'webp', magic: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
};
const MAX_BYTES = 4 * 1024 * 1024; // 4MB decoded

/**
 * Save a data-URL image under uploads/<folder>/. Returns the public URL path
 * (e.g. "/uploads/shops/shop-3-1719900000000.jpg"). Throws {status,message}
 * on anything that isn't a real, reasonably-sized image.
 */
function saveDataUrl(dataUrl, folder, baseName, opts = {}) {
  const { buf, type } = decodeImage(dataUrl, MAX_BYTES, 'Image must be under 4MB');
  // The optional small copy is checked BEFORE anything is written.
  const small = opts.small ? decodeImage(opts.small, SMALL_MAX_BYTES, 'The small copy of the image is too large') : null;
  const dir = path.join(UPLOADS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${baseName}-${Date.now()}`;
  const file = `${stem}.${type.ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  const url = `/uploads/${folder}/${file}`;
  if (small) {
    fs.writeFileSync(path.join(dir, `${stem}${SMALL_SUFFIX}.${small.type.ext}`), small.buf);
    smallCache.delete(url);
  }
  return url;
}

function decodeImage(dataUrl, max, tooBig) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) { const e = new Error('Upload a JPG, PNG or WebP image'); e.status = 400; throw e; }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > max) { const e = new Error(tooBig); e.status = 400; throw e; }
  const type = TYPES[m[1]];
  if (!type.magic(buf)) { const e = new Error('That file is not a valid image'); e.status = 400; throw e; }
  return { buf, type };
}

/*
 * Small copies (F131): the browser makes a SMALL_WIDTH-wide copy of a product
 * photo or shop banner before upload (no image library on the server) and it
 * is stored beside the full file as <name>.w480.<ext>. Cards, carousels and
 * basket thumbnails use it; the product page keeps the full photo. smallOf()
 * says whether a photo has one (memoised; uploads without one — older ones —
 * simply keep using the full file).
 */
const SMALL_WIDTH = 480;
const SMALL_SUFFIX = `.w${SMALL_WIDTH}`;
const SMALL_MAX_BYTES = 400 * 1024;
const smallCache = new Map();

function smallPath(url) {
  const m = /^\/uploads\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)\.(jpg|png|webp)$/.exec(String(url || ''));
  if (!m || m[2].endsWith(SMALL_SUFFIX)) return null;
  for (const ext of ['jpg', 'webp', 'png']) {
    const rel = `${m[1]}/${m[2]}${SMALL_SUFFIX}.${ext}`;
    if (fs.existsSync(path.join(UPLOADS_DIR, rel))) return rel;
  }
  return null;
}
/** The public URL of a photo's small copy, or null when it has none. */
function smallOf(url) {
  if (!url || !String(url).startsWith('/uploads/')) return null;
  if (smallCache.has(url)) return smallCache.get(url);
  const rel = smallPath(url);
  const v = rel ? `/uploads/${rel}` : null;
  if (smallCache.size > 20000) smallCache.clear();
  smallCache.set(url, v);
  return v;
}

/** Delete a previously saved upload (and its small copy) by its public URL path (best-effort). */
function removeByUrl(url) {
  if (!url || !String(url).startsWith('/uploads/')) return;
  const small = smallPath(url);
  smallCache.delete(url);
  const rel = String(url).slice('/uploads/'.length).replace(/\.\./g, '');
  try { fs.unlinkSync(path.join(UPLOADS_DIR, rel)); } catch (_) { /* already gone */ }
  if (small) { try { fs.unlinkSync(path.join(UPLOADS_DIR, small)); } catch (_) { /* already gone */ } }
}

/**
 * Like saveDataUrl but into the PRIVATE directory (license images, purchase
 * notes) which is never statically served — these are streamed through
 * authenticated endpoints only. Returns the absolute file path.
 */
function savePrivateDataUrl(dataUrl, folder, baseName) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) { const e = new Error('Upload a JPG, PNG or WebP image'); e.status = 400; throw e; }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) { const e = new Error('Image must be under 4MB'); e.status = 400; throw e; }
  const type = TYPES[m[1]];
  if (!type.magic(buf)) { const e = new Error('That file is not a valid image'); e.status = 400; throw e; }
  const privateRoot = process.env.PRIVATE_DIR || path.join(UPLOADS_DIR, '..', 'private');
  const dir = path.join(privateRoot, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${baseName}-${Date.now()}.${type.ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * Like savePrivateDataUrl, but the file is AES-256-GCM encrypted at rest
 * (Emirates ID images — government documents get the same treatment as
 * IBANs). Returns { file, mime } where `file` is RELATIVE to the private
 * root, safe to store in the DB. Requires PAYOUT_ENC_KEY.
 */
function saveEncryptedPrivate(dataUrl, folder, baseName) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) { const e = new Error('Upload a JPG, PNG or WebP image'); e.status = 400; throw e; }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) { const e = new Error('Image must be under 4MB'); e.status = 400; throw e; }
  const type = TYPES[m[1]];
  if (!type.magic(buf)) { const e = new Error('That file is not a valid image'); e.status = 400; throw e; }
  const privateRoot = process.env.PRIVATE_DIR || path.join(UPLOADS_DIR, '..', 'private');
  const dir = path.join(privateRoot, folder);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join(folder, `${baseName}-${Date.now()}.enc`);
  fs.writeFileSync(path.join(privateRoot, rel), require('./crypto').encryptBuffer(buf));
  return { file: rel, mime: m[1] };
}

/** Read + decrypt a file previously saved by saveEncryptedPrivate. */
function readEncryptedPrivate(relPath) {
  const privateRoot = process.env.PRIVATE_DIR || path.join(UPLOADS_DIR, '..', 'private');
  const safe = String(relPath).replace(/\.\./g, '');
  return require('./crypto').decryptBuffer(fs.readFileSync(path.join(privateRoot, safe)));
}

/** Best-effort delete of an encrypted private file (when replaced). */
function removeEncryptedPrivate(relPath) {
  if (!relPath) return;
  const privateRoot = process.env.PRIVATE_DIR || path.join(UPLOADS_DIR, '..', 'private');
  try { fs.unlinkSync(path.join(privateRoot, String(relPath).replace(/\.\./g, ''))); } catch (_) { /* already gone */ }
}

module.exports = { UPLOADS_DIR, saveDataUrl, removeByUrl, smallOf, SMALL_WIDTH, savePrivateDataUrl,
  saveEncryptedPrivate, readEncryptedPrivate, removeEncryptedPrivate };
