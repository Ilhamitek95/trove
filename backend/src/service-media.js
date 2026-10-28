'use strict';
/**
 * Photos and videos on a service (owner, 28 Oct 2026): up to MAX_ITEMS per
 * service, at most MAX_VIDEOS of them videos, shown as a carousel on the
 * service page. The first item is the cover on the service cards.
 *
 * Photos are stored like product photos (uploads.js, folder 'services'):
 * base64 data URLs in the save, a 480 px small copy beside each.
 *
 * Videos are far too big for the JSON body and the 1 GB Render disk, so they
 * live in their own Cloudflare R2 bucket. The browser asks for a short-lived
 * signed PUT address (presignPut), sends the file straight to R2, and the
 * save then names the object's key. The save checks the object is really
 * there, is this provider's, and is a video under the size cap before it is
 * kept. Uploads never attached to a save are swept after a day (sweepPending).
 * Each video has a poster frame the browser grabs from it, stored as a photo.
 *
 * Switched on by environment variables (all five required; without them the
 * dashboard offers photos only):
 *   MEDIA_S3_ENDPOINT    https://<account id>.r2.cloudflarestorage.com
 *   MEDIA_S3_BUCKET      e.g. trove-media
 *   MEDIA_S3_KEY_ID      access key of an API token limited to that bucket
 *   MEDIA_S3_SECRET      its secret
 *   MEDIA_PUBLIC_URL     where the bucket is publicly readable, e.g. https://pub-….r2.dev
 * The bucket needs a CORS rule allowing PUT with Content-Type from the site.
 *
 * Stored in services.media (JSON):
 *   { type: 'image', url: '/uploads/services/…' }
 *   { type: 'video', key: 'services/<provider>/…', url: '<public>/<key>', poster: '/uploads/services/…' }
 */
const crypto = require('crypto');
const db = require('./db');
const uploads = require('./uploads');
const offsite = require('./offsite-backup');

const MAX_ITEMS = 8;
const MAX_VIDEOS = 2;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_MAX_SECONDS = 60;
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const PUT_EXPIRES = 15 * 60; // seconds a signed upload address stays valid
const PENDING_PER_DAY = 20;  // signed upload addresses per provider per day
const FOLDER = 'services';

const NEED = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_KEY_ID', 'MEDIA_S3_SECRET', 'MEDIA_PUBLIC_URL'];
/** The video store's settings, or null when any is missing (shaped for offsite-backup.s3). */
function config(env = process.env) {
  if (NEED.some((k) => !String(env[k] || '').trim())) return null;
  return {
    endpoint: new URL(String(env.MEDIA_S3_ENDPOINT).trim()),
    bucket: String(env.MEDIA_S3_BUCKET).trim(),
    keyId: String(env.MEDIA_S3_KEY_ID).trim(),
    secret: String(env.MEDIA_S3_SECRET).trim(),
    region: String(env.MEDIA_S3_REGION || 'auto').trim(),
    publicUrl: String(env.MEDIA_PUBLIC_URL).trim().replace(/\/+$/, ''),
  };
}
const videoEnabled = () => !!config();
/** The origins the CSP must allow: the upload endpoint (connect-src) and the public host (media-src). */
function origins(env = process.env) {
  const c = config(env);
  return c ? { upload: c.endpoint.origin, media: new URL(c.publicUrl).origin } : null;
}

/** What the dashboard needs to know. */
const limits = () => ({
  maxItems: MAX_ITEMS, maxVideos: MAX_VIDEOS, video: videoEnabled(),
  videoMaxMb: VIDEO_MAX_BYTES / (1024 * 1024), videoMaxSeconds: VIDEO_MAX_SECONDS,
});

