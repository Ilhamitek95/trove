'use strict';
/**
 * Automatic Arabic for what people create (owner, 2026-10-02): pieces,
 * shop stories, provider bios, services, the site content the admin edits,
 * and public reviews. Proper names (shop, maker, provider, buyer) are never
 * translated.
 *
 *   - Each English field is stored with its SHA-256 next to its Arabic
 *     (table `translations`). An Arabic text is shown ONLY while the English
 *     it came from is unchanged; once the source changes the page shows the
 *     English again and the field is re-queued.
 *   - A text the admin hand-edits is `locked`: the machine never overwrites
 *     it (if its English later changes, it shows English and the admin's
 *     Translations list says it needs their update).
 *   - Saving never waits for, or fails because of, a translation: routes
 *     call queue(); a small in-process worker translates in the background,
 *     with an hourly + boot sweep for anything missing.
 *   - Claude API via the official SDK (ANTHROPIC_API_KEY, TRANSLATE_MODEL,
 *     default claude-sonnet-5-5), JSON-schema structured output. No key →
 *     nothing is sent, English is shown, nothing errors.
 *   - Daily budget: TRANSLATE_DAILY_BUDGET_USD (default 5) from the token
 *     counts the API reports (TRANSLATE_PRICE_IN / _OUT per million tokens,
 *     default 2 / 10). Over budget, the queue waits for tomorrow.
 *   - Personal data never leaves: email addresses, phone numbers and URLs
 *     with personal paths are swapped for ⟦n⟧ tokens before the call and put
 *     back after; a translation that loses a token is discarded.
 */
const crypto = require('crypto');
const db = require('./db');

const LANG = 'ar';
const ENTITIES = ['product', 'shop', 'service', 'provider', 'review', 'content'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const parse = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch (_) { return fb; } };

const model = () => process.env.TRANSLATE_MODEL || 'claude-sonnet-5-5';
const budget = () => { const n = Number(process.env.TRANSLATE_DAILY_BUDGET_USD); return Number.isFinite(n) && n >= 0 ? n : 5; };
const priceIn = () => Number(process.env.TRANSLATE_PRICE_IN) || 2;
const priceOut = () => Number(process.env.TRANSLATE_PRICE_OUT) || 10;

let _client = null; // tests inject a fake with _setClient()
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY || process.env.TRANSLATE_DISABLED === '1') return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120000 });
  return _client;
}
const enabled = () => !!client();

/* ---------------- the English sources ---------------- */
const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.trim()));

/** Every translatable English field of one entity: { field: text }, or null if it is not public. */
function sources(entity, id) {
  if (entity === 'product') {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (!p) return null;
    const f = { name: p.name, description: p.description, personalization_prompt: p.personalization_enabled ? p.personalization_prompt : '' };
    parse(p.options, []).forEach((g, i) => {
      if (!g) return;
      f[`options.${i}.name`] = g.name;
      (g.values || []).forEach((v, j) => { f[`options.${i}.values.${j}`] = v; });
    });
    parse(p.extras, []).forEach((e, i) => { if (e) f[`extras.${i}.name`] = e.name; });
    return nonEmpty(f);
  }
  if (entity === 'shop') {
    const s = db.prepare('SELECT bio, location FROM shops WHERE id=?').get(id);
    return s ? nonEmpty({ bio: s.bio, location: s.location }) : null;
  }
  if (entity === 'provider') {
    const p = db.prepare('SELECT bio, location FROM service_providers WHERE id=?').get(id);
    return p ? nonEmpty({ bio: p.bio, location: p.location }) : null;
  }
  if (entity === 'service') {
    const s = db.prepare('SELECT title, description, duration FROM services WHERE id=?').get(id);
    return s ? nonEmpty({ title: s.title, description: s.description, duration: s.duration }) : null;
  }
  if (entity === 'review') {
    const r = db.prepare("SELECT body FROM reviews WHERE id=? AND status='published'").get(id);
    return r ? nonEmpty({ body: r.body }) : null;
  }
  if (entity === 'content') return contentSources(String(id));
  return null;
}

