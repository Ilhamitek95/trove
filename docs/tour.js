/* Trove — guided dashboard tour (2026-10-27).
 *
 * A small, dependency-free walkthrough for the maker (/sell) and provider
 * (/provider) dashboards: a spotlight on one element at a time and a card
 * that explains it. The page owns the steps; this file only draws them.
 *
 *   TroveTour.start([{ target, before, title, text, placement }], { onEnd })
 *
 * target    CSS selector, element, or a function returning one. No target,
 *           or one that is not on screen, shows the card in the middle.
 * before    optional (async) function run first, e.g. switching the view.
 * placement 'side' (beside a sidebar item, the inline-end side) or omitted
 *           (below the element, else above). On phones the card always sits
 *           at the bottom of the screen.
 * onEnd(reason, index)  reason = 'done' | 'skip'.
 *
 * `text` is HTML (bold button names, a Help centre link) and must only ever
 * come from the page's own dictionaries — never from anything a user typed.
 * `title` is escaped.
 *
 * Words come from the page's dictionaries (_t), so Arabic pages get Arabic
 * and a right-to-left card. The page underneath can't be clicked while the
 * tour is open (so nobody leaves halfway by accident); Esc closes it.
 */
(function () {
  'use strict';
  const CSS = `
  .tt-block{position:fixed;inset:0;z-index:1000;background:transparent}
  .tt-dim{position:fixed;inset:0;z-index:1001;background:rgba(41,39,39,.55);pointer-events:none}
  .tt-spot{position:fixed;z-index:1001;border-radius:14px;pointer-events:none;box-shadow:0 0 0 2px #FDF7F5,0 0 0 9999px rgba(41,39,39,.55)}
  .tt-card{position:fixed;z-index:1002;width:min(360px,calc(100vw - 32px));box-sizing:border-box;background:var(--paper,#FFFCFA);color:var(--char,#292727);
    border:1px solid rgba(41,39,39,.10);border-radius:18px;padding:20px 22px 18px;box-shadow:0 22px 50px -24px rgba(41,39,39,.45);
    font-family:Quicksand,'Segoe UI',Helvetica,Arial,sans-serif}
  .tt-card:focus{outline:none}
  .tt-count{font-size:12px;font-weight:700;letter-spacing:.06em;color:rgba(41,39,39,.72);margin:0 0 6px}
  .tt-title{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:25px;font-weight:600;line-height:1.15;margin:0 32px 8px 0;text-wrap:balance}
  [dir="rtl"] .tt-title{margin:0 0 8px 32px;line-height:1.4}
  .tt-text{font-size:14.5px;line-height:1.6;margin:0}
  [dir="rtl"] .tt-text{line-height:1.85}
  .tt-text b{font-weight:700}
  .tt-text a{color:inherit;font-weight:700;text-decoration:underline;text-underline-offset:3px}
  .tt-x{position:absolute;top:12px;inset-inline-end:12px;width:34px;height:34px;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer;
    display:flex;align-items:center;justify-content:center}
  .tt-x:hover{background:var(--rose-tint,#F2E9E4)}
  .tt-foot{display:flex;align-items:center;gap:10px;margin-top:18px}
  .tt-skip{margin-inline-end:auto;border:0;background:none;padding:8px 0;font-weight:700;font-size:13px;line-height:1;font-family:inherit;color:rgba(41,39,39,.72);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
  .tt-btn{border-radius:999px;padding:11px 20px;font-weight:700;font-size:14px;line-height:1;font-family:inherit;cursor:pointer;border:1px solid #292727}
  .tt-back{background:transparent;color:#292727}
  .tt-next{background:#292727;color:#FDF7F5}
  .tt-btn:focus-visible,.tt-skip:focus-visible,.tt-x:focus-visible{outline:2px solid #292727;outline-offset:3px}
  .tt-dots{display:flex;gap:5px;margin-top:16px}
  .tt-dots i{width:6px;height:6px;border-radius:6px;background:rgba(41,39,39,.16)}
  .tt-dots i.on{background:#292727;width:16px}
  @media (prefers-reduced-motion:no-preference){
    .tt-spot{transition:top .22s ease,left .22s ease,width .22s ease,height .22s ease}
    .tt-card{animation:tt-in .18s ease}
    @keyframes tt-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  }
  @media (max-width:640px){
    .tt-card{left:12px!important;right:12px!important;top:auto!important;bottom:calc(12px + env(safe-area-inset-bottom,0px))!important;width:auto;padding:18px 18px 16px}
    .tt-title{font-size:22px}
  }`;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tr = (k, v) => (typeof _t === 'function' ? _t(k, v) : k.replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? v[n] : m)));
  const PAD = 6;
  const GAP = 14;
  const phone = () => window.matchMedia('(max-width:640px)').matches;
  const rtl = () => document.documentElement.dir === 'rtl';

  let S = null; // the running tour

  function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function resolve(t) {
    let n = typeof t === 'function' ? t() : typeof t === 'string' ? document.querySelector(t) : t;
    if (!n || !n.getClientRects().length) return null;
    const r = n.getBoundingClientRect();
    return r.width && r.height ? n : null;
  }

  function start(steps, opts) {
    if (S) end('skip');
    if (!document.getElementById('tt-css')) { const st = el('style'); st.id = 'tt-css'; st.textContent = CSS; document.head.appendChild(st); }
    S = { steps: steps.filter(Boolean), i: 0, opts: opts || {}, back: document.activeElement, target: null, raf: 0 };
    S.block = el('div', 'tt-block');
    S.dim = el('div', 'tt-dim');
    S.spot = el('div', 'tt-spot');
    S.card = el('div', 'tt-card');
    S.card.setAttribute('role', 'dialog');
    S.card.setAttribute('aria-modal', 'true');
    S.card.setAttribute('aria-labelledby', 'tt-title');
    S.card.tabIndex = -1;
    document.body.append(S.block, S.dim, S.spot, S.card);
    S.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); end('skip'); }
      else if (e.key === 'Enter' && document.activeElement === S.card) { e.preventDefault(); next(); }
      else if (e.key === (rtl() ? 'ArrowLeft' : 'ArrowRight')) { e.preventDefault(); next(); }
      else if (e.key === (rtl() ? 'ArrowRight' : 'ArrowLeft')) { e.preventDefault(); prev(); }
      else if (e.key === 'Tab') { // keep focus inside the card
        const f = [...S.card.querySelectorAll('button')];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    S.onMove = () => { cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(place); };
    document.addEventListener('keydown', S.onKey, true);
    window.addEventListener('resize', S.onMove);
    document.addEventListener('scroll', S.onMove, true);
    show(0);
  }

  async function show(i) {
    if (!S) return;
    S.i = i;
    const step = S.steps[i];
    const run = S.run = {};
    if (step.before) { try { await step.before(); } catch (_) { /* a view that fails to switch still gets its card */ } }
    if (!S || S.run !== run) return;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    S.target = step.target ? resolve(step.target) : null;
    if (S.target) {
      S.target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    }
    draw(step);
    place();
    // follow a tab bar or page that is still settling (smooth scrolls, late renders)
    [80, 260, 520].forEach((ms) => setTimeout(() => { if (S && S.run === run) { if (step.target && !S.target) S.target = resolve(step.target); place(); } }, ms));
  }

  function draw(step) {
    const n = S.steps.length, i = S.i, last = i === n - 1;
    S.card.innerHTML = `
      <button type="button" class="tt-x" data-tt="skip" aria-label="${esc(tr('Close the tour'))}"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <p class="tt-count">${esc(tr('{n} of {total}', { n: i + 1, total: n }))}</p>
      <h2 class="tt-title" id="tt-title">${esc(step.title)}</h2>
      <p class="tt-text">${step.text}</p>
      <div class="tt-foot">
        ${last ? '' : `<button type="button" class="tt-skip" data-tt="skip">${esc(tr('Skip tour'))}</button>`}
        ${i ? `<button type="button" class="tt-btn tt-back" data-tt="back">${esc(tr('Back'))}</button>` : ''}
        <button type="button" class="tt-btn tt-next" data-tt="next"${last ? ' style="margin-inline-start:auto"' : ''}>${esc(last ? tr('Finish') : tr('Next'))}</button>
      </div>`;
    S.card.querySelectorAll('[data-tt]').forEach((b) => {
      b.onclick = () => { const a = b.dataset.tt; if (a === 'next') next(); else if (a === 'back') prev(); else end('skip'); };
    });
    S.card.style.animation = 'none'; void S.card.offsetWidth; S.card.style.animation = '';
    // Focus the card itself, not a button, so no focus ring shows until someone uses the keyboard.
    S.card.focus({ preventScroll: true });
  }

  function place() {
    if (!S) return;
    const t = S.target && S.target.isConnected ? S.target : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    S.dim.style.display = t ? 'none' : '';
    S.spot.style.display = t ? '' : 'none';
    const card = S.card, cw = card.offsetWidth, ch = card.offsetHeight;
    if (!t) {
      if (!phone()) { card.style.left = Math.round((vw - cw) / 2) + 'px'; card.style.top = Math.round(Math.max(16, (vh - ch) / 2)) + 'px'; }
      return;
    }
    const r = t.getBoundingClientRect();
    const box = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    Object.assign(S.spot.style, { top: box.top + 'px', left: box.left + 'px', width: box.width + 'px', height: box.height + 'px' });
    if (phone()) {
      // Card docked at the bottom: make sure the spotlight is not under it.
      const free = vh - ch - 24;
      if (box.top + box.height > free && box.top > 70) window.scrollBy(0, Math.min(box.top + box.height - free, box.top - 70));
      return;
    }
    const clampX = (x) => Math.min(Math.max(16, x), vw - cw - 16);
    const clampY = (y) => Math.min(Math.max(16, y), vh - ch - 16);
    const step = S.steps[S.i];
    let x, y;
    const endSide = !rtl() ? box.left + box.width + GAP : box.left - GAP - cw;
    if (step.placement === 'side' && (rtl() ? endSide >= 16 : endSide + cw <= vw - 16)) {
      x = endSide; y = clampY(box.top + box.height / 2 - ch / 2);
    } else if (box.top + box.height + GAP + ch <= vh - 16) {
      y = box.top + box.height + GAP; x = clampX(rtl() ? box.left + box.width - cw : box.left);
    } else if (box.top - GAP - ch >= 16) {
      y = box.top - GAP - ch; x = clampX(rtl() ? box.left + box.width - cw : box.left);
    } else {
      x = clampX((vw - cw) / 2); y = clampY(vh - ch - 16);
    }
    card.style.left = Math.round(x) + 'px';
    card.style.top = Math.round(y) + 'px';
  }

  function next() { if (!S) return; if (S.i >= S.steps.length - 1) end('done'); else show(S.i + 1); }
  function prev() { if (S && S.i > 0) show(S.i - 1); }

  function end(reason) {
    if (!S) return;
    const s = S; S = null;
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('resize', s.onMove);
    document.removeEventListener('scroll', s.onMove, true);
    [s.block, s.dim, s.spot, s.card].forEach((n) => n.remove());
    if (s.back && s.back.focus && s.back.isConnected) { try { s.back.focus({ preventScroll: true }); } catch (_) { /* nothing to return to */ } }
    if (s.opts.onEnd) { try { s.opts.onEnd(reason, s.i); } catch (_) { /* the page's own handler */ } }
  }

  window.TroveTour = { start, end, get active() { return !!S; } };
})();
