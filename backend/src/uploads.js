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

/**
 * Check a data-URL image (and its optional small copy) exactly as
 * saveDataUrl would, without writing anything — so a save can refuse a bad
 * photo before it changes a single field (F244). Throws {status,message}.
 */
function checkDataUrl(dataUrl, opts = {}) {
  decodeImage(dataUrl, MAX_BYTES, 'Image must be under 4MB');
  if (opts.small) decodeImage(opts.small, SMALL_MAX_BYTES, 'The small copy of the image is too large');
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

/** Throws {status, message} unless `dataUrl` is a real, reasonably sized image — checks only, writes nothing. */
function validateImage(dataUrl) {
  decodeImage(dataUrl, MAX_BYTES, 'Image must be under 4MB');
}

/*
 * Private images streamed through an authenticated route (return photos,
 * F227): saved under PRIVATE_DIR/<folder>/ and referred to by a marker
 * 'private:<folder>/<file>' instead of a public /uploads address.
 */
const privateRoot = () => process.env.PRIVATE_DIR || path.join(UPLOADS_DIR, '..', 'private');
function savePrivateImage(dataUrl, folder, baseName) {
  const { buf, type } = decodeImage(dataUrl, MAX_BYTES, 'Image must be under 4MB');
  const dir = path.join(privateRoot(), folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${type.ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `private:${folder}/${file}`;
}
/** The file behind a 'private:<folder>/<file>' marker, or null (never outside the private root). */
function privateImagePath(marker) {
  const m = /^private:([a-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(String(marker || ''));
  if (!m || m[2].includes('..')) return null;
  const file = path.resolve(privateRoot(), m[1], m[2]);
  return fs.existsSync(file) ? file : null;
}

/** Delete a previously saved upload (and its small copy) by its public URL
 *  path — or a private image by its marker (best-effort). */
function removeByUrl(url) {
  if (String(url || '').startsWith('private:')) {
    const file = privateImagePath(url);
    if (file) { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } }
    return;
  }
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

/** The image type of a decoded file from its first bytes (e.g. a decrypted licence scan), or null. */
function sniffImageType(buf) {
  for (const [mime, t] of Object.entries(TYPES)) if (buf && buf.length > 12 && t.magic(buf)) return mime;
  return null;
}

module.exports = { UPLOADS_DIR, saveDataUrl, checkDataUrl, removeByUrl, smallOf, SMALL_WIDTH, savePrivateDataUrl,
  saveEncryptedPrivate, readEncryptedPrivate, removeEncryptedPrivate, sniffImageType, validateImage, savePrivateImage, privateImagePath };