/** Site content: the admin's overrides only, and only fields that differ from the shipped
 *  default (the defaults have hand-written Arabic in docs/i18n/ar/content.json + common.json). */
const CONTENT_SKIP = new Set(['site.company']);
const CONTENT_KEYS_SKIP = new Set(['productIds', 'shopSlugs', 'crops']);
function contentLeaves(value, prefix = '', out = {}) {
  if (typeof value === 'string') { out[prefix] = value; return out; }
  if (Array.isArray(value)) { value.forEach((v, i) => contentLeaves(v, prefix ? `${prefix}.${i}` : String(i), out)); return out; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!CONTENT_KEYS_SKIP.has(k)) contentLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}
function contentSources(section) {
  if (CONTENT_SKIP.has(section)) return null;
  const content = require('./content');
  const ov = content.overrides()[section];
  if (!ov) return {};
  const defaults = contentLeaves(content.DEFAULTS[section] || {});
  const d = require('./i18n').dict('ar', ['content']);
  const out = {};
  for (const [k, v] of Object.entries(contentLeaves(ov))) {
    if (!v.trim()) continue;
    if (defaults[k] === v && typeof d[v] === 'string') continue; // shipped wording: the dictionary has it
    if (typeof d[v] === 'string') continue;                     // any wording the dictionary already knows
    out[k] = v;
  }
  return out;
}

/** Everything public that should have Arabic: [entity, id] pairs. */
function publicEntities() {
  const rows = [];
  for (const r of db.prepare(`SELECT p.id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.status='live' AND s.status='approved'`).all()) rows.push(['product', r.id]);
  for (const r of db.prepare("SELECT id FROM shops WHERE status='approved'").all()) rows.push(['shop', r.id]);
  for (const r of db.prepare("SELECT id FROM service_providers WHERE status='approved'").all()) rows.push(['provider', r.id]);
  for (const r of db.prepare(`SELECT sv.id FROM services sv JOIN service_providers p ON p.id=sv.provider_id WHERE sv.status='live' AND p.status='approved'`).all()) rows.push(['service', r.id]);
  for (const r of db.prepare("SELECT id FROM reviews WHERE status='published' AND TRIM(COALESCE(body,''))<>''").all()) rows.push(['review', r.id]);
  for (const r of db.prepare('SELECT section FROM site_content').all()) if (!CONTENT_SKIP.has(r.section)) rows.push(['content', r.section]);
  return rows;
}

/* ---------------- stored translations ---------------- */
function stored(entity, id) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM translations WHERE entity=? AND entity_id=? AND lang=?').all(entity, String(id), LANG)) out[r.field] = r;
  return out;
}
/** Per field: 'current' | 'stale' | 'missing' | 'locked' | 'locked-stale'. */
function fieldStatus(entity, id) {
  const src = sources(entity, id) || {};
  const have = stored(entity, id);
  const out = {};
  for (const [field, text] of Object.entries(src)) {
    const row = have[field];
    const fresh = row && row.source_hash === sha(text);
    out[field] = { source: text, arabic: row ? row.text : null, locked: !!(row && row.locked), origin: row ? row.origin : null,
      status: !row ? 'missing' : row.locked ? (fresh ? 'locked' : 'locked-stale') : fresh ? 'current' : 'stale', updatedAt: row ? row.updated_at : null };
  }
  return out;
}
/** The fields the machine should (re)translate: missing or stale, never locked. */
function needs(entity, id) {
  return Object.entries(fieldStatus(entity, id)).filter(([, f]) => f.status === 'missing' || f.status === 'stale').map(([k]) => k);
}

/** The Arabic for the current English of these fields ({field: arabic}); a field whose
 *  English changed since it was translated is left out (the page shows the English). */
function current(entity, id, src) {
  const rows = stored(entity, id);
  const out = {};
  for (const [field, text] of Object.entries(src || {})) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const r = rows[field];
    if (r && r.source_hash === sha(text)) out[field] = r.text;
  }
  return out;
}

