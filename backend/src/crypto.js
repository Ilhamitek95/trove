'use strict';
/**
 * Supplier bank-detail encryption (AES-256-GCM).
 *
 * PAYOUT_ENC_KEY = 64 hex chars (32 bytes). Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * IBANs are stored encrypted (base64 of iv|authTag|ciphertext) and decrypted
 * in exactly one place: the settlement CSV export. Everywhere else shows
 * iban_masked. Endpoints that need the key 503 with a clear message when it
 * is missing, mirroring requireStripe().
 */
const nodeCrypto = require('crypto');

function keyBuf() {
  const hex = process.env.PAYOUT_ENC_KEY || '';
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

const hasKey = () => !!keyBuf();

function requireKey() {
  const k = keyBuf();
  if (!k) {
    const e = new Error('Payout encryption is not configured. Set PAYOUT_ENC_KEY (64 hex chars) in the environment.');
    e.status = 503;
    throw e;
  }
  return k;
}

function encrypt(text) {
  const k = requireKey();
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  const k = requireKey();
  const raw = Buffer.from(String(blob), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// Binary variants for encrypted files (Emirates ID images): same AES-256-GCM
// envelope as encrypt/decrypt, but buffer in / buffer out, no base64 step.
function encryptBuffer(buf) {
  const k = requireKey();
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(raw) {
  const k = requireKey();
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// 'AE07 0331 2345 6789 0123 456' → 'AE·· ···· 3456' — country code + last 4.
function maskIban(iban) {
  const clean = String(iban).replace(/\s+/g, '').toUpperCase();
  if (clean.length < 6) return '····';
  return `${clean.slice(0, 2)}·· ···· ${clean.slice(-4)}`;
}

const sha256 = (text) => nodeCrypto.createHash('sha256').update(text).digest('hex');

module.exports = { hasKey, encrypt, decrypt, encryptBuffer, decryptBuffer, maskIban, sha256 };
