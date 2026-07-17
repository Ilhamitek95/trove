'use strict';
/**
 * UAE mobile numbers are the only phone identity Trove accepts — the
 * marketplace serves Dubai & Abu Dhabi only. Accepts what people actually
 * type (050 123 4567, +971 50 123 4567, 971501234567, 50-123-4567) and
 * returns the canonical +9715XXXXXXXX, or null when it isn't a UAE mobile.
 */
function normalizeUAEMobile(raw) {
  let d = String(raw || '').trim().replace(/[\s().-]/g, '');
  if (d.startsWith('+971')) d = d.slice(4);
  else if (d.startsWith('971')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^5\d{8}$/.test(d)) return null;
  return '+971' + d;
}

module.exports = { normalizeUAEMobile };