/* ---------------- the queue ---------------- */
function queue(entity, id) {
  try {
    if (!ENTITIES.includes(entity) || id == null) return;
    db.prepare(`INSERT INTO translation_queue (entity, entity_id, lang) VALUES (?,?,?)
      ON CONFLICT(entity, entity_id, lang) DO UPDATE SET queued_at=datetime('now'), attempts=0, last_error=NULL, next_at=NULL`).run(entity, String(id), LANG);
    kick();
  } catch (e) { console.error('translate: queue failed:', e.message); }
}
let timer = null;
let running = null;
function kick(delay = 1500) {
  if (!enabled() || process.env.TRANSLATE_AUTORUN === '0') return;
  if (timer) return;
  timer = setTimeout(() => { timer = null; drain().catch((e) => console.error('translate: worker failed:', e.message)); }, delay);
  if (timer.unref) timer.unref();
}

function spentToday() { const r = db.prepare('SELECT usd FROM translation_spend WHERE day=?').get(today()); return r ? r.usd : 0; }
function recordSpend(usage) {
  const tin = (usage && (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)) || 0;
  const tout = (usage && usage.output_tokens) || 0;
  const usd = (tin * priceIn() + tout * priceOut()) / 1e6;
  db.prepare(`INSERT INTO translation_spend (day, usd, calls, tokens_in, tokens_out) VALUES (?,?,1,?,?)
    ON CONFLICT(day) DO UPDATE SET usd=usd+excluded.usd, calls=calls+1, tokens_in=tokens_in+excluded.tokens_in, tokens_out=tokens_out+excluded.tokens_out`).run(today(), usd, tin, tout);
  return usd;
}
const overBudget = () => spentToday() >= budget();

/** Work the queue until it is empty, the budget is spent or an item fails. Returns how many items were done. */
async function drain({ max = 200 } = {}) {
  if (running) return running;
  running = (async () => {
    let done = 0;
    while (done < max) {
      if (!enabled()) break;
      if (overBudget()) { console.log(`translate: daily budget of $${budget()} reached — the rest waits for tomorrow`); break; }
      const item = db.prepare(`SELECT * FROM translation_queue WHERE lang=? AND attempts < 5 AND (next_at IS NULL OR next_at <= datetime('now'))
        ORDER BY queued_at LIMIT 1`).get(LANG);
      if (!item) break;
      try {
        await translateEntity(item.entity, item.entity_id);
        db.prepare('DELETE FROM translation_queue WHERE entity=? AND entity_id=? AND lang=?').run(item.entity, item.entity_id, LANG);
      } catch (e) {
        const n = item.attempts + 1;
        db.prepare(`UPDATE translation_queue SET attempts=?, last_error=?, next_at=datetime('now', ?) WHERE entity=? AND entity_id=? AND lang=?`)
          .run(n, String(e.message || e).slice(0, 300), `+${Math.min(240, 5 * 2 ** n)} minutes`, item.entity, item.entity_id, LANG);
        console.error(`translate: ${item.entity} ${item.entity_id} failed (${n}/5): ${e.message}`);
      }
      done += 1;
    }
    return done;
  })();
  try { return await running; } finally { running = null; }
}

/** Queue every public entity that has a missing or stale field. Returns the count queued. */
function sweep() {
  let n = 0;
  try {
    for (const [entity, id] of publicEntities()) {
      if (needs(entity, id).length) {
        db.prepare(`INSERT INTO translation_queue (entity, entity_id, lang) VALUES (?,?,?)
          ON CONFLICT(entity, entity_id, lang) DO NOTHING`).run(entity, String(id), LANG);
        n += 1;
      }
    }
  } catch (e) { console.error('translate: sweep failed:', e.message); }
  if (n) kick(500);
  return n;
}

