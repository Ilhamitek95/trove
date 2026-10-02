'use strict';
/**
 * One CSV cell for files the owner opens in a spreadsheet (the maker
 * settlement file, the provider transfer file, the VAT export).
 *
 * Quoting alone does not stop Excel / LibreOffice / Google Sheets from
 * evaluating a cell that starts with = + - @ (or a tab / carriage return that
 * hides one), so a shop called =HYPERLINK(...) could turn into a live link
 * carrying another row's IBAN. Such a value gets a leading apostrophe — the
 * spreadsheet then shows it as plain text — and every cell is quoted.
 * Numbers we format ourselves (amounts) are passed as numbers and left as is.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(v) {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** True when a typed value would start a spreadsheet formula. */
const startsLikeFormula = (v) => FORMULA_START.test(String(v ?? '').trim());

module.exports = { csvCell, startsLikeFormula, FORMULA_START };
