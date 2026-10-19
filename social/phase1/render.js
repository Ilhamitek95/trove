// Renders every frame in frames.js to out/post-NN/<id>.png with headless Chrome.
// Run: node render.js   (needs playwright-core; drop real photos into ./photos first)
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const frames = require('./frames');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FONTS = path.resolve(__dirname, '../../docs/fonts').replace(/\\/g, '/');
const PHOTOS = path.join(__dirname, 'photos');
const OUT = path.join(__dirname, 'out');

const BG = { cream: '#FDF7F5', clay: '#DBC7BD', sage: '#CAD5CC', blue: '#BED3DF', clear: 'transparent' };
const SIZE = { slide: [1080, 1350], reel: [1080, 1920] };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// [placeholder] → dashed box, | → line break
const fmt = (s) => esc(s || '').replace(/\[([^\]]+)\]/g, '<span class="ph">$1</span>').replace(/\|/g, '<br>');

function photoTag(f) {
  const file = f.photo && path.join(PHOTOS, f.photo);
  if (file && fs.existsSync(file)) return `<img class="ph-img" src="file:///${file.replace(/\\/g, '/')}">`;
  return `<div class="slot"><span>Photo</span>${esc(f.slot || f.photo || '')}</div>`;
}

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

function inner(f, n, total) {
  const [w, h] = SIZE[f.kind];
  const counter = f.kind === 'slide' && total > 1 ? `<div class="ct">${n} / ${total}</div>` : '';
  const wm = '<div class="wm">trove<i></i></div>';
  const url = '<div class="url">troveathome.com/apply</div>';
  const swipe = f.foot ? `<div class="sw">${esc(f.foot)} →</div>` : '';
  switch (f.layout) {
    case 'hero':
      return `${wm}${counter}<div class="box" style="bottom:200px"><div class="d" style="font-size:118px;line-height:1.02">${fmt(f.title)}</div>${f.body ? `<p class="body" style="margin-top:44px">${fmt(f.body)}</p>` : ''}</div>${url}${swipe}`;
    case 'strike':
      return `${wm}${counter}<div class="box" style="top:430px"><div class="small">You don’t need</div><div class="d" style="font-size:124px;line-height:1.05;margin-top:26px;text-decoration:line-through;text-decoration-color:#BD9C8C;text-decoration-thickness:7px">${fmt(f.strike)}</div><p class="body" style="margin-top:60px">${fmt(f.body)}</p></div>${url}`;
    case 'cta':
      return `${wm}${counter}<div class="box" style="bottom:230px"><div class="d" style="font-size:112px;line-height:1.04">${fmt(f.title)}</div><p class="body" style="margin-top:40px">${fmt(f.body)}</p><div style="margin-top:56px"><span class="pill">troveathome.com/apply</span></div></div>`;
    case 'figure':
    case 'split':
      return `${wm}${counter}<div class="box" style="top:420px"><div class="small">${fmt(f.small)}</div><div class="d" style="font-size:230px;line-height:1;margin-top:30px">${fmt(f.figure)}</div>${f.body ? `<p class="body" style="font-size:52px;margin-top:24px">${fmt(f.body)}</p>` : ''}</div>${url}`;
    case 'list':
      return `${wm}${counter}<div class="box" style="top:260px"><div class="d" style="font-size:84px;line-height:1.05">${fmt(f.title)}</div><ul style="list-style:none;margin-top:50px">${f.items.map((it) => `<li style="font-size:44px;padding:22px 0;border-top:2px solid rgba(41,39,39,.15)">${fmt(it)}</li>`).join('')}</ul></div>${url}`;
    case 'quote':
      return `${wm}${counter}<div class="box" style="top:340px"><div class="d" style="font-size:86px;line-height:1.12">${fmt(f.title)}</div><p class="body" style="margin-top:50px;opacity:.75">${fmt(f.body)}</p></div>${url}`;
    case 'photo': {
      const band = 300;
      return `<div style="position:absolute;left:0;right:0;top:0;height:${h - band}px">${photoTag(f)}</div>
        <div style="position:absolute;left:0;right:0;bottom:0;height:${band}px;background:#FDF7F5"></div>
        <div class="box" style="bottom:120px"><div class="d" style="font-size:${f.caption && f.caption.length > 34 ? 62 : 74}px;line-height:1.08">${fmt(f.caption || '')}</div></div>
        <div class="url" style="bottom:52px;font-size:26px">trove · troveathome.com/apply</div>${counter.replace('class="ct"', 'class="ct" style="background:#FDF7F5;padding:8px 18px;border-radius:999px;opacity:.9;top:56px"')}`;
    }
    case 'cover':
      return `<div class="wm" style="left:0;right:0;text-align:center;top:300px">trove<i></i></div><div style="position:absolute;left:90px;right:90px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;text-align:center"><div class="small" style="font-size:38px">${fmt(f.kicker)}</div><div class="d" style="font-size:150px;line-height:1.02;margin-top:40px">${fmt(f.title)}</div></div>`;
    case 'end':
      return `<div class="wm" style="left:0;right:0;text-align:center;top:300px">trove<i></i></div><div style="position:absolute;left:90px;right:90px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center"><div class="d" style="font-size:128px;line-height:1.04">${fmt(f.title)}</div>${f.body ? `<p class="body" style="margin-top:44px;font-size:44px">${fmt(f.body)}</p>` : ''}<p class="body" style="margin-top:70px;font-size:40px">Apply in ten minutes.</p><div style="margin-top:26px"><span class="pill" style="font-size:40px">troveathome.com/apply</span></div></div>`;
    case 'lower-third':
      return `<div style="position:absolute;left:0;right:0;top:1330px;text-align:center"><span class="pill" style="background:#FDF7F5;color:#292727;font-size:46px;padding:30px 54px;box-shadow:0 8px 30px rgba(0,0,0,.12)">${fmt(f.text)}</span></div>`;
    case 'reel-photo':
      return `${photoTag(f)}<div style="position:absolute;left:0;right:0;top:1330px;text-align:center"><span class="pill" style="background:#FDF7F5;color:#292727;font-size:50px;padding:32px 58px">${fmt(f.text)}</span></div>`;
  }
  throw new Error('unknown layout ' + f.layout);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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
    const jpg = f.layout === 'photo' || f.layout === 'reel-photo';
    const name = (/^\d+$/.test(f.id) ? 'slide-' + f.id.padStart(2, '0') : f.id) + (jpg ? '.jpg' : '.png');
    await page.screenshot(jpg ? { path: path.join(dir, name), type: 'jpeg', quality: 90 } : { path: path.join(dir, name), omitBackground: f.bg === 'clear' });
    const placeholders = /\[/.test(JSON.stringify(f)) || (f.photo && !fs.existsSync(path.join(PHOTOS, f.photo)));
    manifest.push({ post: f.post, file: `post-${String(f.post).padStart(2, '0')}/${name}`, kind: f.kind, layout: f.layout, ready: !placeholders, note: f.note || '' });
  }
  fs.rmSync(path.join(__dirname, '_frame.html'), { force: true });
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  console.log(manifest.length, 'frames,', manifest.filter((m) => m.ready).length, 'ready to post');
})();