/** server.js: a sweep shortly after boot, then every hour. */
function start() {
  if (process.env.CRON_DISABLED === '1' || process.env.NODE_ENV === 'test') return;
  if (!enabled()) { console.log('translate: no ANTHROPIC_API_KEY — Arabic pages show English for what people write until it is set'); return; }
  const t = setTimeout(() => sweep(), 20000); if (t.unref) t.unref();
  const h = setInterval(() => sweep(), 60 * 60 * 1000); if (h.unref) h.unref();
}

/* ---------------- personal data stays home ---------------- */
const PII = [
  /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi,                       // email addresses
  /(?:\+|00)?\d[\d\s().-]{6,}\d/g,                                          // phone numbers (7+ digits)
  /\b(?:AE|ae)\d{2}[\s]?(?:\d[\s]?){19}\b/g,                                // IBANs
];
function scrub(text) {
  const kept = [];
  let out = String(text);
  for (const re of PII) {
    out = out.replace(re, (m) => {
      // a price or a measurement ('AED 1,250', '30 x 40 cm', '2026') is not a phone number
      if (re === PII[1] && (m.replace(/\D/g, '').length < 7 || /^\d{1,3}([.,]\d{3})+$/.test(m.trim()))) return m;
      kept.push(m);
      return `⟦${kept.length}⟧`;
    });
  }
  return { text: out, kept };
}
function restore(text, kept) {
  let out = String(text);
  for (let i = 0; i < kept.length; i++) {
    const tok = `⟦${i + 1}⟧`;
    if (!out.includes(tok)) return null; // the model dropped a token: discard rather than lose the detail
    out = out.split(tok).join(kept[i]);
  }
  return out;
}

/* ---------------- the call ---------------- */
const SYSTEM = `You translate content for Trove, a premium curated homeware marketplace in Dubai and Abu Dhabi, from English into Modern Standard Arabic (فصحى) for Gulf readers.
Write natural, elegant, warm Arabic that reads as if it were written in Arabic — never word-for-word. Keep the meaning, facts, numbers and tone exactly; add nothing and leave nothing out.
Rules:
- Keep "Trove" and every proper name of a shop, maker, person, brand or place in its usual form (well-known UAE places in Arabic: دبي، أبوظبي، الشارقة؛ neighbourhoods may be transliterated).
- Western digits (0-9). Keep prices as "AED 120". Keep units (cm, ml, g) as written.
- Keep tokens like ⟦1⟧ exactly as they are, once each.
- Keep the markers * (emphasis) and | (line break) where they are in the source, around the matching Arabic words.
- Short labels (option names and values such as colours and sizes, extras) stay short labels.
- No italics, no quotation marks that are not in the source, no notes or explanations.
Return JSON: {"translations": {"<field>": "<Arabic>"}} with exactly the fields you were given.`;

async function callModel(fields, context) {
  const c = client();
  if (!c) throw new Error('translation is switched off (no ANTHROPIC_API_KEY)');
  const keys = Object.keys(fields);
  const schema = {
    type: 'object',
    properties: { translations: { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])), required: keys, additionalProperties: false } },
    required: ['translations'],
    additionalProperties: false,
  };
  const res = await c.messages.create({
    model: model(),
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: `What this is: ${context}\n\nFields to translate (JSON):\n${JSON.stringify(fields, null, 1)}` }],
  });
  recordSpend(res.usage);
  if (res.stop_reason === 'refusal') throw new Error('the model declined to translate this');
  if (res.stop_reason === 'max_tokens') throw new Error('the translation was cut off');
  const block = (res.content || []).find((b) => b.type === 'text');
  const data = parse(block && block.text, null);
  if (!data || !data.translations || typeof data.translations !== 'object') throw new Error('the reply was not the expected JSON');
  return data.translations;
}

const CONTEXT = {
  product: 'a handmade or designed homeware piece for sale: its name, description, option names/values, paid extras and the personalisation prompt',
  shop: "a maker's shop: the shop story/bio and its area",
  provider: "a services provider's public bio and area",
  service: 'a creative service listed on the Services Marketplace: title, description, duration',
  review: "a buyer's public review of a piece or shop",
  content: 'website copy edited by the Trove team (headings, short marketing text, FAQs)',
};

