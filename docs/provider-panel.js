/* Trove — the Services Marketplace dashboard as a drop-in panel.
 *
 * One dashboard, two homes: /provider (accounts that only offer services)
 * and the Services tab of the seller dashboard (/sell — accounts that run a
 * shop too). Both pages mount the same three sections, so the listings
 * editor, the bookings inbox and the listing-fee card never drift apart.
 *
 *   await ProviderPanel.init({ toast, onChange })   // loads profile, taxonomy, data
 *   ProviderPanel.mountOverview(el)                 // status banner + stats + listing fee + payouts
 *   ProviderPanel.mountServices(el)                 // editor + listings
 *   ProviderPanel.mountBookings(el)                 // requests / confirmed / history
 *   ProviderPanel.openEditor()                      // "+ Add a service"
 *
 * Needs TroveAPI (docs/api.js) on the page. Styles are injected once and
 * scoped under .pp so they sit inside either page's own design system.
 */
(function () {
  'use strict';
  const PP = { provider: null, tax: null, services: [], bookings: [], payout: null, payoutEditing: false, editing: null, confirming: null, els: {}, opts: {} };
  const $ = (id) => document.getElementById(id);
  // Every API string that reaches innerHTML goes through esc().
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = (n) => Number(n) || 0;
  const api = (p, o) => TroveAPI.api(p, o);
  function money(c) { const n = (c || 0) / 100; return 'AED ' + (Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { minimumFractionDigits: 2 })); }
  function priceLabel(s) { if (s.priceType === 'from') return 'From ' + money(s.priceCents); if (s.priceType === 'hourly') return money(s.priceCents) + ' / hour'; return money(s.priceCents); }
  function fmtDate(s) { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  const SETTING_LABEL = { home: "At the customer's place", studio: 'At my studio', remote: 'Remote' };
  const pct = () => (PP.provider && PP.provider.commissionPercent) || 10;

  const CSS = `
.pp{font-family:'Quicksand',system-ui,sans-serif;color:var(--char,#292727);font-weight:500}
.pp *{box-sizing:border-box}
.pp .pp-banner{border-radius:16px;padding:16px 20px;font-size:13.5px;font-weight:600;line-height:1.55;margin-bottom:18px}
.pp .pp-banner.pending{background:var(--rose-tint,#F2E9E4)}
.pp .pp-banner.bad{background:#FCEBE4}
.pp .pp-banner.good{background:var(--sage-tint,#E9EFEA)}
.pp .pp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:18px}
.pp .pp-stat{background:var(--paper,#FFFCFA);border:1px solid var(--line,rgba(41,39,39,.12));border-radius:16px;padding:16px 18px}
.pp .pp-stat .k{font-size:11px;letter-spacing:.05em;color:var(--muted,rgba(41,39,39,.72));font-weight:700}
.pp .pp-stat .v{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:30px;font-weight:600;margin-top:4px}
.pp .pp-stat .n{font-size:11.5px;color:var(--muted,rgba(41,39,39,.72));font-weight:600}
.pp .pp-card{background:var(--paper,#FFFCFA);border:1px solid var(--line,rgba(41,39,39,.12));border-radius:18px;padding:20px 22px;margin-bottom:16px}
.pp .pp-card h3{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:22px;font-weight:500;margin:0 0 4px}
.pp .pp-hint{font-size:12.5px;color:var(--muted,rgba(41,39,39,.72));font-weight:500;line-height:1.55;margin-bottom:12px}
.pp .pp-fee{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:30px;font-weight:600}
.pp .pp-fee small{font-family:'Quicksand',sans-serif;font-size:13px;color:var(--muted,rgba(41,39,39,.72));font-weight:600}
.pp .pp-btn{display:inline-block;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;transition:.15s;text-align:center;cursor:pointer;border:none;font-family:inherit;background:none;color:inherit}
.pp .pp-dark{background:var(--char,#292727);color:var(--cream,#FDF7F5)}
.pp .pp-dark:hover{background:#3B3737}
.pp .pp-ghost{border:1px solid var(--line,rgba(41,39,39,.12))}
.pp .pp-ghost:hover{border-color:var(--char,#292727)}
.pp .pp-green{background:var(--sage,#CAD5CC);color:var(--char,#292727)}
.pp .pp-pill{font-size:11px;font-weight:700;padding:5px 12px;border-radius:999px;background:var(--rose-tint,#F2E9E4);color:var(--char,#292727);text-transform:none}
.pp .pp-pill.live,.pp .pp-pill.confirmed,.pp .pp-pill.approved{background:var(--sage-tint,#E9EFEA)}
.pp .pp-pill.completed{background:var(--sage,#CAD5CC)}
.pp .pp-pill.hidden,.pp .pp-pill.declined,.pp .pp-pill.cancelled{background:#F0EBE8;color:var(--muted,rgba(41,39,39,.72))}
.pp .pp-pill.awaiting_payment{background:#FCEBE4}
.pp .pp-confirm{margin-top:12px;border-top:1px solid var(--line,rgba(41,39,39,.12));padding-top:12px}
.pp .pp-confirm .pp-field{margin-bottom:10px}
.pp .pp-paid{font-weight:700;color:var(--char,#292727)}
.pp .pp-row{display:flex;gap:14px;align-items:center;border:1px solid var(--line,rgba(41,39,39,.12));border-radius:14px;padding:14px 16px;margin-bottom:10px;flex-wrap:wrap;background:var(--cream,#FDF7F5)}
.pp .pp-row .grow{flex:1;min-width:200px}
.pp .pp-row .t{font-weight:700;font-size:14px}
.pp .pp-row .s{font-size:12px;color:var(--muted,rgba(41,39,39,.72));font-weight:600;margin-top:2px}
.pp .pp-link{font-size:12.5px;font-weight:700;color:var(--muted,rgba(41,39,39,.72));text-decoration:underline;cursor:pointer;background:none;border:none;font-family:inherit;padding:9px 8px;margin:-6px -4px}
.pp .pp-bkbody a{display:inline-block;padding:4px 0}
.pp .pp-hint a,.pp .pp-banner a{display:inline-block;padding:5px 0;margin:-5px 0}
@media(max-width:560px){.pp .pp-row{padding:12px 14px}.pp .pp-row .grow{min-width:100%}.pp .pp-bkacts .pp-btn{flex:1;min-width:120px}.pp .pp-actions .pp-btn{flex:1}}
.pp .pp-link:hover{color:var(--char,#292727)}
.pp .pp-field{margin-bottom:14px}
.pp .pp-field label{display:block;font-size:11.5px;letter-spacing:.04em;color:var(--muted,rgba(41,39,39,.72));font-weight:700;margin-bottom:6px}
.pp .pp-field input,.pp .pp-field select,.pp .pp-field textarea{width:100%;border:1px solid var(--line,rgba(41,39,39,.12));border-radius:12px;padding:12px 14px;font-size:14px;font-family:inherit;font-weight:500;background:var(--cream,#FDF7F5);color:var(--char,#292727);outline:none}
.pp .pp-field input:focus,.pp .pp-field select:focus,.pp .pp-field textarea:focus{border-color:var(--char,#292727)}
.pp .pp-field textarea{resize:vertical;min-height:90px;line-height:1.5}
.pp .pp-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pp .pp-three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
@media(max-width:560px){.pp .pp-two,.pp .pp-three{grid-template-columns:1fr}}
.pp .pp-err{display:none;background:#FCEBE4;color:var(--char,#292727);font-size:13px;font-weight:600;padding:11px 15px;border-radius:12px;margin-bottom:12px;line-height:1.5}
.pp .pp-bk{border:1px solid var(--line,rgba(41,39,39,.12));border-radius:16px;padding:16px 18px;margin-bottom:12px;background:var(--cream,#FDF7F5)}
.pp .pp-bkhead{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.pp .pp-bkhead .t{font-weight:700;font-size:14px}
.pp .pp-bkhead .code{font-size:11.5px;color:var(--muted,rgba(41,39,39,.72));font-weight:700;letter-spacing:.04em}
.pp .pp-bkbody{font-size:13px;font-weight:500;color:var(--ink-80,rgba(41,39,39,.78));line-height:1.6;margin-top:8px}
.pp .pp-bkbody b{font-weight:700}
.pp .pp-bkacts{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.pp .pp-empty{padding:20px;border:1.5px dashed var(--line,rgba(41,39,39,.12));border-radius:14px;font-size:13px;color:var(--muted,rgba(41,39,39,.72));font-weight:500;line-height:1.6}
.pp .pp-actions{display:flex;gap:10px;justify-content:flex-end}
.pp .pp-bank{display:flex;gap:14px;align-items:center;flex-wrap:wrap;border:1px solid var(--line,rgba(41,39,39,.12));border-radius:14px;padding:14px 16px;background:var(--cream,#FDF7F5);margin-bottom:14px}
.pp .pp-bank .grow{flex:1;min-width:200px;font-size:13px;line-height:1.6}
.pp .pp-bank .iban{font-weight:700;letter-spacing:.04em}
.pp .pp-sub{font-size:11.5px;letter-spacing:.05em;color:var(--muted,rgba(41,39,39,.72));font-weight:700;margin:18px 0 8px}
.pp .pp-cr{display:flex;gap:4px 12px;align-items:baseline;flex-wrap:wrap;border-bottom:1px solid var(--line,rgba(41,39,39,.12));padding:10px 0;font-size:13px}
.pp .pp-cr:last-child{border-bottom:0}
.pp .pp-cr .grow{flex:1;min-width:190px}
.pp .pp-cr .code{font-size:11.5px;color:var(--muted,rgba(41,39,39,.72));font-weight:700;letter-spacing:.04em}
.pp .pp-cr .amt{font-weight:700;white-space:nowrap}
.pp .pp-cr .st{font-size:12px;font-weight:600;color:var(--muted,rgba(41,39,39,.72));flex-basis:100%}
.pp .pp-cr .st.paid{color:var(--char,#292727)}

.pp .pp-catbox{display:flex;gap:7px;flex-wrap:wrap}
.pp .pp-catopt{padding:9px 14px;border-radius:999px;border:1px solid var(--line,rgba(41,39,39,.12));font:inherit;font-size:12.5px;font-weight:600;background:var(--cream,#FDF7F5);color:var(--char,#292727);cursor:pointer}
.pp .pp-catopt.on{background:var(--char,#292727);color:var(--cream,#FDF7F5);border-color:var(--char,#292727)}
.pp .pp-audlbl{font-size:11px;letter-spacing:.05em;color:var(--muted,rgba(41,39,39,.72));font-weight:700;margin:8px 0 6px}
.pp .pp-profhead{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;justify-content:space-between}
.pp .pp-proflinks{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.pp :focus-visible{outline:2px solid var(--char,#292727);outline-offset:2px}
.pp input:focus-visible,.pp select:focus-visible,.pp textarea:focus-visible{outline:2px solid var(--char,#292727)!important;outline-offset:1px}
/* public-page preview (a dialog, so it sits outside .pp) */
.pp-pv{position:fixed;inset:0;z-index:125;display:none;place-items:center;padding:18px;font-family:'Quicksand',system-ui,sans-serif;color:var(--char,#292727)}
.pp-pv.open{display:grid}
.pp-pv .pv-back{position:absolute;inset:0;background:rgba(41,39,39,.45)}
.pp-pv .pv-card{position:relative;background:var(--cream,#FDF7F5);border-radius:20px;width:min(820px,96vw);max-height:92vh;overflow-y:auto;overscroll-behavior:contain;box-shadow:0 30px 70px rgba(41,39,39,.28)}
.pp-pv .pv-top{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(253,247,245,.96);border-bottom:1px solid var(--line,rgba(41,39,39,.12));font-size:12px;letter-spacing:.06em;font-weight:700}
.pp-pv .pv-x{width:44px;height:44px;border-radius:10px;border:0;background:none;cursor:pointer;display:grid;place-items:center;color:inherit}
.pp-pv .pv-x:hover{background:var(--rose-tint,#F2E9E4)}
.pp-pv :focus-visible{outline:2px solid var(--char,#292727);outline-offset:2px}
.pp-pv .pv-rib{margin:16px 20px 0;background:var(--rose-tint,#F2E9E4);border-radius:12px;padding:10px 14px;font-size:12.5px;font-weight:700;line-height:1.5}
.pp-pv .pv-head{padding:22px 24px 6px}
.pp-pv .pv-av{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:28px;font-weight:600;color:var(--char,#292727)}
.pp-pv h2{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:36px;font-weight:500;line-height:1.05;margin:12px 0 4px}
.pp-pv .pv-loc{font-size:12px;letter-spacing:.05em;color:var(--muted,rgba(41,39,39,.72));font-weight:700}
.pp-pv .pv-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}
.pp-pv .pv-chips span{background:var(--rose-tint,#F2E9E4);border-radius:999px;padding:6px 12px;font-size:12px;font-weight:700}
.pp-pv .pv-bio{font-size:14.5px;color:var(--ink-80,rgba(41,39,39,.78));line-height:1.7;margin-top:14px;max-width:62ch;white-space:pre-line}
.pp-pv h3{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:24px;font-weight:500;margin:22px 24px 10px}
.pp-pv .pv-svc{margin:0 24px 12px;background:var(--paper,#FFFCFA);border:1px solid var(--line,rgba(41,39,39,.12));border-radius:16px;padding:16px 18px}
.pp-pv .pv-svc b{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:20px;font-weight:600;display:block;line-height:1.15}
.pp-pv .pv-meta{font-size:12px;color:var(--muted,rgba(41,39,39,.72));font-weight:700;margin-top:4px}
.pp-pv .pv-price{font-weight:700;font-size:14px;margin-top:8px}
.pp-pv .pv-desc{font-size:13.5px;color:var(--ink-80,rgba(41,39,39,.78));line-height:1.6;margin-top:6px}
.pp-pv .pv-note{font-size:12px;color:var(--muted,rgba(41,39,39,.72));font-weight:600;margin:6px 24px 24px;line-height:1.5}
@media(max-width:700px){.pp-pv{padding:0;place-items:end stretch}.pp-pv .pv-card{width:100%;max-height:94vh;border-radius:20px 20px 0 0}}
@media(max-width:560px){
  .pp .pp-field input,.pp .pp-field select,.pp .pp-field textarea{font-size:16px}
  .pp .pp-btn,.pp .pp-catopt{min-height:44px}
  .pp .pp-link{padding:14px 10px;margin:-6px -2px}
  .pp .pp-banner a,.pp .pp-bkbody a{padding:12px 0;margin:-12px 0}
}
@media(prefers-reduced-motion:reduce){.pp *,.pp-pv *{transition:none!important;animation:none!important}}
`;
  function injectCss() { if ($('ppCss')) return; const st = document.createElement('style'); st.id = 'ppCss'; st.textContent = CSS; document.head.appendChild(st); }
  function toast(m) {
    if (PP.opts.toast) return PP.opts.toast(m);
    let t = $('ppToast');
    if (!t) { t = document.createElement('div'); t.id = 'ppToast'; t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#292727;color:#FDF7F5;padding:12px 22px;border-radius:999px;font:600 13.5px Quicksand,sans-serif;opacity:0;transition:.25s;z-index:80;pointer-events:none'; document.body.appendChild(t); }
    t.textContent = m; t.style.opacity = '1'; clearTimeout(PP.toastT); PP.toastT = setTimeout(() => { t.style.opacity = '0'; }, 2400);
  }
  function catName(slug) { const c = PP.tax && PP.tax.categories.find((x) => x.slug === slug); return c ? c.name : slug; }
  function stats() {
    return {
      open: PP.bookings.filter((b) => b.status === 'requested').length,
      upcoming: PP.bookings.filter((b) => ['confirmed', 'awaiting_payment'].includes(b.status)).length,
      done: PP.bookings.filter((b) => b.status === 'completed').length,
      live: PP.services.filter((s) => s.status === 'live').length,
      total: PP.services.length,
      status: PP.provider ? PP.provider.status : null,
    };
  }
  function changed() { if (PP.opts.onChange) try { PP.opts.onChange(stats()); } catch (_) {} }

  /* ---------------- data ---------------- */
  async function reloadServices() { PP.services = (await api('/api/provider/services')).services; }
  async function reloadBookings() { PP.bookings = (await api('/api/provider/bookings')).bookings; }
  // Payouts load on their own: a hiccup there never blocks the dashboard.
  async function reloadPayout() { try { PP.payout = await api('/api/provider/payout'); } catch (_) { PP.payout = null; } }
  async function load() {
    const [prov, tax] = await Promise.all([api('/api/provider/me'), api('/api/services/taxonomy')]);
    PP.provider = prov.provider; PP.tax = tax;
    await Promise.all([reloadServices(), reloadBookings(), reloadPayout()]);
    changed();
  }
  function refresh() { renderOverview(); renderServices(); renderBookings(); changed(); }

  /* ---------------- overview ---------------- */
  function renderOverview() {
    const el = PP.els.overview; if (!el || !PP.provider) return;
    const s = stats(); const st = PP.provider.status; const p = PP.provider;
    const banner = st === 'pending' ? '<div class="pp-banner pending">Your services profile is with our curation team — usually a day or two. Add your services now and everything goes live the moment you’re approved.</div>'
      : st === 'rejected' ? '<div class="pp-banner bad">This application wasn’t approved this time. If things have moved on — new work, new portfolio — get in touch and we’ll take another look.</div>'
      : st === 'suspended' ? '<div class="pp-banner bad">Your services profile is suspended and your services are off the public page. Get in touch with the Trove team.</div>'
      : `<div class="pp-banner good">You’re live — your services are on the public <a href="/services/${esc(p.slug)}" target="_blank" rel="noopener" style="text-decoration:underline">Services Marketplace</a>.</div>`;
    const fee = p.subscription ? p.subscription.feeCents : 3000;
    // Owner, 2026-09-30: free during launch — nothing is running or billed.
    const subHint = `The ${esc(money(fee))}/month listing fee starts later; we'll give you 30 days' notice before it does. No commission on direct bookings; a ${pct()}% platform fee only on bookings paid through Trove.`;
    const earnLine = payoutsCard();
    const po = PP.payout;
    const payBanner = po && po.needsDetails
      ? `<div class="pp-banner pending" id="ppPayBanner">You have a booking paid through Trove — add your bank details under <a href="#ppPayouts" onclick="ProviderPanel.focusPayouts(event)" style="text-decoration:underline">Payouts</a> so we can send your fee.</div>`
      : '';
    const ag = p.agreement || {};
    const agLine = ag.version
      ? `<a href="/provider-agreement" target="_blank" rel="noopener" style="text-decoration:underline">Provider Agreement ${esc(ag.version)}</a> accepted ${fmtDate(ag.acceptedAt)} — your services are your own responsibility; Trove lists them.`
      : `<a href="/provider-agreement" target="_blank" rel="noopener" style="text-decoration:underline">Provider Agreement</a> — your services are your own responsibility; Trove lists them.`;
    el.innerHTML = `<div class="pp">${payBanner}${banner}
      <div class="pp-cards">
        <div class="pp-stat"><div class="k">Live services</div><div class="v">${num(s.live)}</div><div class="n">of ${num(s.total)} listed</div></div>
        <div class="pp-stat"><div class="k">New requests</div><div class="v">${num(s.open)}</div><div class="n">waiting for your reply</div></div>
        <div class="pp-stat"><div class="k">Confirmed</div><div class="v">${num(s.upcoming)}</div><div class="n">bookings ahead</div></div>
        <div class="pp-stat"><div class="k">Completed</div><div class="v">${num(s.done)}</div><div class="n">services delivered</div></div>
      </div>
      <div class="pp-card"><h3>Your listing fee</h3>
        <div class="pp-fee">Free <small>during launch</small></div>
        <div class="pp-hint" style="margin-top:8px">${subHint}</div>
        <div class="pp-hint" style="margin:0">${agLine}</div>
      </div>${earnLine}${profileCard()}</div>`;
  }


  /* ---------------- payouts ----------------
   * GET/PUT /api/provider/payout. Fees for bookings paid through Trove are
   * paid by bank transfer from the payer the server names (Serein
   * Consultancy) on Trove's behalf. The server only ever sends the masked
   * IBAN; "Use my shop's bank details" copies them server-side. */
  function creditStatus(c) {
    if (c.status === 'paid') return `<span class="st paid">Paid on ${esc(fmtDay(c.paidOn))}${c.reference ? ` · reference ${esc(c.reference)}` : ''}${c.payer ? ` · from ${esc(c.payer)}` : ''}</span>`;
    if (c.status === 'payable') return `<span class="st">Payable on ${esc(fmtDay(c.payableOn || todayIso()))} · goes out with the next transfer</span>`;
    if (c.status === 'refunded') return '<span class="st">Refunded to the customer — no fee is due</span>';
    if (c.status === 'deducted') return '<span class="st">Deducted from your next transfer (a paid booking was later refunded)</span>';
    return `<span class="st">Waiting${c.payableOn ? ` · payable on ${esc(fmtDay(c.payableOn))}, or once you mark it done` : ' · payable once you mark it done'}</span>`;
  }
  function payoutsCard() {
    const po = PP.payout; if (!po) return '';
    const e = po.earnings || {};
    const owed = num(e.payableCents) + num(e.pendingCents);
    const d = po.details;
    const payerLine = `Your fee is paid by bank transfer from ${esc(po.payerName)} on Trove’s behalf — look for that name on your statement.`;
    const shopBtn = po.shopDetails
      ? `<button type="button" class="pp-btn pp-ghost" id="ppPayShop" onclick="ProviderPanel.usePayoutShop()">Use my shop’s bank details (${esc(po.shopDetails.bankName)} · ${esc(po.shopDetails.iban)})</button>`
      : '';
    const bank = d && !PP.payoutEditing
      ? `<div class="pp-bank" id="ppPayView"><div class="grow"><b>${esc(d.accountName)}</b> · ${esc(d.bankName)}<br><span class="iban">${esc(d.iban)}</span>${d.source === 'shop' ? ' · copied from your shop' : ''}</div>
          <button type="button" class="pp-btn pp-ghost" onclick="ProviderPanel.editPayout(true)">Change bank details</button></div>`
      : `<div id="ppPayForm">
          <div class="pp-err" id="ppPayErr" role="alert"></div>
          <div class="pp-two">
            <div class="pp-field"><label for="ppPayHolder">Account holder name</label><input id="ppPayHolder" maxlength="120" autocomplete="name" placeholder="As it appears on your bank account"></div>
            <div class="pp-field"><label for="ppPayBank">Bank name</label><input id="ppPayBank" maxlength="120" placeholder="e.g. Emirates NBD"></div>
          </div>
          <div class="pp-field"><label for="ppPayIban">IBAN</label><input id="ppPayIban" maxlength="34" autocomplete="off" spellcheck="false" placeholder="AE07 0331 2345 6789 0123 456"></div>
          <div class="pp-hint" style="margin-top:-4px">A UAE IBAN in your own name (AE followed by 21 digits). We store it encrypted and only ever show the last four digits.</div>
          <div class="pp-actions" style="flex-wrap:wrap">${shopBtn}${d ? '<button type="button" class="pp-btn pp-ghost" onclick="ProviderPanel.editPayout(false)">Cancel</button>' : ''}
            <button type="button" class="pp-btn pp-dark" id="ppPaySave" onclick="ProviderPanel.savePayout()">Save bank details</button></div>
        </div>`;
    const list = (po.credits || []).length
      ? (po.credits || []).map((c) => `<div class="pp-cr"><div class="grow"><b>${esc(c.title)}</b> <span class="code">${esc(c.code)}</span>${c.serviceDate ? ` · ${esc(fmtDay(c.serviceDate))}` : ''}</div>
          <span class="amt">${c.amountCents < 0 ? '−' + esc(money(-c.amountCents)) : esc(money(c.amountCents))}</span>${creditStatus(c)}</div>`).join('')
      : '<div class="pp-empty">No fees yet. When a customer pays for a booking through Trove, your fee appears here with the date it becomes payable.</div>';
    return `<div class="pp-card" id="ppPayouts" tabindex="-1"><h3>Payouts</h3>
      <div class="pp-hint">${payerLine} Each fee becomes payable once you mark the booking done, or ${num(po.graceDays) || 3} days after the service date.</div>
      ${owed || num(e.paidCents) ? `<div class="pp-fee" style="margin-bottom:6px">${esc(money(owed))} <small>owed to you${num(e.payableCents) > 0 ? ` · ${esc(money(num(e.payableCents)))} payable now` : ''}${num(e.paidCents) ? ` · ${esc(money(num(e.paidCents)))} paid so far` : ''}</small></div>` : ''}
      <div class="pp-sub">Bank details</div>${bank}
      <div class="pp-sub">Your fees</div>${list}
    </div>`;
  }
  function editPayout(on) { PP.payoutEditing = !!on; renderOverview(); const f = $(on ? 'ppPayHolder' : 'ppPayouts'); if (f) f.focus(); }
  function focusPayouts(ev) {
    if (ev) ev.preventDefault();
    const el = $('ppPayouts'); if (!el) return;
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    const f = $('ppPayHolder') || el; f.focus({ preventScroll: true });
  }
  async function putPayout(body, btnId, busy) {
    const err = $('ppPayErr'); if (err) err.style.display = 'none';
    const show = (m) => { if (err) { err.textContent = m; err.style.display = 'block'; } else toast(m); };
    const btn = $(btnId); const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = busy; }
    try {
      PP.payout = await api('/api/provider/payout', { method: 'PUT', body });
      PP.payoutEditing = false;
      toast('Bank details saved'); renderOverview();
      return;
    } catch (e) { show(e.message || 'Could not save — try again.'); }
    const b2 = $(btnId); if (b2) { b2.disabled = false; b2.textContent = label; }
  }
  function savePayout() {
    const holder = $('ppPayHolder').value.trim(), bank = $('ppPayBank').value.trim();
    const iban = $('ppPayIban').value.replace(/\s+/g, '').toUpperCase();
    const err = $('ppPayErr');
    const show = (m) => { err.textContent = m; err.style.display = 'block'; };
    if (!holder || !bank) return show('Add the account holder name and the bank name.');
    if (!/^AE\d{21}$/.test(iban)) return show('Enter a valid UAE IBAN (AE followed by 21 digits).');
    return putPayout({ accountName: holder, bankName: bank, iban }, 'ppPaySave', 'Saving…');
  }
  function usePayoutShop() { return putPayout({ useShop: true }, 'ppPayShop', 'Copying…'); }

  /* ---------------- public profile (name, story, categories) ----------------
   * PATCH /api/provider/me accepts name, bio and categories — location is set
   * by Trove at approval, so it isn't offered here. */
  let PROF_CATS = null;
  function profileCard() {
    const p = PP.provider; if (!p) return '';
    if (!PROF_CATS) PROF_CATS = (p.categories || []).slice();
    const live = p.status === 'approved';
    const cats = PP.tax ? PP.tax.audiences.map((a) => {
      const list = PP.tax.categories.filter((c) => c.audience === a.key);
      return `<div class="pp-audlbl">${esc(a.name)}</div><div class="pp-catbox">${list.map((c) =>
        `<button type="button" class="pp-catopt ${PROF_CATS.includes(c.slug) ? 'on' : ''}" data-slug="${esc(c.slug)}" aria-pressed="${PROF_CATS.includes(c.slug)}" onclick="ProviderPanel.toggleProfCat(${esc(JSON.stringify(c.slug))})">${esc(c.name)}</button>`).join('')}</div>`;
    }).join('') : '';
    return `<div class="pp-card" id="ppProfile">
      <div class="pp-profhead"><div><h3 id="ppProfTitle">Your public page</h3>
        <div class="pp-hint" style="margin-bottom:0">What customers read on the Services Marketplace${live ? '' : ' once you’re approved'}.</div></div>
        <div class="pp-proflinks">
          <button type="button" class="pp-btn pp-ghost" onclick="ProviderPanel.openPreview()">Preview your page</button>
          ${live ? `<a class="pp-btn pp-ghost" href="/services/${esc(encodeURIComponent(p.slug))}" target="_blank" rel="noopener">View it live ↗</a>` : ''}
        </div></div>
      <div class="pp-err" id="ppProfErr" role="alert" style="margin-top:12px"></div>
      <div class="pp-field" style="margin-top:14px"><label for="ppProfName">Practice name</label><input id="ppProfName" maxlength="60" value="${esc(p.name)}"></div>
      <div class="pp-field"><label for="ppProfBio">Your story</label><textarea id="ppProfBio" maxlength="2000" placeholder="Who you are, what you do and how you work — a few honest sentences.">${esc(p.bio || '')}</textarea></div>
      <div class="pp-field"><label id="ppProfCatLbl">Categories <span style="text-transform:none;letter-spacing:0;font-weight:600">· one to three</span></label>
        <div role="group" aria-labelledby="ppProfCatLbl">${cats}</div></div>
      <div class="pp-actions"><button type="button" class="pp-btn pp-dark" id="ppProfSave" onclick="ProviderPanel.saveProfile()">Save profile</button></div>
    </div>`;
  }
  function toggleProfCat(slug) {
    if (PROF_CATS.includes(slug)) PROF_CATS = PROF_CATS.filter((s) => s !== slug);
    else { if (PROF_CATS.length >= 3) { toast('Three categories is the limit — unpick one first'); return; } PROF_CATS.push(slug); }
    // keep typed text: only the chips re-render
    document.querySelectorAll('#ppProfile .pp-catopt').forEach((b) => {
      const on = PROF_CATS.includes(b.dataset.slug);
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
  }
  async function saveProfile() {
    const err = $('ppProfErr'); err.style.display = 'none';
    const show = (m) => { err.textContent = m; err.style.display = 'block'; };
    const name = $('ppProfName').value.trim();
    if (!name) return show('Your practice needs a name.');
    if (!PROF_CATS.length) return show('Pick at least one category.');
    const btn = $('ppProfSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await api('/api/provider/me', { method: 'PATCH', body: { name, bio: $('ppProfBio').value.trim(), categories: PROF_CATS } });
      PP.provider = { ...PP.provider, ...r.provider }; PROF_CATS = (PP.provider.categories || []).slice();
      toast('Profile saved'); renderOverview(); changed();
      if (PP.opts.onProfile) try { PP.opts.onProfile(PP.provider); } catch (_) {}
    } catch (e) { show(e.message || 'Could not save — try again.'); }
    const b2 = $('ppProfSave'); if (b2) { b2.disabled = false; b2.textContent = 'Save profile'; }
  }

  /* ---------------- preview of the public page ----------------
   * Built from the dashboard's own data, so a provider still in review sees
   * the page before it exists publicly. A small dialog: focus moves in, Tab
   * stays inside, Esc closes and focus goes back to the button. */
  let PV_RET = null;
  function pvEl() {
    let el = $('ppPv'); if (el) return el;
    el = document.createElement('div'); el.id = 'ppPv'; el.className = 'pp-pv';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'ppPvTitle'); el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="pv-back"></div><div class="pv-card"><div class="pv-top"><span>Customer preview</span><button type="button" class="pv-x" id="ppPvX" aria-label="Close preview"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m18 6-12 12M6 6l12 12"/></svg></button></div><div id="ppPvBody"></div></div>';
    document.body.appendChild(el);
    el.querySelector('.pv-back').onclick = closePreview; $('ppPvX').onclick = closePreview;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePreview(); return; }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll('button,a[href]')].filter((n) => n.getClientRects().length);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    return el;
  }
  function openPreview() {
    const p = PP.provider; if (!p) return;
    const el = pvEl();
    const name = ($('ppProfName') && $('ppProfName').value.trim()) || p.name;
    const bio = $('ppProfBio') ? $('ppProfBio').value.trim() : (p.bio || '');
    const cats = (PROF_CATS || p.categories || []).map(catName);
    const live = PP.services.filter((s) => s.status === 'live');
    const rib = p.status === 'approved' ? 'Preview — this is how customers see your page.' : 'Preview — not public yet. Your page and live services appear the moment Trove approves your profile.';
    $('ppPvBody').innerHTML = `<div class="pv-rib">${rib}</div>
      <div class="pv-head"><div class="pv-av" style="background:${/^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#F2E9E4'}">${esc((name || '?')[0].toUpperCase())}</div>
        <h2 id="ppPvTitle">${esc(name)}</h2>${p.location ? `<div class="pv-loc">${esc(p.location)}</div>` : ''}
        ${cats.length ? `<div class="pv-chips">${cats.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
        ${bio ? `<p class="pv-bio">${esc(bio)}</p>` : '<p class="pv-bio" style="color:var(--muted,rgba(41,39,39,.72))">No story yet — add a few sentences under Your public page.</p>'}</div>
      <h3>What ${esc(name)} offers</h3>
      ${live.length ? live.map((s) => `<div class="pv-svc"><b>${esc(s.title)}</b><div class="pv-meta">${esc(catName(s.category))} · ${esc(SETTING_LABEL[s.setting] || '')}${s.duration ? ' · ' + esc(s.duration) : ''}</div><div class="pv-price">${priceLabel(s)}</div>${s.description ? `<div class="pv-desc">${esc(s.description)}</div>` : ''}</div>`).join('')
        : '<p class="pv-note" style="margin-top:0">No live services yet — add one under My services and set it to live.</p>'}
      <p class="pv-note">Customers send a booking request from this page. Your email and phone are never shown.</p>`;
    PV_RET = document.activeElement;
    el.classList.add('open'); el.removeAttribute('aria-hidden'); document.body.style.overflow = 'hidden';
    el.querySelector('.pv-card').scrollTop = 0;
    setTimeout(() => $('ppPvX').focus(), 40);
  }
  function closePreview() {
    const el = $('ppPv'); if (!el) return;
    el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); document.body.style.overflow = '';
    if (PV_RET && PV_RET.focus && document.contains(PV_RET)) PV_RET.focus();
  }

  /* ---------------- services ---------------- */
  function editorMarkup() {
    return `<div class="pp-card" id="ppEditor" role="region" aria-labelledby="ppEdTitle" style="display:none">
      <h3 id="ppEdTitle" tabindex="-1">Add a service</h3>
      <div class="pp-hint">Set the price the way you charge — a fixed price, a starting price, or per hour. Direct bookings carry no commission; bookings paid through Trove carry a ${pct()}% platform fee.</div>
      <div class="pp-err" id="ppEdErr" role="alert"></div>
      <div class="pp-field"><label for="ppEdName">Service name</label><input id="ppEdName" maxlength="90" placeholder="e.g. Pottery hand-building workshop at your home"></div>
      <div class="pp-two">
        <div class="pp-field"><label for="ppEdCat">Category</label><select id="ppEdCat"></select></div>
        <div class="pp-field"><label for="ppEdSetting">Where does it happen?</label>
          <select id="ppEdSetting"><option value="home">At the customer's place</option><option value="studio">At my studio</option><option value="remote">Remote</option></select></div>
      </div>
      <div class="pp-three">
        <div class="pp-field"><label for="ppEdPrice">Price (AED)</label><input id="ppEdPrice" type="number" min="1" step="0.01" inputmode="decimal" placeholder="350"></div>
        <div class="pp-field"><label for="ppEdPriceType">Price works as</label>
          <select id="ppEdPriceType"><option value="fixed">Fixed price</option><option value="from">Starting price</option><option value="hourly">Per hour</option></select></div>
        <div class="pp-field"><label for="ppEdDuration">How long? <span style="text-transform:none;letter-spacing:0;font-weight:600">· optional</span></label><input id="ppEdDuration" maxlength="60" placeholder="e.g. 2–3 hours"></div>
      </div>
      <div class="pp-field"><label for="ppEdDesc">Description</label><textarea id="ppEdDesc" maxlength="2000" placeholder="What's included, what you bring, how many people it suits, how booking works."></textarea></div>
      <div class="pp-actions">
        <button type="button" class="pp-btn pp-ghost" onclick="ProviderPanel.closeEditor()">Cancel</button>
        <button class="pp-btn pp-dark" id="ppEdSave" onclick="ProviderPanel.saveService()">Save service</button>
      </div>
    </div>
    <div class="pp-card">
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap"><div style="flex:1"><h3>My services</h3>
      <div class="pp-hint">Live services appear on the public Services Marketplace as soon as your profile is approved. Hide one to take it off without deleting it.</div></div>
      <button class="pp-btn pp-dark" onclick="ProviderPanel.openEditor()">+ Add a service</button></div>
      <div id="ppSvList"></div>
    </div>`;
  }
  function fillCatSelect() {
    const sel = $('ppEdCat'); if (!sel || !PP.tax) return;
    sel.innerHTML = PP.tax.audiences.map((a) =>
      `<optgroup label="${esc(a.name)} — ${esc(a.sub)}">${PP.tax.categories.filter((c) => c.audience === a.key).map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  }
  function renderServices() {
    const list = $('ppSvList'); if (!list) return;
    list.innerHTML = PP.services.length ? PP.services.map((s) => `
      <div class="pp-row">
        <div class="grow"><div class="t">${esc(s.title)}</div>
          <div class="s">${esc(catName(s.category))} · ${priceLabel(s)}${s.duration ? ` · ${esc(s.duration)}` : ''} · ${esc(SETTING_LABEL[s.setting] || '')}</div></div>
        <span class="pp-pill ${esc(s.status)}">${esc(s.status)}</span>
        <button class="pp-link" aria-label="Edit ${esc(s.title)}" onclick="ProviderPanel.openEditor(${num(s.id)})">Edit</button>
        <button class="pp-link" aria-label="${s.status === 'live' ? 'Hide' : 'Make live'} ${esc(s.title)}" onclick="ProviderPanel.toggleLive(${num(s.id)})">${s.status === 'live' ? 'Hide' : 'Make live'}</button>
        <button class="pp-link" aria-label="Delete ${esc(s.title)}" onclick="ProviderPanel.deleteService(${num(s.id)})">Delete</button>
      </div>`).join('')
      : '<div class="pp-empty">Nothing listed yet — add your first service and it’s ready the moment you’re approved.</div>';
  }
  function openEditor(id) {
    const ed = $('ppEditor'); if (!ed) return;
    PP.editing = id ? PP.services.find((s) => s.id === id) : null;
    const E = PP.editing;
    $('ppEdTitle').textContent = E ? 'Edit service' : 'Add a service';
    $('ppEdErr').style.display = 'none';
    $('ppEdName').value = E ? E.title : '';
    $('ppEdCat').value = E ? E.category : ((PP.provider.categories || [])[0] || PP.tax.categories[0].slug);
    $('ppEdSetting').value = E ? E.setting : 'home';
    // Fils kept exactly: AED 12.50 reopens as 12.50, so saving another edit
    // never quietly changes the price.
    $('ppEdPrice').value = E ? (E.priceCents % 100 ? (E.priceCents / 100).toFixed(2) : String(E.priceCents / 100)) : '';
    $('ppEdPriceType').value = E ? E.priceType : 'fixed';
    $('ppEdDuration').value = E ? E.duration : '';
    $('ppEdDesc').value = E ? E.description : '';
    if (ed.style.display !== 'block') PP.edRet = document.activeElement;
    ed.style.display = 'block';
    if (PP.opts.onOpenEditor) PP.opts.onOpenEditor();
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    ed.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    setTimeout(() => $('ppEdName').focus({ preventScroll: true }), still ? 0 : 300);
    if (!ed.dataset.esc) { ed.dataset.esc = '1'; ed.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeEditor(); } }); }
  }
  function closeEditor() {
    const ed = $('ppEditor'); if (ed) ed.style.display = 'none'; PP.editing = null;
    const r = PP.edRet; PP.edRet = null; if (r && r.focus && document.contains(r)) r.focus({ preventScroll: true });
  }
  async function saveService() {
    const err = $('ppEdErr'); err.style.display = 'none';
    const show = (m) => { err.textContent = m; err.style.display = 'block'; };
    const price = Math.round(Number($('ppEdPrice').value) * 100);
    if (!$('ppEdName').value.trim()) return show('Give the service a name.');
    if (!Number.isFinite(price) || price < 100) return show('Set a price of at least AED 1.');
    const body = {
      title: $('ppEdName').value.trim(), category: $('ppEdCat').value,
      description: $('ppEdDesc').value.trim(), priceCents: price,
      priceType: $('ppEdPriceType').value, duration: $('ppEdDuration').value.trim(),
      setting: $('ppEdSetting').value,
    };
    const btn = $('ppEdSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (PP.editing) await api('/api/provider/services/' + PP.editing.id, { method: 'PATCH', body });
      else await api('/api/provider/services', { method: 'POST', body });
      toast(PP.editing ? 'Service updated' : 'Service added');
      closeEditor();
      await reloadServices(); refresh();
    } catch (e) { show(e.message || 'Could not save — try again.'); }
    btn.disabled = false; btn.textContent = 'Save service';
  }
  async function toggleLive(id) {
    const s = PP.services.find((x) => x.id === id); if (!s) return;
    try {
      await api('/api/provider/services/' + id, { method: 'PATCH', body: { status: s.status === 'live' ? 'hidden' : 'live' } });
      await reloadServices(); refresh();
    } catch (e) { toast(e.message || 'Could not update'); }
  }
  async function deleteService(id) {
    const s = PP.services.find((x) => x.id === id);
    if (!confirm(`Delete "${s ? s.title : 'this service'}"? This can't be undone.`)) return;
    try {
      await api('/api/provider/services/' + id, { method: 'DELETE' });
      toast('Service deleted');
      await reloadServices(); refresh();
    } catch (e) { toast(e.message || 'Could not delete'); }
  }

  /* ---------------- bookings ---------------- */
  const PILL = { requested: 'new request', awaiting_payment: 'awaiting payment', confirmed: 'confirmed', completed: 'done', declined: 'declined', cancelled: 'cancelled' };
  function todayIso() { return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10); }
  function fmtDay(d) { const t = new Date(String(d) + 'T00:00:00Z'); return isNaN(t) ? String(d) : t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  // How the booking is paid. 'Paid through Trove' only once the money is in.
  function payLine(b) {
    if (b.paymentMethod !== 'trove') return 'Settled directly with the customer';
    const fee = b.amountCents ? `your fee ${money(b.providerNetCents)} after a ${pct()}% platform fee` : `your fee is the price less a ${pct()}% platform fee`;
    if (b.refunded) return 'Refunded to the customer — no fee is due';
    if (b.paid) return `<span class="pp-paid">Paid through Trove</span> · ${fee}`;
    if (b.status === 'awaiting_payment') return `Awaiting the customer’s card payment · ${fee}`;
    if (b.status === 'requested') return `The customer will pay through Trove by card once you confirm · ${fee}`;
    return 'Not paid';
  }
  function confirmForm(b) {
    const trove = b.paymentMethod === 'trove';
    const needPrice = trove && b.priceType !== 'fixed';
    const priceHint = b.priceType === 'hourly' ? `hours × ${money(b.priceCents)}` : `from ${money(b.priceCents)}`;
    return `<div class="pp-confirm" id="ppCf${num(b.id)}">
      <div class="pp-err" id="ppCfErr${num(b.id)}" role="alert"></div>
      <div class="pp-two">
        <div class="pp-field"><label for="ppCfDate${num(b.id)}">Service date${trove ? '' : ' <span style="text-transform:none;letter-spacing:0;font-weight:600">· optional</span>'}</label><input type="date" id="ppCfDate${num(b.id)}" min="${todayIso()}"></div>
        ${needPrice ? `<div class="pp-field"><label for="ppCfPrice${num(b.id)}">Final price (AED) · ${esc(priceHint)}</label><input type="number" min="1" step="0.01" inputmode="decimal" id="ppCfPrice${num(b.id)}"></div>` : ''}
      </div>
      <div class="pp-hint" style="margin:0 0 10px">${trove
        ? `The customer pays Trove this ${needPrice ? 'price' : `listed price (${money(b.priceCents)})`} by card through a secure link; you get their mobile once it’s paid. Your fee is the price less the ${pct()}% platform fee.`
        : 'The customer settles with you directly. You get their mobile as soon as you confirm.'}</div>
      <div class="pp-bkacts" style="margin-top:0">
        <button class="pp-btn pp-green" onclick="ProviderPanel.sendConfirm(${num(b.id)})">Confirm booking</button>
        <button class="pp-btn pp-ghost" onclick="ProviderPanel.openConfirm(null)">Back</button></div>
    </div>`;
  }
  function bkCard(b) {
    const pay = payLine(b);
    const when = b.serviceDate ? `<b>Date:</b> ${esc(fmtDay(b.serviceDate))}<br>` : (b.preferredDate ? `<b>When:</b> ${esc(b.preferredDate)}<br>` : '');
    const price = b.amountCents ? money(b.amountCents) : priceLabel(b);
    const phone = b.phone ? `<b>Mobile:</b> <a href="tel:${esc(String(b.phone).replace(/[^+\d]/g, ''))}" style="text-decoration:underline">${esc(b.phone)}</a><br>` : '';
    const notes = b.notes ? `<b>Brief:</b> ${esc(b.notes)}<br>` : '';
    return `<div class="pp-bk">
      <div class="pp-bkhead"><span class="t">${esc(b.title)}</span><span class="code">${esc(b.code)}</span><span style="flex:1"></span><span class="pp-pill ${esc(b.status)}">${esc(PILL[b.status] || b.status)}</span></div>
      <div class="pp-bkbody">
        <b>${esc(b.customerName)}</b> · ${esc(b.area)} · ${price} · ${pay}<br>
        ${when}${phone}${notes}
        ${b.declineReason && ['declined', 'cancelled'].includes(b.status) ? `<b>Note:</b> ${esc(b.declineReason)}<br>` : ''}
        <span style="color:var(--muted,rgba(41,39,39,.72));font-size:12px">Requested ${fmtDate(b.createdAt)}${b.status === 'requested' ? ' · the customer’s mobile appears once the booking is secured' : ''}${b.status === 'awaiting_payment' ? ' · the customer’s mobile appears once they’ve paid' : ''}</span>
      </div>
      ${b.status === 'requested' && PP.confirming === b.id ? confirmForm(b) : ''}
      ${b.status === 'requested' && PP.confirming !== b.id ? `<div class="pp-bkacts">
        <button class="pp-btn pp-green" onclick="ProviderPanel.openConfirm(${num(b.id)})">✓ Confirm</button>
        <button class="pp-btn pp-ghost" onclick="ProviderPanel.declineBooking(${num(b.id)})">Decline</button></div>` : ''}
      ${b.status === 'awaiting_payment' ? `<div class="pp-bkacts">
        <button class="pp-btn pp-ghost" onclick="ProviderPanel.declineBooking(${num(b.id)})">Withdraw</button></div>` : ''}
      ${b.status === 'confirmed' ? `<div class="pp-bkacts">
        <button class="pp-btn pp-dark" onclick="ProviderPanel.actBooking(${num(b.id)},'complete')">Mark as done</button>
        <button class="pp-btn pp-ghost" onclick="ProviderPanel.cancelBooking(${num(b.id)})">Cancel booking</button></div>` : ''}
    </div>`;
  }
  function renderBookings() {
    const el = PP.els.bookings; if (!el) return;
    const open = PP.bookings.filter((b) => b.status === 'requested');
    const upcoming = PP.bookings.filter((b) => ['awaiting_payment', 'confirmed'].includes(b.status));
    const rest = PP.bookings.filter((b) => !['requested', 'awaiting_payment', 'confirmed'].includes(b.status));
    el.innerHTML = `<div class="pp">
      <div class="pp-card"><h3>New requests</h3><div class="pp-hint">Confirm with the date (and the final price, for starting-price or hourly work) — you get the customer’s mobile once the booking is secured. Decline with a short note if it’s not one for you.</div>
        ${open.length ? open.map(bkCard).join('') : '<div class="pp-empty">No new requests right now. Requests from the Services Marketplace land here.</div>'}</div>
      <div class="pp-card"><h3>Confirmed</h3><div class="pp-hint">Direct bookings: settle with the customer as you agreed. Bookings paid through Trove: the customer pays Trove by card; your fee is paid by bank transfer after you mark the booking done (see Payouts on your overview). If you have to cancel, the customer is refunded in full.</div>
        ${upcoming.length ? upcoming.map(bkCard).join('') : '<div class="pp-empty">Nothing confirmed yet.</div>'}</div>
      <div class="pp-card"><h3>History</h3>
        ${rest.length ? rest.map(bkCard).join('') : '<div class="pp-empty">Completed, declined and cancelled bookings end up here.</div>'}</div>
    </div>`;
  }
  async function actBooking(id, action) {
    try {
      await api('/api/provider/bookings/' + id, { method: 'PATCH', body: { action } });
      toast(action === 'confirm' ? 'Booking confirmed' : 'Marked as done');
      await reloadBookings(); refresh();
    } catch (e) { toast(e.message || 'Could not update'); }
  }
  function openConfirm(id) { PP.confirming = id; renderBookings(); }
  async function sendConfirm(id) {
    const b = PP.bookings.find((x) => x.id === id); if (!b) return;
    const err = $('ppCfErr' + id); err.style.display = 'none';
    const show = (m) => { err.textContent = m; err.style.display = 'block'; };
    const date = $('ppCfDate' + id).value;
    const body = { action: 'confirm' };
    if (date) body.serviceDate = date;
    else if (b.paymentMethod === 'trove') return show('Set the date of the service.');
    const priceEl = $('ppCfPrice' + id);
    if (priceEl) {
      const cents = Math.round(Number(priceEl.value) * 100);
      if (!Number.isFinite(cents) || cents < 100) return show('Set the final price for this booking.');
      body.priceCents = cents;
    }
    try {
      await api('/api/provider/bookings/' + id, { method: 'PATCH', body });
      PP.confirming = null;
      toast(b.paymentMethod === 'trove' ? 'Confirmed — we’ve sent the customer a link to pay' : 'Booking confirmed');
      await reloadBookings(); refresh();
    } catch (e) { show(e.message || 'Could not confirm — try again.'); }
  }
  async function cancelBooking(id) {
    const b = PP.bookings.find((x) => x.id === id); if (!b) return;
    const reason = prompt(b.paid ? 'Cancel this booking? The customer is refunded in full and no fee is due. A short note for them (optional):' : 'Cancel this booking? A short note for the customer (optional):', '');
    if (reason === null) return;
    try {
      await api('/api/provider/bookings/' + id, { method: 'PATCH', body: { action: 'cancel', reason } });
      toast(b.paid ? 'Booking cancelled — the customer is refunded' : 'Booking cancelled');
      await reloadBookings(); refresh();
    } catch (e) { toast(e.message || 'Could not cancel'); }
  }
  async function declineBooking(id) {
    const reason = prompt('A short note for the customer (optional):', '');
    if (reason === null) return;
    try {
      await api('/api/provider/bookings/' + id, { method: 'PATCH', body: { action: 'decline', reason } });
      toast('Request declined');
      await reloadBookings(); refresh();
    } catch (e) { toast(e.message || 'Could not update'); }
  }

  /* ---------------- mounting ---------------- */
  function mountOverview(el) { PP.els.overview = el; renderOverview(); }
  function mountServices(el) { PP.els.services = el; el.innerHTML = `<div class="pp">${editorMarkup()}</div>`; fillCatSelect(); renderServices(); }
  function mountBookings(el) { PP.els.bookings = el; renderBookings(); }

  window.ProviderPanel = {
    init(opts) { PP.opts = opts || {}; injectCss(); return load(); },
    mountOverview, mountServices, mountBookings, refresh, stats,
    openEditor, closeEditor, saveService, toggleLive, deleteService, actBooking, declineBooking,
    openConfirm, sendConfirm, cancelBooking,
    toggleProfCat, saveProfile, openPreview, closePreview,
    savePayout, usePayoutShop, editPayout, focusPayouts,
    get provider() { return PP.provider; },
  };
})();
