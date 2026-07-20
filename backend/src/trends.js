'use strict';
/**
 * Shopper search trends. The storefront reports every search (and every tag
 * tap, which runs a search) to POST /api/search-log; server-side ?q= lookups
 * are logged too. No user or session ids are stored — just the query text.
 * The AI tag writer reads the top recent terms so its suggestions follow
 * what shoppers are actually typing.
 */
const db = require('./db');

function cleanQuery(q) {
  return String(q == null ? '' : q).toLowerCase()
    .replace(/[^\p{L}\p{N}&' -]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 60).trim();
}

function logSearch(q, results) {
  const term = cleanQuery(q);
  if (!term) return false;
  const n = Math.max(0, Math.min(9999, parseInt(results) || 0));
  db.prepare('INSERT INTO search_log (q, results) VALUES (?,?)').run(term, n);
  return true;
}

/** Most-typed searches over the trailing window, e.g. [{ q, n, avgResults }]. */
function topSearchTerms(days = 30, limit = 25) {
  return db.prepare(`
    SELECT q, COUNT(*) AS n, ROUND(AVG(results), 1) AS avgResults
    FROM search_log
    WHERE created_at > datetime('now', ?)
    GROUP BY q ORDER BY n DESC, MAX(created_at) DESC
    LIMIT ?`).all(`-${Math.max(1, days)} days`, Math.max(1, limit));
}

/** Searches worth recommending publicly: typed often AND still finding pieces.
 * Every candidate is re-checked against the live catalogue at serve time
 * (same match as the public ?q= search), so stale terms and fabricated
 * beacon counts can never surface junk to shoppers. */
function popularSearches(days = 30, limit = 6) {
  const candidates = db.prepare(`
    SELECT q FROM search_log
    WHERE created_at > datetime('now', ?) AND LENGTH(q) >= 3
    GROUP BY q HAVING MAX(results) > 0
    ORDER BY COUNT(*) DESC, MAX(created_at) DESC
    LIMIT 40`).all(`-${Math.max(1, days)} days`).map((r) => r.q);
  const hits = db.prepare(`
    SELECT COUNT(*) AS c FROM products p JOIN shops s ON s.id = p.shop_id
    WHERE p.status = 'live' AND s.status = 'approved'
      AND (p.name LIKE ? OR p.category LIKE ? OR s.name LIKE ? OR p.tags LIKE ?)`);
  const out = [];
  for (const q of candidates) {
    const like = `%${q}%`;
    if (hits.get(like, like, like, like).c > 0) out.push(q);
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

/** Trends are a rolling signal — anything older than 90 days is noise. */
function purgeOld() {
  return db.prepare("DELETE FROM search_log WHERE created_at < datetime('now','-90 days')").run().changes;
}

module.exports = { logSearch, topSearchTerms, popularSearches, purgeOld, cleanQuery };