/** Translate the missing/stale fields of one entity and store them. Returns the fields written. */
async function translateEntity(entity, id) {
  const want = needs(entity, id);
  if (!want.length) return [];
  const src = sources(entity, id) || {};
  const send = {};
  const keep = {};
  for (const f of want) { const s = scrub(src[f]); send[f] = s.text; keep[f] = s.kept; }
  const out = await callModel(send, CONTEXT[entity] || entity);
  const written = [];
  const put = db.prepare(`INSERT INTO translations (entity, entity_id, field, lang, text, source_hash, source_text, locked, origin, model, updated_at)
    VALUES (?,?,?,?,?,?,?,0,'machine',?,datetime('now'))
    ON CONFLICT(entity, entity_id, field, lang) DO UPDATE SET text=excluded.text, source_hash=excluded.source_hash, source_text=excluded.source_text,
      origin='machine', model=excluded.model, updated_at=excluded.updated_at WHERE translations.locked=0`);
  db.transaction(() => {
    for (const f of want) {
      const raw = out[f];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const text = restore(raw.trim(), keep[f]);
      if (text == null) continue;
      if (put.run(entity, String(id), f, LANG, text, sha(src[f]), src[f], model()).changes) written.push(f);
    }
  })();
  return written;
}

/* ---------------- admin: hand edits ---------------- */
/** Save the admin's own Arabic for one field. locked (default true) = the machine never overwrites it. */
function setManual(entity, id, field, text, { locked = true } = {}) {
  const src = (sources(entity, id) || {})[field];
  if (src == null) throw Object.assign(new Error('That field has no English text to translate'), { status: 400 });
  const t = String(text || '').trim();
  if (!t) {
    db.prepare('DELETE FROM translations WHERE entity=? AND entity_id=? AND field=? AND lang=?').run(entity, String(id), field, LANG);
    queue(entity, id);
    return null;
  }
  if (t.length > 6000) throw Object.assign(new Error('That text is too long'), { status: 400 });
  db.prepare(`INSERT INTO translations (entity, entity_id, field, lang, text, source_hash, source_text, locked, origin, model, updated_at)
    VALUES (?,?,?,?,?,?,?,?,'manual',NULL,datetime('now'))
    ON CONFLICT(entity, entity_id, field, lang) DO UPDATE SET text=excluded.text, source_hash=excluded.source_hash, source_text=excluded.source_text,
      locked=excluded.locked, origin='manual', model=NULL, updated_at=excluded.updated_at`)
    .run(entity, String(id), field, LANG, t, sha(src), src, locked ? 1 : 0);
  return { field, text: t, locked: !!locked };
}
function setLocked(entity, id, field, locked) {
  return db.prepare('UPDATE translations SET locked=? WHERE entity=? AND entity_id=? AND field=? AND lang=?').run(locked ? 1 : 0, entity, String(id), field, LANG).changes;
}
/** Throw away the machine's Arabic for an entity (locked texts stay) and translate it again. */
function retranslate(entity, id) {
  db.prepare('DELETE FROM translations WHERE entity=? AND entity_id=? AND lang=? AND locked=0').run(entity, String(id), LANG);
  queue(entity, id);
}

/** A human label for the admin list. */
function label(entity, id) {
  try {
    if (entity === 'product') { const r = db.prepare('SELECT p.name, s.name AS shop FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?').get(id); return r ? `${r.name} · ${r.shop}` : `Piece ${id}`; }
    if (entity === 'shop') { const r = db.prepare('SELECT name FROM shops WHERE id=?').get(id); return r ? r.name : `Shop ${id}`; }
    if (entity === 'provider') { const r = db.prepare('SELECT name FROM service_providers WHERE id=?').get(id); return r ? r.name : `Provider ${id}`; }
    if (entity === 'service') { const r = db.prepare('SELECT sv.title, p.name FROM services sv JOIN service_providers p ON p.id=sv.provider_id WHERE sv.id=?').get(id); return r ? `${r.title} · ${r.name}` : `Service ${id}`; }
    if (entity === 'review') { const r = db.prepare('SELECT r.rating, s.name FROM reviews r JOIN shops s ON s.id=r.shop_id WHERE r.id=?').get(id); return r ? `${r.rating}★ review · ${r.name}` : `Review ${id}`; }
    if (entity === 'content') return `Site content · ${id}`;
  } catch (_) { /* fall through */ }
  return `${entity} ${id}`;
}

