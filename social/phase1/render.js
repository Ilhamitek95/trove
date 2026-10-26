// Renders every frame in frames.js to out/post-NN/<id>.png with headless Chrome.
// Run: node render.js   (needs playwright-core; drop real photos into ./photos first)
// v5 (20 Oct 2026): also renders screens/shop-example.html to screens/shop-example-full.png, clears out/ first,
// adds the 'type' layout (bold type card: one headline, one line, the offer along the bottom) and the small
// sign-off line (f.sign) on end cards.
// v6 (26 Oct 2026, V6-PLAN.md "Renderer changes"): more brand colours for bands and Reel cover cards (pink, green = Light
// Green, tan, char = Charcoal); Cream type and a Cream wordmark dot on Charcoal, a Charcoal dot on Light Blue (never
// Orange with Charcoal or Light Blue); f.pos = object-position of a photo slide; Reel cover card colour from f.card;
// Reel end cards with lead: null drop the 'Apply in about ten minutes.' line.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const frames = require('./frames');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FONTS = path.resolve(__dirname, '../../docs/fonts').replace(/\\/g, '/');
const PHOTOS = path.join(__dirname, 'photos');
const OUT = path.join(__dirname, 'out');

const BG = { cream: '#FDF7F5', clay: '#DBC7BD', sage: '#CAD5CC', blue: '#BED3DF', pink: '#F8D7E4', green: '#CFDBBE', tan: '#BD9C8C', char: '#292727', clear: 'transparent' };
const CREAM = '#FDF7F5', CHAR = '#292727';
// The wordmark's dot: Orange by default, Cream on Charcoal, Charcoal on Light Blue (never Orange next to either)
const DOT = { char: CREAM, blue: CHAR };
const wmDot = (bg) => (DOT[bg] ? `<i style="background:${DOT[bg]}"></i>` : '<i></i>');
const SIZE = { slide: [1080, 1350], reel: [1080, 1920] };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// [placeholder] → dashed box, | → line break
const fmt = (s) => esc(s || '').replace(/\[([^\]]+)\]/g, '<span class="ph">$1</span>').replace(/\|/g, '<br>');

function photoTag(f) {
  const file = f.photo && path.join(PHOTOS, f.photo);
  if (file && fs.existsSync(file)) return `<img class="ph-img" src="file:///${file.replace(/\\/g, '/')}"${f.pos ? ` style="object-position:${esc(f.pos)}"` : ''}>`;
  return `<div class="slot"><span>Real photo</span>${esc(f.slot || f.photo || '')}${f.photo ? `<small style="font-size:24px;opacity:.65">photos/${esc(f.photo)}</small>` : ''}</div>`;
}
// Small campaign sign-off, end cards only (v5: "Made here. Made home." is no longer a headline)
const signTag = (f, style = '') => (f.sign ? `<div class="url d" style="font-size:38px;opacity:.85;${style}">${fmt(f.sign)}</div>` : '');

const CSS = `
@font-face{font-family:Cormorant;src:url(file:///${FONTS}/cormorant-latin.woff2) format('woff2');font-weight:400 600}
@font-face{font-family:Quicksand;src:url(file:///${FONTS}/quicksand-latin.woff2) format('woff2');font-weight:300 700}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:transparent}
.f{position:relative;overflow:hidden;color:#292727;font-family:Quicksand,sans-serif;font-weight:500}
.wm{position:absolute;top:64px;left:72px;font-family:Cormorant;font-weight:500;font-size:52px;line-height:1;letter-spacing:.01em}
.wm i{display:inline-block;width:11px;height:11px;border-radius:50%;background:#F19A82;margin-left:4px;vertical-align:baseline}
.ct{position:absolute;top:78px;right:72px;font-size:26px;opacity:.6}
.url{position:absolute;bottom:64px;left:72px;font-size:28px;opacity:.75}
.sw{position:absolute;bottom:64px;right:72px;font-size:28px;opacity:.75}
.d{font-family:Cormorant;font-weight:500;letter-spacing:-.005em}
.ph{border:3px dashed #BD9C8C;border-radius:10px;padding:0 .18em;background:rgba(253,247,245,.55)}
.body{font-size:40px;line-height:1.35;max-width:880px}
.small{font-size:36px;opacity:.75}
.pill{display:inline-block;background:#292727;color:#FDF7F5;border-radius:999px;padding:26px 48px;font-size:36px;font-weight:600}
.box{position:absolute;left:72px;right:72px}
.slot{position:absolute;inset:0;background:#DBC7BD;border:4px dashed #BD9C8C;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:80px;font-size:38px;line-height:1.35;gap:18px}
.slot span{font-family:Cormorant;font-size:64px}
.ph-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
`;