/* ---------------- signed upload address (SigV4, query string) ---------------- */

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A PUT address for `key` that only accepts this Content-Type, valid `expires` seconds. */
function presignPut(cfg, key, contentType, expires = PUT_EXPIRES, now = new Date()) {
  const base = cfg.endpoint.pathname.replace(/\/+$/, '');
  const uriPath = `${base}/${enc(cfg.bucket)}/${key.split('/').map(enc).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const host = cfg.endpoint.host;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.keyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'content-type;host',
  };
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = ['PUT', uriPath, qs, `content-type:${contentType}\nhost:${host}\n`, 'content-type;host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, day), cfg.region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  return `${cfg.endpoint.origin}${uriPath}?${qs}&X-Amz-Signature=${sig}`;
}

const err = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * POST /api/provider/media/video: a signed address for one new video.
 * Throws {status, message}. Returns { key, uploadUrl, contentType, url }.
 */
function startVideoUpload(providerId, { contentType, size } = {}) {
  const cfg = config();
  if (!cfg) throw err('Video uploads aren’t switched on yet', 503);
  const ext = VIDEO_TYPES[String(contentType || '')];
  if (!ext) throw err('Upload an MP4, MOV or WebM video');
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) throw err('Upload an MP4, MOV or WebM video');
  if (bytes > VIDEO_MAX_BYTES) throw err(`Videos must be under ${VIDEO_MAX_BYTES / (1024 * 1024)} MB`);
  const today = db.prepare("SELECT COUNT(*) n FROM service_media_uploads WHERE provider_id=? AND created_at > datetime('now','-1 day')").get(providerId).n;
  if (today >= PENDING_PER_DAY) throw err('That’s a lot of videos for one day — try again tomorrow', 429);
  const key = `${FOLDER}/${providerId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  db.prepare('INSERT INTO service_media_uploads (provider_id, key, content_type) VALUES (?,?,?)').run(providerId, key, contentType);
  return { key, uploadUrl: presignPut(cfg, key, contentType), contentType, url: `${cfg.publicUrl}/${key}` };
}

/** The object behind a key, if it is in the bucket: { size, type } or null. */
async function headVideo(cfg, key) {
  const r = await offsite.s3(cfg, { method: 'HEAD', key, allow404: true });
  if (r.status === 404) return null;
  return { size: Number(r.headers['content-length'] || 0), type: String(r.headers['content-type'] || '') };
}
async function removeVideo(key) {
  const cfg = config();
  if (!cfg || !key) return;
  try { await offsite.s3(cfg, { method: 'DELETE', key, allow404: true }); } catch (e) { console.warn(`service video ${key}: delete failed (${e.message})`); }
  db.prepare('DELETE FROM service_media_uploads WHERE key=?').run(key);
}

/* ---------------- the media list on a save ---------------- */

const parse = (text) => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
const isDataUrl = (s) => typeof s === 'string' && s.startsWith('data:');
const ownUpload = (s) => typeof s === 'string' && s.startsWith(`/uploads/${FOLDER}/`);

/**
 * Check a save's `media` list against what the service already has, before
 * anything is written (F244: a bad item refuses the whole save). Async: a new
 * video is looked up in the bucket. Returns { error, status } or { plan }.
 *
 * Each incoming item is one of
 *   { type: 'image', src: <data URL> | <kept /uploads URL>, small?: <data URL> }
 *   { type: 'video', key, poster: <data URL> | <kept /uploads URL>, posterSmall?: <data URL> }
 */
async function check(providerId, incoming, existingText) {
  if (!Array.isArray(incoming)) return { error: 'media must be a list' };
  if (incoming.length > MAX_ITEMS) return { error: `Up to ${MAX_ITEMS} photos and videos per service` };
  const existing = parse(existingText);
  const keptImages = new Set(existing.filter((m) => m.type === 'image').map((m) => m.url));
  const keptVideos = new Map(existing.filter((m) => m.type === 'video').map((m) => [m.key, m]));
  const plan = [];
  let videos = 0;
  const seen = new Set();
  for (const it of incoming) {
    const type = it && it.type;
    if (type === 'image') {
      const src = it.src;
      if (ownUpload(src)) {
        if (!keptImages.has(src) || seen.has(src)) return { error: 'That photo isn’t on this service' };
        seen.add(src);
        plan.push({ type, keep: src });
      } else if (isDataUrl(src)) {
        try { uploads.checkDataUrl(src, { small: isDataUrl(it.small) ? it.small : null }); } catch (e) { return { error: e.message }; }
        plan.push({ type, data: src, small: isDataUrl(it.small) ? it.small : null });
      } else return { error: 'Upload a JPG, PNG or WebP image' };
    } else if (type === 'video') {
      videos += 1;
      if (videos > MAX_VIDEOS) return { error: `Up to ${MAX_VIDEOS} videos per service` };
      const key = String(it.key || '');
      if (seen.has(key)) return { error: 'That video is in the list twice' };
      seen.add(key);
      const old = keptVideos.get(key);
      let poster;
      if (ownUpload(it.poster) && old && old.poster === it.poster) poster = { keep: it.poster };
      else if (isDataUrl(it.poster)) {
        try { uploads.checkDataUrl(it.poster, { small: isDataUrl(it.posterSmall) ? it.posterSmall : null }); } catch (e) { return { error: e.message }; }
        poster = { data: it.poster, small: isDataUrl(it.posterSmall) ? it.posterSmall : null };
      } else return { error: 'Each video needs a cover frame' };
      if (old) { plan.push({ type, key, url: old.url, poster, oldPoster: old.poster }); continue; }
      // A new video: it must be this provider's own upload, really in the bucket, and small enough.
      const cfg = config();
      if (!cfg) return { error: 'Video uploads aren’t switched on yet', status: 503 };
      const row = db.prepare('SELECT * FROM service_media_uploads WHERE key=? AND provider_id=?').get(key, providerId);
      if (!row) return { error: 'That video upload wasn’t found — add it again' };
      let head;
      try { head = await headVideo(cfg, key); } catch (e) { return { error: 'Couldn’t reach video storage — try again in a moment', status: 502 }; }
      if (!head) return { error: 'That video didn’t finish uploading — add it again' };
      if (head.size > VIDEO_MAX_BYTES) { await removeVideo(key); return { error: `Videos must be under ${VIDEO_MAX_BYTES / (1024 * 1024)} MB` }; }
      if (!VIDEO_TYPES[head.type.split(';')[0].trim()]) { await removeVideo(key); return { error: 'Upload an MP4, MOV or WebM video' }; }
      plan.push({ type, key, url: `${cfg.publicUrl}/${key}`, poster, fresh: true });
    } else return { error: 'Each item must be a photo or a video' };
  }
  return { plan };
}

/**
 * Write a checked plan (inside the caller's transaction): new photo files,
 * the media column, the video uploads marked as attached. If a file can't be
 * written, the ones written here are removed and the error is thrown. Returns
 * what the save dropped, for `cleanup` once the transaction has committed.
 */
function apply(providerId, serviceId, plan, existingText) {
  const saved = [];
  const save = (data, small, i) => { const u = uploads.saveDataUrl(data, FOLDER, `svc-${providerId}-${serviceId}-${i}`, { small }); saved.push(u); return u; };
  const out = [];
  try {
    plan.forEach((p, i) => {
      if (p.type === 'image') out.push({ type: 'image', url: p.keep || save(p.data, p.small, i) });
      else out.push({ type: 'video', key: p.key, url: p.url, poster: p.poster.keep || save(p.poster.data, p.poster.small, i) });
    });
    db.prepare('UPDATE services SET media=? WHERE id=?').run(JSON.stringify(out), serviceId);
    const mark = db.prepare("UPDATE service_media_uploads SET attached_at=COALESCE(attached_at, datetime('now')) WHERE key=?");
    for (const m of out) if (m.type === 'video') mark.run(m.key);
  } catch (e) {
    saved.forEach((u) => uploads.removeByUrl(u));
    throw e;
  }
  const nowFiles = new Set(out.flatMap((m) => (m.type === 'video' ? [m.poster] : [m.url])));
  const nowKeys = new Set(out.filter((m) => m.type === 'video').map((m) => m.key));
  const before = parse(existingText);
  return {
    files: before.flatMap((m) => (m.type === 'video' ? [m.poster] : [m.url])).filter((u) => u && !nowFiles.has(u)),
    keys: before.filter((m) => m.type === 'video' && !nowKeys.has(m.key)).map((m) => m.key),
  };
}

/** Everything a service's media column points at, as a `dropped` for cleanup (a deleted service). */
function all(mediaText) {
  const list = parse(mediaText);
  return {
    files: list.flatMap((m) => (m.type === 'video' ? [m.poster] : [m.url])).filter(Boolean),
    keys: list.filter((m) => m.type === 'video').map((m) => m.key),
  };
}

/** Delete dropped photos now and dropped videos in the background. */
function cleanup(dropped) {
  if (!dropped) return;
  (dropped.files || []).forEach((u) => uploads.removeByUrl(u));
  for (const k of dropped.keys || []) removeVideo(k);
}

/** The public shape: photos get their small copy, videos their poster. Never the bucket key. */
function publicMedia(mediaText) {
  return parse(mediaText).map((m) => (m.type === 'video'
    ? { type: 'video', url: m.url, poster: m.poster, thumb: uploads.smallOf(m.poster) || m.poster }
    : { type: 'image', url: m.url, thumb: uploads.smallOf(m.url) || m.url }));
}
/** The dashboard's shape: the public one plus the video key a save sends back. */
function ownerMedia(mediaText) {
  return parse(mediaText).map((m) => (m.type === 'video'
    ? { type: 'video', key: m.key, url: m.url, poster: m.poster, thumb: uploads.smallOf(m.poster) || m.poster }
    : { type: 'image', url: m.url, thumb: uploads.smallOf(m.url) || m.url }));
}

/** Hourly: videos uploaded but never saved onto a service, after a day. */
async function sweepPending() {
  const rows = db.prepare("SELECT key FROM service_media_uploads WHERE attached_at IS NULL AND created_at < datetime('now','-1 day') LIMIT 200").all();
  for (const r of rows) await removeVideo(r.key);
  return rows.length;
}

module.exports = {
  MAX_ITEMS, MAX_VIDEOS, VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS, VIDEO_TYPES, FOLDER,
  config, videoEnabled, origins, limits, presignPut, startVideoUpload,
  check, apply, all, cleanup, publicMedia, ownerMedia, sweepPending,
};