/** The admin's Translations list: one row per public entity, with its worst field status. */
function overview() {
  const q = new Map(db.prepare('SELECT * FROM translation_queue WHERE lang=?').all(LANG).map((r) => [`${r.entity}:${r.entity_id}`, r]));
  const RANK = { 'locked-stale': 5, missing: 4, stale: 3, current: 1, locked: 1 };
  const rows = publicEntities().map(([entity, id]) => {
    const fields = fieldStatus(entity, id);
    const list = Object.values(fields);
    const worst = list.reduce((w, f) => (RANK[f.status] > RANK[w] ? f.status : w), 'current');
    const qi = q.get(`${entity}:${id}`);
    return {
      entity, id: String(id), label: label(entity, id), fields: list.length,
      status: !list.length ? 'nothing' : worst === 'locked' ? 'current' : worst,
      locked: list.filter((f) => f.locked).length,
      queued: !!qi, attempts: qi ? qi.attempts : 0, error: qi ? qi.last_error : null,
    };
  });
  const s = db.prepare('SELECT * FROM translation_spend WHERE day=?').get(today()) || { usd: 0, calls: 0 };
  return {
    enabled: enabled(), model: model(), budgetUsd: budget(), spentTodayUsd: Math.round(s.usd * 10000) / 10000, callsToday: s.calls,
    counts: rows.reduce((c, r) => { c[r.status] = (c[r.status] || 0) + 1; return c; }, {}),
    rows,
  };
}

/* ---------------- reading: the Arabic page's data ---------------- */
const isAr = (lang) => lang === 'ar';
function product(p, lang) {
  if (!isAr(lang) || !p) return p;
  const src = { name: p.name, description: p.description, personalization_prompt: p.personalization ? p.personalization.prompt : '' };
  (p.options || []).forEach((g, i) => { src[`options.${i}.name`] = g.name; (g.values || []).forEach((v, j) => { src[`options.${i}.values.${j}`] = v; }); });
  (p.extras || []).forEach((e, i) => { src[`extras.${i}.name`] = e.name; });
  const tr = current('product', p.id, src);
  // nameEn: the English name the storefront still needs for slugs, matched
  // stock photos and analytics item names.
  const out = { ...p, nameEn: p.name };
  if (tr.name) out.name = tr.name;
  if (tr.description) out.description = tr.description;
  if (out.personalization && tr.personalization_prompt) out.personalization = { ...out.personalization, prompt: tr.personalization_prompt };
  // Options and extras keep their English values (they are the keys checkout
  // and variants match on); the page shows the Arabic through these labels.
  const optionLabels = {};
  (p.options || []).forEach((g, i) => {
    if (tr[`options.${i}.name`]) optionLabels[g.name] = tr[`options.${i}.name`];
    (g.values || []).forEach((v, j) => { if (tr[`options.${i}.values.${j}`]) optionLabels[`${g.name}:${v}`] = tr[`options.${i}.values.${j}`]; });
  });
  const extraLabels = {};
  (p.extras || []).forEach((e, i) => { if (tr[`extras.${i}.name`]) extraLabels[e.name] = tr[`extras.${i}.name`]; });
  out.optionLabels = optionLabels;
  out.extraLabels = extraLabels;
  out.translated = !!(tr.name || tr.description);
  if (p.shop) out.shop = shopRef(p.shop, lang);
  return out;
}
function shopRef(s, lang) {
  if (!isAr(lang) || !s || s.id == null) return s;
  const tr = current('shop', s.id, { location: s.location });
  return tr.location ? { ...s, location: tr.location } : s;
}
function shop(s, lang) {
  if (!isAr(lang) || !s) return s;
  const tr = current('shop', s.id, { bio: s.bio, location: s.location });
  return { ...s, ...(tr.bio ? { bio: tr.bio } : {}), ...(tr.location ? { location: tr.location } : {}), translated: !!tr.bio };
}
function providerIdOf(slug) { const r = slug ? db.prepare('SELECT id FROM service_providers WHERE slug=?').get(slug) : null; return r ? r.id : null; }
function provider(p, lang) {
  if (!isAr(lang) || !p) return p;
  const id = p.id != null ? p.id : providerIdOf(p.slug);
  if (id == null) return p;
  const tr = current('provider', id, { bio: p.bio, location: p.location });
  return { ...p, ...(tr.bio ? { bio: tr.bio } : {}), ...(tr.location ? { location: tr.location } : {}), translated: !!tr.bio };
}
function service(s, lang) {
  if (!isAr(lang) || !s) return s;
  const tr = current('service', s.id, { title: s.title, description: s.description, duration: s.duration });
  const out = { ...s, ...(tr.title ? { title: tr.title } : {}), ...(tr.description ? { description: tr.description } : {}), ...(tr.duration ? { duration: tr.duration } : {}), translated: !!(tr.title || tr.description) };
  if (s.provider) out.provider = provider(s.provider, lang);
  return out;
}
function review(r, lang) {
  if (!isAr(lang) || !r) return r;
  const tr = current('review', r.id, { body: r.body });
  return tr.body ? { ...r, body: tr.body, bodyOriginal: r.body, translated: true } : r;
}
const products = (list, lang) => (isAr(lang) ? (list || []).map((p) => product(p, lang)) : list);
const shops = (list, lang) => (isAr(lang) ? (list || []).map((s) => shop(s, lang)) : list);
const providers = (list, lang) => (isAr(lang) ? (list || []).map((p) => provider(p, lang)) : list);
const services = (list, lang) => (isAr(lang) ? (list || []).map((s) => service(s, lang)) : list);
const reviews = (list, lang) => (isAr(lang) ? (list || []).map((r) => review(r, lang)) : list);