// 21 Oct 2026 (owner: every carousel needs images): a steps, grid or Q&A slide with f.img gets a photo strip
// across the top (f.img in ./photos), a cream wordmark pill on it, and its content set smaller below.
const STRIP = 600;
const pillCounter = (counter) => counter.replace('class="ct"', 'class="ct" style="background:#FDF7F5;padding:8px 18px;border-radius:999px;opacity:.9;top:56px"');
const strip = (f, counter, height = STRIP) => `<div style="position:absolute;left:0;right:0;top:0;height:${height}px">${photoTag({ photo: f.img, slot: f.img })}</div>`
  + `<div class="wm" style="top:48px;left:56px;font-size:40px;background:#FDF7F5;padding:10px 22px 14px;border-radius:999px">trove<i></i></div>${pillCounter(counter)}`;

function inner(f, n, total) {
  const [w, h] = SIZE[f.kind];
  const counter = f.kind === 'slide' && total > 1 ? `<div class="ct">${n} / ${total}</div>` : '';
  const wm = '<div class="wm">trove<i></i></div>';
  const url = `<div class="url">${f.foot ? fmt(f.foot) : 'troveathome.com/apply'}</div>`;
  const swipe = f.foot ? `<div class="sw">${esc(f.foot)} →</div>` : '';
  switch (f.layout) {
    case 'hero':
      return `${wm}${counter}<div class="box" style="bottom:200px"><div class="d" style="font-size:${f.size || 118}px;line-height:1.02">${fmt(f.title)}</div>${f.body ? `<p class="body" style="margin-top:44px">${fmt(f.body)}</p>` : ''}</div>${url}${swipe}`;
    case 'strike':
      return `${wm}${counter}<div class="box" style="top:430px"><div class="small">You don’t need</div><div class="d" style="font-size:124px;line-height:1.05;margin-top:26px;text-decoration:line-through;text-decoration-color:#BD9C8C;text-decoration-thickness:7px">${fmt(f.strike)}</div><p class="body" style="margin-top:60px">${fmt(f.body)}</p></div>${url}`;
    case 'cta':
      // With f.img (21 Oct): a photo across the top two-thirds, the call to action set smaller below it
      if (f.img) return `${strip(f, counter, 680)}<div class="box" style="bottom:150px"><div class="d" style="font-size:80px;line-height:1.04">${fmt(f.title)}</div>${f.body ? `<p class="body" style="margin-top:22px;font-size:36px">${fmt(f.body)}</p>` : ''}<div style="margin-top:34px"><span class="pill" style="font-size:32px;padding:22px 40px">troveathome.com/apply</span></div></div>${signTag(f)}`;
      return `${wm}${counter}<div class="box" style="bottom:230px"><div class="d" style="font-size:${f.size || 112}px;line-height:1.04">${fmt(f.title)}</div>${f.body ? `<p class="body" style="margin-top:40px">${fmt(f.body)}</p>` : ''}<div style="margin-top:56px"><span class="pill">troveathome.com/apply</span></div></div>${signTag(f)}`;
    case 'type':
      // v5 bold type card: optional kicker, one headline, one line, the offer (or the address) along the bottom
      return `${wm}${counter}<div class="box" style="${f.top ? `top:${f.top}px` : 'top:170px;bottom:170px;display:flex;flex-direction:column;justify-content:center'}">${f.kicker ? `<div class="small" style="margin-bottom:34px">${fmt(f.kicker)}</div>` : ''}<div class="d" style="font-size:${f.size || 132}px;line-height:1">${fmt(f.title)}</div>${f.body ? `<p class="body" style="margin-top:52px;font-size:${f.bodySize || 46}px;line-height:1.38">${fmt(f.body)}</p>` : ''}</div><div class="url">${fmt(f.foot || 'troveathome.com')}</div>`;
    case 'figure':
    case 'split':
      return `${wm}${counter}<div class="box" style="top:420px"><div class="small">${fmt(f.small)}</div><div class="d" style="font-size:230px;line-height:1;margin-top:30px">${fmt(f.figure)}</div>${f.body ? `<p class="body" style="font-size:52px;margin-top:24px">${fmt(f.body)}</p>` : ''}</div>${url}`;
    case 'list':
      return `${wm}${counter}<div class="box" style="top:260px"><div class="d" style="font-size:84px;line-height:1.05">${fmt(f.title)}</div><ul style="list-style:none;margin-top:50px">${f.items.map((it) => `<li style="font-size:44px;padding:22px 0;border-top:2px solid rgba(41,39,39,.15)">${fmt(it)}</li>`).join('')}</ul></div>${url}`;
    case 'phone':
    case 'reel-phone': {
      // A real Trove page (or the shop template) on a phone. screens/<screen> is a 1170px-wide (3x) capture.
      const reel = f.layout === 'reel-phone';
      if (f.img && !reel) {
        // 21 Oct: the phone sits on a full-bleed photo (f.img), with the headline on a cream card above it
        const pw = 640, bez = 18, sw = pw - bez * 2, scale = sw / 1170, top = 470, left = (w - pw) / 2;
        const src = 'file:///' + path.join(__dirname, 'screens', f.screen).split(path.sep).join('/');
        return `<div style="position:absolute;inset:0">${photoTag({ photo: f.img, slot: f.img })}</div>`
          + `<div style="position:absolute;left:56px;right:56px;top:56px;background:#FDF7F5;border-radius:24px;padding:34px 40px 38px;box-shadow:0 12px 40px rgba(41,39,39,.14)"><div class="wm" style="position:static;font-size:38px">trove<i></i></div><div class="d" style="font-size:64px;line-height:1.04;margin-top:18px">${fmt(f.title)}</div>${f.sub ? `<p class="body" style="margin-top:14px;font-size:32px">${fmt(f.sub)}</p>` : ''}</div>${counter}`
          + `<div style="position:absolute;left:${left}px;top:${top}px;width:${pw}px;height:${h}px;background:#292727;border-radius:60px;padding:${bez}px;box-shadow:0 30px 70px rgba(41,39,39,.35)"><div style="width:${sw}px;height:100%;border-radius:46px;overflow:hidden;background:#FDF7F5"><img src="${src}" style="display:block;width:${sw}px;margin-top:-${Math.round((f.offset || 0) * 3 * scale)}px"></div></div>`
          + (f.label ? `<div style="position:absolute;right:72px;top:${top + 40}px;background:#FDF7F5;border-radius:999px;padding:10px 20px;font-size:24px;box-shadow:0 6px 20px rgba(0,0,0,.12)">${fmt(f.label)}</div>` : '');
      }
      const pw = reel ? 820 : 780, bez = 20, sw = pw - bez * 2, scale = sw / 1170;
      const top = f.phoneTop || (reel ? 700 : (f.sub ? 560 : 470));
      const src = 'file:///' + path.join(__dirname, 'screens', f.screen).split(path.sep).join('/');
      const head = reel
        ? `<div class="wm" style="left:0;right:0;text-align:center;top:260px">trove<i></i></div><div style="position:absolute;left:90px;right:90px;top:360px;text-align:center"><div class="d" style="font-size:${f.size || 96}px;line-height:1.04">${fmt(f.title)}</div>${f.sub ? `<p class="body" style="margin:24px auto 0;font-size:38px">${fmt(f.sub)}</p>` : ''}</div>`
        : `${wm}${counter}<div class="box" style="top:170px"><div class="d" style="font-size:${f.size || 80}px;line-height:1.04">${fmt(f.title)}</div>${f.sub ? `<p class="body" style="margin-top:20px;font-size:36px">${fmt(f.sub)}</p>` : ''}</div>`;
      return `${head}<div style="position:absolute;left:${(w - pw) / 2}px;top:${top}px;width:${pw}px;height:${h}px;background:#292727;border-radius:68px;padding:${bez}px;box-shadow:0 30px 70px rgba(41,39,39,.22)"><div style="width:${sw}px;height:100%;border-radius:52px;overflow:hidden;background:#FDF7F5"><img src="${src}" style="display:block;width:${sw}px;margin-top:-${Math.round((f.offset || 0) * 3 * scale)}px"></div></div>${f.label ? `<div style="position:absolute;right:72px;top:${top + 40}px;background:#FDF7F5;border-radius:999px;padding:10px 20px;font-size:24px;box-shadow:0 6px 20px rgba(0,0,0,.08)">${fmt(f.label)}</div>` : ''}`;
    }
    case 'grid': {
      const im = !!f.img;
      return `${im ? strip(f, counter) : wm + counter}<div class="box" style="top:${im ? STRIP + 60 : 230}px"><div class="d" style="font-size:${im ? 72 : f.size || 96}px;line-height:1.04">${fmt(f.title)}</div><div style="display:flex;flex-wrap:wrap;gap:${im ? 16 : 20}px;margin-top:${im ? 40 : 64}px">${f.items.map((it) => `<span style="font-size:${im ? 36 : 46}px;border:2px solid rgba(41,39,39,.22);background:rgba(255,255,255,.55);border-radius:999px;padding:${im ? '14px 26px' : '20px 34px'}">${fmt(it)}</span>`).join('')}</div>${f.sub ? `<p class="body" style="margin-top:${im ? 32 : 56}px${im ? ';font-size:34px' : ''}">${fmt(f.sub)}</p>` : ''}</div>${url}`;
    }
    case 'steps': {
      const im = !!f.img, c = im ? 76 : 96;
      return `${im ? strip(f, counter) : wm + counter}<div class="box" style="top:${im ? STRIP + 60 : 230}px"><div class="d" style="font-size:${im ? 72 : f.size || 96}px;line-height:1.04">${fmt(f.title)}</div><ol style="list-style:none;margin-top:${im ? 40 : 70}px;display:flex;flex-direction:column;gap:${im ? 24 : 40}px">${f.steps.map((st, i) => `<li style="display:flex;align-items:center;gap:${im ? 26 : 30}px"><span style="font-weight:600;flex:none;width:${c}px;height:${c}px;border-radius:50%;background:${f.bg === 'sage' ? '#FDF7F5' : '#CAD5CC'};display:flex;align-items:center;justify-content:center;font-size:${im ? 36 : 42}px">${i + 1}</span><span style="font-size:${im ? 40 : 48}px;line-height:1.25">${fmt(st)}</span></li>`).join('')}</ol></div>${url}`;
    }
    case 'pair':
      return `${wm}${counter}<div class="box" style="top:400px"><div class="small">You</div><div class="d" style="font-size:90px;line-height:1.05;margin-top:14px">${fmt(f.you)}</div><div style="border-top:2px solid rgba(41,39,39,.18);margin:64px 0 56px"></div><div class="small">Trove</div><div class="d" style="font-size:90px;line-height:1.05;margin-top:14px">${fmt(f.trove)}</div></div>${url}`;
    case 'qa': {
      const im = !!f.img;
      return `${im ? strip(f, counter) : wm + counter}<div class="box" style="top:${im ? STRIP + 60 : 330}px"><div class="d" style="font-size:${im ? 76 : 96}px;line-height:1.04">${fmt(f.q)}</div><p class="body" style="margin-top:${im ? 36 : 54}px;font-size:${im ? 40 : 46}px;line-height:1.42">${fmt(f.a)}</p></div>${url}`;
    }
    case 'quote':
      return `${wm}${counter}<div class="box" style="top:340px"><div class="d" style="font-size:86px;line-height:1.12">${fmt(f.title)}</div><p class="body" style="margin-top:50px;opacity:.75">${fmt(f.body)}</p></div>${url}`;
    case 'photo': {
      const size = f.size || (f.big ? 84 : 58);
      const lines = (f.caption || '').split('|').length;
      const need = 120 + lines * size * 1.06 + (f.sub ? 14 + Math.ceil(f.sub.length / 46) * 49 : 0) + (f.big ? 110 : 60);
      const band = Math.max(f.big ? 400 : 300, Math.ceil(need));
      if (f.band && !BG[f.band]) throw new Error('unknown band ' + f.band);
      const ink = f.band === 'char' ? `;color:${CREAM}` : ''; // Cream type on Charcoal
      return `<div style="position:absolute;left:0;right:0;top:0;height:${h - band}px">${photoTag(f)}</div>
        <div style="position:absolute;left:0;right:0;bottom:0;height:${band}px;background:${f.band ? BG[f.band] : CREAM}"></div>
        ${f.big ? `<div class="wm" style="top:auto;bottom:${band - 96}px;font-size:40px${ink}">trove${wmDot(f.band)}</div>` : ''}
        <div class="box" style="bottom:120px${ink}"><div class="d" style="font-size:${size}px;line-height:1.06">${fmt(f.caption || '')}</div>${f.sub ? `<p class="body" style="margin-top:14px;font-size:36px">${fmt(f.sub)}</p>` : ''}</div>
        <div class="url" style="bottom:52px;font-size:26px${ink}">${f.foot ? fmt(f.foot) : 'trove · troveathome.com/apply'}</div>${pillCounter(counter)}`;
    }
    case 'cover':
      return `<div class="wm" style="left:0;right:0;text-align:center;top:300px">trove<i></i></div><div style="position:absolute;left:90px;right:90px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;text-align:center"><div class="small" style="font-size:38px">${fmt(f.kicker)}</div><div class="d" style="font-size:150px;line-height:1.02;margin-top:40px">${fmt(f.title)}</div></div>`;
    case 'end':
      return `<div class="wm" style="left:0;right:0;text-align:center;top:300px">trove<i></i></div><div style="position:absolute;left:90px;right:90px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center"><div class="d" style="font-size:${f.size || 128}px;line-height:1.04">${fmt(f.title)}</div>${f.body ? `<p class="body" style="margin-top:44px;font-size:44px">${fmt(f.body)}</p>` : ''}${f.lead === null ? '' : `<p class="body" style="margin-top:70px;font-size:40px">${fmt(f.lead || 'Apply in about ten minutes.')}</p>`}<div style="margin-top:${f.lead === null ? 64 : 26}px"><span class="pill" style="font-size:40px">${fmt(f.pill || 'troveathome.com/apply')}</span></div></div>${signTag(f, 'left:0;right:0;text-align:center;bottom:400px')}`;
    // Reel text sits above Instagram's caption area and clear of the buttons on the right (top 1240, 860 px wide at most)
    case 'lower-third':
      return `<div style="position:absolute;left:90px;right:130px;top:1240px;text-align:center"><span class="pill" style="display:inline-block;background:#FDF7F5;color:#292727;font-size:44px;line-height:1.3;padding:28px 50px;border-radius:48px;box-shadow:0 8px 30px rgba(0,0,0,.12)">${fmt(f.text)}</span></div>`;
    case 'reel-hook':
      return `<div style="position:absolute;left:90px;right:130px;top:1060px;background:#FDF7F5;border-radius:6px;padding:46px 48px 52px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.12)"><div class="wm" style="position:static;font-size:40px">trove<i></i></div><div class="d" style="font-size:${f.size || 92}px;line-height:1.02;margin-top:18px">${fmt(f.title)}</div></div>`;
    case 'reel-cover-photo':
      return `<div style="position:absolute;inset:0;${f.photo && fs.existsSync(path.join(PHOTOS, f.photo)) ? '' : 'bottom:910px'}">${photoTag(f)}</div><div style="position:absolute;left:90px;right:90px;top:1010px;background:${BG[f.card || 'cream']};border-radius:6px;padding:56px 56px 60px;text-align:center"><div class="wm" style="position:static;font-size:44px">trove${wmDot(f.card)}</div><div class="small" style="font-size:34px;margin-top:26px">${fmt(f.kicker)}</div><div class="d" style="font-size:${f.size || 112}px;line-height:1.02;margin-top:22px">${fmt(f.title)}</div>${f.sub ? `<p class="body" style="margin:26px auto 0;font-size:38px">${fmt(f.sub)}</p>` : ''}</div>`;
    case 'reel-photo':
      return `${photoTag(f)}<div style="position:absolute;left:0;right:0;top:1330px;text-align:center"><span class="pill" style="background:#FDF7F5;color:#292727;font-size:50px;padding:32px 58px;max-width:900px;line-height:1.3;border-radius:48px">${fmt(f.text)}</span></div>`;
  }
  throw new Error('unknown layout ' + f.layout);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // Screens built from HTML (the example shop page) → 1170px-wide captures in ./screens
  for (const name of ['shop-example']) {
    const sp = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    await sp.goto('file:///' + path.join(__dirname, 'screens', name + '.html').split(path.sep).join('/'), { waitUntil: 'load' });
    await sp.evaluate(() => document.fonts.ready);
    await sp.screenshot({ path: path.join(__dirname, 'screens', name + '-full.png'), fullPage: true });
    await sp.close();
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  const page = await browser.newPage();
  const manifest = [];
  for (const f of frames) {
    const siblings = frames.filter((x) => x.post === f.post && x.kind === 'slide' && x.layout !== undefined && /^\d+$/.test(x.id));
    const n = siblings.indexOf(f) + 1;
    const [w, h] = SIZE[f.kind];
    await page.setViewportSize({ width: w, height: h });
    const tmp = path.join(__dirname, '_frame.html');
    fs.writeFileSync(tmp, `<!doctype html><html><head><style>${CSS}</style></head><body><div class="f" style="width:${w}px;height:${h}px;background:${BG[f.bg]}">${inner(f, n, n ? siblings.length : 0)}</div></body></html>`);
    await page.goto('file:///' + tmp.split(path.sep).join('/'), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const dir = path.join(OUT, 'post-' + String(f.post).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const jpg = f.layout === 'photo' || f.layout === 'reel-photo' || (f.layout === 'reel-cover-photo' && f.mood) || !!f.img;
    const name = (/^\d+$/.test(f.id) ? 'slide-' + f.id.padStart(2, '0') : f.id) + (jpg ? '.jpg' : '.png');
    await page.screenshot(jpg ? { path: path.join(dir, name), type: 'jpeg', quality: 90 } : { path: path.join(dir, name), omitBackground: f.bg === 'clear' });
    // Only [bracketed words] inside the frame's text count, not the brackets of its JSON arrays (v4 marked every list "Needs input")
    const texts = [];
    JSON.stringify(f, (k, v) => (typeof v === 'string' && texts.push(v), v));
    const missing = [f.photo, f.img].find((p) => p && !fs.existsSync(path.join(PHOTOS, p)));
    const placeholders = texts.some((t) => /\[[^\]]+\]/.test(t)) || !!missing;
    manifest.push({ post: f.post, file: `post-${String(f.post).padStart(2, '0')}/${name}`, kind: f.kind, layout: f.layout, ready: !placeholders, mood: !!f.mood, upgrade: f.upgrade || '', slot: missing ? f.slot || missing : '', note: f.note || '' });
  }
  fs.rmSync(path.join(__dirname, '_frame.html'), { force: true });
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  console.log(manifest.length, 'frames,', manifest.filter((m) => m.ready).length, 'ready to post');
})();
