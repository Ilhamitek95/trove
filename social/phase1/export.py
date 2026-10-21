"""Rebuilds ~/Downloads/Trove Phase 1 posts (in OneDrive) from social/phase1: one folder per post, images in order,
caption.txt and a README. Reels (posts with "video" in posts.json) get reel.mp4 from the full-quality build
(<clips>/finished/post-NN.mp4, made by video/build.js) plus cover.jpg. Run: python export.py (after render.js and build.js)."""
import json, os, shutil
from PIL import Image

src = os.path.dirname(os.path.abspath(__file__))
home = os.path.expanduser('~')
dst = os.path.join(home, 'Downloads', 'Trove Phase 1 posts')
clips = os.environ.get('CLIPS') or os.path.join(home, 'OneDrive', 'Downloads', 'Trove Phase 1 video clips')
# The Downloads folder is a link into OneDrive: empty the real folder, keep the link
real = os.path.realpath(dst)
os.makedirs(real, exist_ok=True)
for x in os.listdir(real):
    y = os.path.join(real, x)
    if not os.path.isdir(y):
        os.remove(y)
        continue
    for z in os.listdir(y):
        os.remove(os.path.join(y, z))
    try:
        os.rmdir(y)  # OneDrive sometimes holds a folder open while syncing; an emptied folder is reused below
    except OSError:
        pass
dst = real
d = json.load(open(src + '/posts.json', encoding='utf-8'))
m = json.load(open(src + '/out/manifest.json', encoding='utf-8'))
tags = d['campaign']['hashtags']
plan = []
for p in d['posts']:
    n = p['n']
    frames = [f for f in m if f['post'] == n]
    cap = p['caption']
    video = os.path.join(clips, 'finished', f'post-{n:02d}.mp4') if p.get('video') else None
    if n == 10:
        frames = [f for f in frames if '/alt-' in f['file']]
        status = 'READY (back-up version: no founding maker yet)'
        cap = p['altCaption']
    elif video:
        frames = [f for f in frames if '/cover.' in f['file']]
        status = 'READY: Reel (reel.mp4) with its cover (cover.jpg)' if os.path.exists(video) else 'NOT READY: run video/build.js first'
    else:
        frames = [f for f in frames if f['kind'] == 'slide']
        status = 'READY' if all(f['ready'] for f in frames) else 'NEEDS INPUT'
    title = p['title'].rstrip('.').replace('?', '').replace('[', '').replace(']', '')
    folder = f"{dst}/{n:02d} {p['date']} - {title}"
    os.makedirs(folder, exist_ok=True)
    if video:
        if os.path.exists(video):
            shutil.copyfile(video, folder + '/reel.mp4')
        Image.open(f"{src}/out/{frames[0]['file']}").convert('RGB').save(folder + '/cover.jpg', quality=95)
        count = 'Reel + cover'
    else:
        for i, f in enumerate(frames, 1):
            Image.open(f"{src}/out/{f['file']}").convert('RGB').save(f"{folder}/{i:02d}.jpg", quality=95)
        count = f'{len(frames)} image(s)'
    ai = video or any(f['mood'] for f in frames)
    with open(folder + '/caption.txt', 'w', encoding='utf-8') as fh:
        fh.write(cap + '\n\n' + tags + '\n')
    plan.append(f"{n:02d}  {p['date']:<11} {count:<13} {status}{'  [AI label ON]' if ai else ''}")
with open(dst + '/README.txt', 'w', encoding='utf-8') as fh:
    fh.write('Trove Phase 1 Instagram posts (DRAFT: nothing is scheduled; post only when the owner says launch)\n\n')
    fh.write('Each folder = one post. Carousels: upload the images in number order. Reels: upload reel.mp4, then\n')
    fh.write('Edit cover -> Add from camera roll -> cover.jpg. Reels are silent: tap Add audio and pick a quiet track.\n')
    fh.write('Paste caption.txt. Posts marked [AI label ON] use Higgsfield images or video: in Instagram,\n')
    fh.write('Advanced settings -> turn on "Add AI label".\n')
    fh.write('Pin posts 1 to 3. Link in bio: troveathome.com/apply. Post 14 is for December (Marketplace open).\n\n')
    fh.write('\n'.join(plan) + '\n')
print('\n'.join(plan))