/**
 * The public site content (content.getPublic()) in Arabic: every string
 * that is shipped wording comes from the dictionaries; the admin's own
 * wording from its machine/hand translation; anything else stays English.
 */
function siteContent(pub, lang) {
  if (!isAr(lang) || !pub) return pub;
  const d = require('./i18n').dict('ar', ['content']);
  const out = JSON.parse(JSON.stringify(pub));
  for (const [page, secs] of Object.entries(out)) {
    for (const [key, val] of Object.entries(secs || {})) {
      const section = `${page}.${key}`;
      if (CONTENT_SKIP.has(section)) continue;
      const leaves = contentLeaves(val);
      const tr = current('content', section, leaves);
      for (const [path, en] of Object.entries(leaves)) {
        const ar = typeof d[en] === 'string' && d[en] ? d[en] : tr[path];
        if (ar) setPath(secs[key], path, ar);
      }
    }
  }
  return out;
}
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (o == null) return; o = o[parts[i]]; }
  if (o != null) o[parts[parts.length - 1]] = value;
}

/** Arabic search: ids of entities whose current Arabic text contains q. */
function searchIds(entity, q) {
  const like = `%${String(q).replace(/[%_]/g, '')}%`;
  return db.prepare('SELECT DISTINCT entity_id FROM translations WHERE entity=? AND lang=? AND text LIKE ?').all(entity, LANG, like).map((r) => r.entity_id);
}

function _setClient(c) { _client = c; }
function _reset() { if (timer) clearTimeout(timer); timer = null; running = null; }

module.exports = {
  LANG, ENTITIES, sha, enabled, sources, fieldStatus, needs, queue, drain, sweep, start, translateEntity,
  setManual, setLocked, retranslate, overview, label, scrub, restore, spentToday, budget, model, SYSTEM,
  product, products, shop, shops, shopRef, provider, providers, service, services, review, reviews, siteContent, current, searchIds,
  _setClient, _reset,
};
