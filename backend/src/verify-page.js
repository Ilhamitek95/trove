'use strict';
/**
 * The 'Confirm your email' page behind the welcome email's link (F200).
 * Opening the link changes nothing — mail scanners open every link — so the
 * page asks for one press of a button, whose POST confirms the address
 * (routes/auth.routes.js). Self-contained: brand colours from the palette,
 * the brand fonts, no script. In the account's language (users.lang).
 */
const i18n = require('./i18n');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render({ lang = 'en', token, email }) {
  const ar = lang === 'ar';
  const T = (k, v) => i18n.t(lang, k, v);
  const sans = ar ? "'IBM Plex Sans Arabic',Quicksand,Tahoma,Arial,sans-serif" : "Quicksand,'Segoe UI',Helvetica,Arial,sans-serif";
  const serif = ar ? "'Noto Naskh Arabic',Cormorant,Georgia,serif" : "Cormorant,Georgia,'Times New Roman',serif";
  const fonts = `https://fonts.googleapis.com/css2?family=Cormorant:wght@500;600&family=Quicksand:wght@500;700${ar ? '&family=IBM+Plex+Sans+Arabic:wght@400;500;700&family=Noto+Naskh+Arabic:wght@500;600' : ''}&display=swap`;
  const home = ar ? '/ar' : '/';
  return `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}"${ar ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(T('Confirm your email'))} · Trove</title>
<link rel="icon" href="/favicon.ico">
<link href="${fonts}" rel="stylesheet">
<style>
  :root{--cream:#FDF7F5;--ink:#292727;--muted:#646161;--line:#EFE5E0}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--cream);color:var(--ink);font-family:${sans};display:flex;align-items:center;justify-content:center;padding:24px 16px}
  main{width:100%;max-width:440px;background:#fff;border:1px solid var(--line);border-radius:20px;padding:34px 28px;text-align:center}
  .mark{display:inline-block;font-family:Cormorant,Georgia,serif;font-size:32px;font-weight:600;color:var(--ink);text-decoration:none;margin-bottom:14px}
  .mark span{color:#F19A82}
  h1{font-family:${serif};font-weight:500;font-size:32px;line-height:${ar ? 1.4 : 1.15};margin:0 0 12px}
  p{font-size:15px;line-height:${ar ? 1.85 : 1.65};margin:0 0 14px;overflow-wrap:anywhere}
  .note{font-size:13.5px;color:var(--muted);margin:18px 0 0}
  button{margin-top:10px;background:var(--ink);color:var(--cream);border:0;border-radius:999px;padding:14px 32px;font:700 15px ${sans};cursor:pointer}
  button:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
</style></head>
<body><main>
  <a class="mark" href="${home}" dir="ltr">trove<span>.</span></a>
  <h1>${esc(T('Confirm your email'))}</h1>
  <p>${esc(T('Press the button to confirm {email} for your Trove account.', { email: ar ? i18n.iso('ar', email) : email }))}</p>
  <form method="post" action="/api/auth/verify-email">
    <input type="hidden" name="token" value="${esc(token)}">
    <button type="submit">${esc(T('Confirm my email'))}</button>
  </form>
  <p class="note">${esc(T("Didn't create a Trove account? Close this page — nothing changes."))}</p>
</main></body></html>`;
}

module.exports = { render };
