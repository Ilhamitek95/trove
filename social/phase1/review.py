"""Builds Review.html in ~/Downloads/Trove Phase 1 posts: every post in posting order, with real pictures. Carousels show
their slides; Reels show the playable reel.mp4 plus one still from the middle of every shot (text overlay included) and
the closing card, so nothing on the page is a see-through overlay. Opens straight from the folder, no internet needed.
Run after export.py (export.py calls it at the end)."""
import json, os, subprocess, html, datetime
from urllib.parse import quote

src = os.path.dirname(os.path.abspath(__file__))
dst = os.path.realpath(os.path.join(os.path.expanduser('~'), 'Downloads', 'Trove Phase 1 posts'))
SEG, XF, END = 4.8, 0.4, 3.6  # video/build.js timings
d = json.load(open(src + '/posts.json', encoding='utf-8'))
tags = d['campaign']['hashtags']
shots_dir = os.path.join(dst, '_review')
os.makedirs(shots_dir, exist_ok=True)
for x in os.listdir(shots_dir):
    os.remove(os.path.join(shots_dir, x))
when = lambda p: datetime.datetime.strptime(p['date'].split(' ', 1)[1] + ' 2026', '%d %b %Y')
folders = {f.split(' - Post ')[1].split(' - ')[0]: f for f in os.listdir(dst) if ' - Post ' in f}
e = lambda s: html.escape(s or '')
u = lambda *parts: '/'.join(quote(p) for p in parts)
cards = []
for order, p in enumerate(sorted(d['posts'], key=when), 1):
    n = p['n']
    folder = folders[str(n)]
    files = sorted(os.listdir(os.path.join(dst, folder)))
    cap = p['altCaption'] if n == 10 else p['caption']
    if 'reel.mp4' in files:
        reel = os.path.join(dst, folder, 'reel.mp4')
        dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', reel]))
        count = round((dur - END) / (SEG - XF))
        times = [i * (SEG - XF) + 2.2 for i in range(count)] + [count * (SEG - XF) + 1.6]
        pics = [(u(folder, 'cover.jpg'), 'Cover')]
        for i, t in enumerate(times, 1):
            name = f'post-{n:02d}-{i:02d}.jpg'
            subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{t:.2f}', '-i', reel, '-frames:v', '1', '-vf', 'scale=540:-1', '-q:v', '3',
                            os.path.join(shots_dir, name)], check=True)
            pics.append((u('_review', name), 'Closing card' if i == len(times) else f'Shot {i}'))
        media = (f'<video controls playsinline preload="metadata" poster="{u(folder, "cover.jpg")}" src="{u(folder, "reel.mp4")}"></video>'
                 f'<p class="hint">Reel, {dur:.0f} seconds, silent (add a track in Instagram). Stills from every shot:</p>')
        kind = f'Reel · {count} shots'
    else:
        pics = [(u(folder, f), f'Slide {i}') for i, f in enumerate([f for f in files if f.endswith('.jpg')], 1)]
        media, kind = '', f'Carousel · {len(pics)} slides' + (' (back-up version)' if n == 10 else '')
    strip = ''.join(f'<figure><a href="{s}" target="_blank"><img loading="lazy" src="{s}" alt="{e(l)}"></a><figcaption>{e(l)}</figcaption></figure>' for s, l in pics)
    cards.append(f'''<section id="p{n}"><header><span class="no">{order:02d}</span><div><h2>{e(p["title"])}</h2>
<p class="meta">{e(p["date"])} · Post {n} · {e(kind)}{" · " + e(p.get("colour", "").split(";")[0]) if p.get("colour") else ""}</p></div></header>
{media}<div class="strip">{strip}</div>
<details><summary>Caption</summary><pre>{e(cap)}\n\n{e(tags)}</pre></details></section>''')
nav = ''.join(f'<a href="#p{p["n"]}">{e(p["date"])}</a>' for p in sorted(d['posts'], key=when))
page = f'''<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trove Phase 1 posts</title>
<style>
:root{{--cream:#FDF7F5;--char:#292727;--clay:#DBC7BD;--tan:#BD9C8C}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--cream);color:var(--char);font:15px/1.5 Quicksand,system-ui,sans-serif}}
.top{{padding:28px 20px 8px;max-width:1280px;margin:auto}}h1{{font:500 40px/1.1 Cormorant,Georgia,serif;margin:0 0 6px}}
.top p{{margin:0;color:#6b6262}}nav{{position:sticky;top:0;background:var(--cream);border-bottom:1px solid var(--clay);padding:10px 20px;
display:flex;gap:8px;overflow-x:auto;z-index:2}}nav a{{flex:none;color:var(--char);text-decoration:none;border:1px solid var(--clay);border-radius:999px;padding:4px 12px;font-size:13px}}
main{{max-width:1280px;margin:auto;padding:0 20px 60px}}section{{border-top:1px solid var(--clay);padding:28px 0;scroll-margin-top:60px}}
header{{display:flex;gap:16px;align-items:baseline}}.no{{font:500 34px Cormorant,Georgia,serif;color:var(--tan)}}
h2{{font:500 28px/1.15 Cormorant,Georgia,serif;margin:0}}.meta{{margin:4px 0 16px;color:#6b6262;font-size:13.5px}}
.strip{{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px}}figure{{margin:0;flex:none;width:230px}}
figure img{{width:100%;display:block;border-radius:8px;box-shadow:0 4px 14px rgba(41,39,39,.12);background:#eee}}
figcaption{{font-size:12.5px;color:#6b6262;margin-top:6px}}video{{width:270px;border-radius:10px;background:#000;display:block}}
.hint{{font-size:13px;color:#6b6262}}details{{margin-top:14px;max-width:760px}}summary{{cursor:pointer;font-weight:600}}
pre{{white-space:pre-wrap;font:14px/1.55 Quicksand,system-ui,sans-serif;background:#fff;border:1px solid var(--clay);border-radius:8px;padding:14px}}
@media (max-width:600px){{figure{{width:62vw}}video{{width:70vw}}}}
</style></head><body>
<div class="top"><h1>Trove Phase 1 posts</h1><p>Draft: nothing is scheduled or posted. {len(cards)} posts in posting order, built {datetime.date.today():%d %b %Y}. Click any picture to see it full size.</p></div>
<nav>{nav}</nav><main>{"".join(cards)}</main></body></html>'''
open(os.path.join(dst, 'Review.html'), 'w', encoding='utf-8').write(page)
print('Review.html:', len(cards), 'posts,', len(os.listdir(shots_dir)), 'Reel stills')
