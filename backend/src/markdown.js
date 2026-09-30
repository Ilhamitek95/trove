'use strict';
/**
 * A deliberately tiny Markdown renderer for Trove's own documents (the legal
 * files in backend/legal and the help pages in src/pages). It is not a
 * general Markdown engine and never sees text a visitor wrote: it handles the
 * handful of shapes those files use, and escapes everything else.
 *
 *   # Title            skipped (the page template prints the H1)
 *   ## Heading         <h2 id="slug">
 *   ### Heading        <h3 id="slug">
 *   - bullet           <ul><li>  (wrapped lines rejoin their bullet)
 *   1. step            <ol><li>
 *   **bold**           <strong>
 *   [text](/path)      <a href>  (site paths, https and mailto only)
 *   {#anchor}          at the end of a heading, sets its id
 *
 * Blocks are separated by blank lines, so bold text that wraps across source
 * lines still renders.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (s) => String(s).toLowerCase()
  .replace(/\*\*/g, '').replace(/&[a-z]+;/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const SAFE_HREF = /^(\/(?!\/)|#|https:\/\/|mailto:)/;

function inline(text) {
  let out = esc(text);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const raw = href.replace(/&amp;/g, '&');
    if (!SAFE_HREF.test(raw)) return label;
    return `<a href="${esc(raw)}">${label}</a>`;
  });
  return out.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
}

function heading(level, text) {
  let t = text.replace(/\s+/g, ' ').trim();
  let id = '';
  const m = t.match(/\s*\{#([a-z0-9-]+)\}$/);
  if (m) { id = m[1]; t = t.slice(0, m.index).trim(); }
  return `<h${level} id="${id || slug(t)}">${inline(t)}</h${level}>`;
}

function listItems(text, marker) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (marker.test(t)) items.push(t.replace(marker, ''));
    else if (items.length) items[items.length - 1] += ' ' + t;
    else items.push(t);
  }
  return items.map((i) => `<li>${inline(i)}</li>`).join('');
}

/** Markdown source → HTML string. */
function toHtml(src) {
  const out = [];
  for (const block of String(src).split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (!text) continue;
    if (/^# /.test(text)) continue;
    if (/^### /.test(text)) { out.push(heading(3, text.slice(4))); continue; }
    if (/^## /.test(text)) { out.push(heading(2, text.slice(3))); continue; }
    if (/^- /.test(text)) { out.push(`<ul>${listItems(text, /^- /)}</ul>`); continue; }
    if (/^\d+\. /.test(text)) { out.push(`<ol>${listItems(text, /^\d+\. /)}</ol>`); continue; }
    out.push(`<p>${inline(text.replace(/\s+/g, ' '))}</p>`);
  }
  return out.join('\n');
}

/** Markdown source → plain text (links keep their address), for llms-full.txt and JSON-LD. */
function toText(src, base = '') {
  return String(src)
    .replace(/\s*\{#[a-z0-9-]+\}/g, '')
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => `${label} (${href.startsWith('/') ? base + href : href})`);
}

/** One paragraph of Markdown → plain text on one line. */
const plain = (src, base) => toText(src, base).replace(/\s+/g, ' ').trim();

module.exports = { toHtml, toText, plain, esc, slug };
