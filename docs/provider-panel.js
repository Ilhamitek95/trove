/* Trove — the Services Marketplace dashboard as a drop-in panel.
 *
 * One dashboard, two homes: /provider (accounts that only offer services)
 * and the Services tab of the seller dashboard (/sell — accounts that run a
 * shop too). Both pages mount the same three sections, so the listings
 * editor, the bookings inbox and the subscription card never drift apart.
 *
 *   await ProviderPanel.init({ toast, onChange })   // loads profile, taxonomy, data
 *   ProviderPanel.mountOverview(el)                 // status banner + stats + subscription
 *   ProviderPanel.mountServices(el)                 // editor + listings
 *   ProviderPanel.mountBookings(el)                 // requests / confirmed / history
 *   ProviderPanel.openEditor()                      // "+ Add a service"
 *
 * Needs TroveAPI (docs/api.js) on the page. Styles are injected once and
 * scoped under .pp so they sit inside either page's own design system.
 */
(function () {
  'use strict';
  const PP = { provider: null, tax: null, services: [], bookings: [], editing: null, els: {}, opts: {} };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
.pp .pp-stat .k{font-size:11px;letter-spacing:.05em;color:var(--muted,rgba(41,39,39,.62));font-weight:700}
.pp .pp-stat .v{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:30px;font-weight:600;margin-top:4px}
.pp .pp-stat .n{font-size:11.5px;color:var(--muted,rgba(41,39,39,.62));font-weight:600}
.pp .pp-card{background:var(--paper,#FFFCFA);border:1px solid var(--line,rgba(41,39,39,.12));border-radius:18px;padding:20px 22px;margin-bottom:16px}
.pp .pp-card h3{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:22px;font-weight:500;margin:0 0 4px}
.pp .pp-hint{font-size:12.5px;color:var(--muted,rgba(41,39,39,.62));font-weight:500;line-height:1.55;margin-bottom:12px}
.pp .pp-fee{font-family:var(--font-display,'Cormorant',Georgia,serif);font-size:30px;font-weight:600}
.pp .pp-fee small{font-family:'Quicksand',sans-serif;font-size:13px;color:var(--muted,rgba(41,39,39,.62));font-weight:600}
.pp .pp-btn{display:inline-block;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;transition:.15s;text-align:center;cursor:pointer;border:none;font-family:inherit;background:none;color:inherit}
.pp .pp-dark{background:var(--char,#292727);color:var(--cream,#FDF7F5)}
.pp .pp-dark:hover{background:#3B3737}
.pp .pp-ghost{border:1px solid var(--line,rgba(41,39,39,.12))}
.pp .pp-ghost:hover{border-color:var(--char,#292727)}
.pp .pp-green{background:var(--sage,#CAD5CC);color:var(--char,#292727)}
.pp .pp-pill{font-size:11px;font-weight:700;padding:5px 12px;border-radius:999px;background:var(--rose-tint,#F2E9E4);color:var(--char,#292727);text-transform:none}
.pp .pp-pill.live,.pp .pp-pill.confirmed,.pp .pp-pill.approved{background:var(--sage-tint,#E9EFEA)}
.pp .pp-pill.completed{background:var(--sage,#CAD5CC)}
.pp .pp-pill.hidden,.pp .pp-pill.declined,.pp .pp-pill.cancelled{background:#F0EBE8;color:var(--muted,rgba(41,39,39,.62))}
.pp .pp-row{display:flex;gap:14px;align-items:center;border:1px solid var(--line,rgba(41,39,39,.12));border-radius:14px;padding:14px 16px;margin-bottom:10px;flex-wrap:wrap;background:var(--cream,#FDF7F5)}
.pp .pp-row .grow{flex:1;min-width:200px}
.pp .pp-row .t{font-weight:700;font-size:14px}
.pp .pp-row .s{font-size:12px;color:var(--muted,rgba(41,39,39,.62));font-weight:600;margin-top:2px}
.pp .pp-link{font-size:12.5px;font-weight:700;color:var(--muted,rgba(41,39,39,.62));text-decoration:underline;cursor:pointer;background:none;border:none;font-family:inherit;padding:9px 8px;margin:-6px -4px}
.pp .pp-bkbody a{display:inline-block;padding:4px 0}
.pp .pp-hint a,.pp .pp-banner a{display:inline-block;padding:5px 0;margin:-5px 0}
@media(max-width:560px){.pp .pp-row{padding:12px 14px}.pp .pp-row .grow{min-width:100%}.pp .pp-bkacts .pp-btn{flex:1;min-width:120px}.pp .pp-actions .pp-btn{flex:1}}
.pp .pp-link:hover{color:var(--char,#292727)}
.pp .pp-field{margin-bottom:14px}
.pp .pp-field label{display:block;font-size:11.5px;letter-spacing:.04em;color:var(--muted,rgba(41,39,39,.62));font-weight:700;margin-bottom:6px}
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
.pp .pp-bkhead .code{font-size:11.5px;color:var(--muted,rgba(41,39,39,.62));font-weight:700;letter-spacing:.04em}
.pp .pp-bkbody{font-size:13px;font-weight:500;color:var(--ink-80,rgba(41,39,39,.78));line-height:1.6;margin-top:8px}
.pp .pp-bkbody b{font-weight:700}
.pp .pp-bkacts{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.pp .pp-empty{padding:20px;border:1.5px dashed var(--line,rgba(41,39,39,.12));border-radius:14px;font-size:13px;color:var(--muted,rgba(41,39,39,.62));font-weight:500;line-height:1.6}
.pp .pp-actions{display:flex;gap:10px;justify-content:flex-end}
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
      upcoming: PP.bookings.filter((b) => b.status === 'confirmed').length,
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
  async function load() {
    const [prov, tax] = await Promise.all([api('/api/provider/me'), api('/api/services/taxonomy')]);
    PP.provider = prov.provider; PP.tax = tax;
    await Promise.all([reloadServices(), reloadBookings()]);
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
    const subHint = p.subscription && p.subscription.startedAt
      ? `Running since ${fmtDate(p.subscription.startedAt)}. No commission on direct bookings; a ${pct()}% platform fee only on bookings paid through Trove. Card billing begins when Trove's card payments launch; you'll be told before the first charge.`
      : `Nothing to pay yet — the subscription starts the day your profile is approved. No commission on direct bookings; a ${pct()}% platform fee only on bookings paid through Trove.`;
    const ag = p.agreement || {};
    const agLine = ag.version
      ? `<a href="/provider-agreement" target="_blank" rel="noopener" style="text-decoration:underline">Provider Agreement ${esc(ag.version)}</a> accepted ${fmtDate(ag.acceptedAt)} — your services are your own responsibility; Trove lists them.`
      : `<a href="/provider-agreement" target="_blank" rel="noopener" style="text-decoration:underline">Provider Agreement</a> — your services are your own responsibility; Trove lists them.`;
    el.innerHTML = `<div class="pp">${banner}
      <div class="pp-cards">
        <div class="pp-stat"><div class="k">Live services</div><div class="v">${s.live}</div><div class="n">of ${s.total} listed</div></div>
        <div class="pp-stat"><div class="k">New requests</div><div class="v">${s.open}</div><div class="n">waiting for your reply</div></div>
        <div class="pp-stat"><div class="k">Confirmed</div><div class="v">${s.upcoming}</div><div class="n">bookings ahead</div></div>
        <div class="pp-stat"><div class="k">Completed</div><div class="v">${s.done}</div><div class="n">services delivered</div></div>
      </div>
      <div class="pp-card"><h3>Your subscription</h3>
        <div class="pp-fee">AED ${Math.round(fee / 100)} <small>/ month</small></div>
        <div class="pp-hint" style="margin-top:8px">${subHint}</div>
        <div class="pp-hint" style="margin:0">${agLine}</div>
      </div></div>`;
  }

  /* ---------------- services ---------------- */
  function editorMarkup() {
    return `<div class="pp-card" id="ppEditor" style="display:none">
      <h3 id="ppEdTitle">Add a service</h3>
      <div class="pp-hint">Set the price the way you charge — a fixed price, a starting price, or per hour. Direct bookings carry no commission; bookings paid through Trove carry a ${pct()}% platform fee.</div>
      <div class="pp-err" id="ppEdErr"></div>
      <div class="pp-field"><label>Service name</label><input id="ppEdName" maxlength="90" placeholder="e.g. Pottery hand-building workshop at your home"></div>
      <div class="pp-two">
        <div class="pp-field"><label>Category</label><select id="ppEdCat"></select></div>
        <div class="pp-field"><label>Where does it happen?</label>
          <select id="ppEdSetting"><option value="home">At the customer's place</option><option value="studio">At my studio</option><option value="remote">Remote</option></select></div>
      </div>
      <div class="pp-three">
        <div class="pp-field"><label>Price (AED)</label><input id="ppEdPrice" type="number" min="1" step="1" placeholder="350"></div>
        <div class="pp-field"><label>Price works as</label>
          <select id="ppEdPriceType"><option value="fixed">Fixed price</option><option value="from">Starting price</option><option value="hourly">Per hour</option></select></div>
        <div class="pp-field"><label>How long? <span style="text-transform:none;letter-spacing:0;color:var(--taupe,#BD9C8C);font-weight:600">· optional</span></label><input id="ppEdDuration" maxlength="60" placeholder="e.g. 2–3 hours"></div>
      </div>
      <div class="pp-field"><label>Description</label><textarea id="ppEdDesc" maxlength="2000" placeholder="What's included, what you bring, how many people it suits, how booking works."></textarea></div>
      <div class="pp-actions">
        <button class="pp-btn pp-ghost" onclick="ProviderPanel.closeEditor()">Cancel</button>
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
      `<optgroup label="${esc(a.name)} — ${esc(a.sub)}">${PP.tax.categories.filter((c) => c.audience === a.key).map((c) => `<option value="${c.slug}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  }
  function renderServices() {
    const list = $('ppSvList'); if (!list) return;
    list.innerHTML = PP.services.length ? PP.services.map((s) => `
      <div class="pp-row">
        <div class="grow"><div class="t">${esc(s.title)}</div>
          <div class="s">${esc(catName(s.category))} · ${priceLabel(s)}${s.duration ? ` · ${esc(s.duration)}` : ''} · ${esc(SETTING_LABEL[s.setting] || '')}</div></div>
        <span class="pp-pill ${s.status}">${s.status}</span>
        <button class="pp-link" onclick="ProviderPanel.openEditor(${s.id})">Edit</button>
        <button class="pp-link" onclick="ProviderPanel.toggleLive(${s.id})">${s.status === 'live' ? 'Hide' : 'Make live'}</button>
        <button class="pp-link" onclick="ProviderPanel.deleteService(${s.id})">Delete</button>
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
    $('ppEdPrice').value = E ? Math.round(E.priceCents / 100) : '';
    $('ppEdPriceType').value = E ? E.priceType : 'fixed';
    $('ppEdDuration').value = E ? E.duration : '';
    $('ppEdDesc').value = E ? E.description : '';
    ed.style.display = 'block';
    if (PP.opts.onOpenEditor) PP.opts.onOpenEditor();
    ed.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeEditor() { const ed = $('ppEditor'); if (ed) ed.style.display = 'none'; PP.editing = null; }
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
  function bkCard(b) {
    const pay = b.paymentMethod === 'trove' ? `Paid through Trove · your fee ${money(b.providerNetCents)} after a ${pct()}% platform fee` : 'Settled directly with the customer';
    const when = b.preferredDate ? `<b>When:</b> ${esc(b.preferredDate)}<br>` : '';
    const phone = b.phone ? `<b>Mobile:</b> <a href="tel:${esc(b.phone)}" style="text-decoration:underline">${esc(b.phone)}</a><br>` : '';
    const notes = b.notes ? `<b>Brief:</b> ${esc(b.notes)}<br>` : '';
    return `<div class="pp-bk">
      <div class="pp-bkhead"><span class="t">${esc(b.title)}</span><span class="code">${esc(b.code)}</span><span style="flex:1"></span><span class="pp-pill ${b.status}">${b.status}</span></div>
      <div class="pp-bkbody">
        <b>${esc(b.customerName)}</b> · ${esc(b.area)} · ${priceLabel(b)} · ${pay}<br>
        ${when}${phone}${notes}
        <span style="color:var(--muted,rgba(41,39,39,.62));font-size:11.5px">Requested ${fmtDate(b.createdAt)}${b.status === 'requested' ? ' · the customer’s mobile appears once you confirm' : ''}</span>
      </div>
      ${b.status === 'requested' ? `<div class="pp-bkacts">
        <button class="pp-btn pp-green" onclick="ProviderPanel.actBooking(${b.id},'confirm')">✓ Confirm</button>
        <button class="pp-btn pp-ghost" onclick="ProviderPanel.declineBooking(${b.id})">Decline</button></div>` : ''}
      ${b.status === 'confirmed' ? `<div class="pp-bkacts">
        <button class="pp-btn pp-dark" onclick="ProviderPanel.actBooking(${b.id},'complete')">Mark as done</button></div>` : ''}
    </div>`;
  }
  function renderBookings() {
    const el = PP.els.bookings; if (!el) return;
    const open = PP.bookings.filter((b) => b.status === 'requested');
    const upcoming = PP.bookings.filter((b) => b.status === 'confirmed');
    const rest = PP.bookings.filter((b) => !['requested', 'confirmed'].includes(b.status));
    el.innerHTML = `<div class="pp">
      <div class="pp-card"><h3>New requests</h3><div class="pp-hint">Confirm to take the booking — you’ll get the customer’s mobile to arrange the details. Decline with a short note if it’s not one for you.</div>
        ${open.length ? open.map(bkCard).join('') : '<div class="pp-empty">No new requests right now. Requests from the Services Marketplace land here.</div>'}</div>
      <div class="pp-card"><h3>Confirmed</h3><div class="pp-hint">Direct bookings: settle with the customer as you agreed. Bookings paid through Trove: your fee is paid after you mark the booking done.</div>
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
    get provider() { return PP.provider; },
  };
})();
