// Cuts the pillar Reels in reels.js into finished videos with ffmpeg (owner, 21 Oct 2026: a video post for each pillar).
// Each shot: the first SEG seconds of its clip, its text overlay (out/post-NN/<overlay>.png from render.js) faded in and
// out, a short crossfade into the next shot, then the closing card (out/post-NN/end.png). A silent stereo track is added
// so every app accepts the file; add music from Instagram's own audio library when posting.
// Writes <CLIPS>/finished/post-NN.mp4 (1080x1920, full quality, for Instagram) and video/out/post-NN.mp4 (720x1280
// preview for the review page). Run after render.js: node video/build.js [post ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const reels = require('./reels');

const ROOT = path.resolve(__dirname, '..');
const CLIPS = process.env.CLIPS || path.join(os.homedir(), 'OneDrive', 'Downloads', 'Trove Phase 1 video clips');
const MASTER = path.join(CLIPS, 'finished');
const PREVIEW = path.join(__dirname, 'out');
const SEG = 4.8; // seconds used from each 5-second clip
const XF = 0.4; // crossfade between shots
const END = 3.6; // closing card
const FPS = 24; // Kling's own frame rate

const only = process.argv.slice(2).map(Number);
fs.mkdirSync(MASTER, { recursive: true });
fs.mkdirSync(PREVIEW, { recursive: true });

for (const r of reels.filter((x) => !only.length || only.includes(x.post))) {
  const nn = String(r.post).padStart(2, '0');
  const dir = path.join(ROOT, 'out', 'post-' + nn);
  const args = ['-y', '-v', 'error'];
  const graph = [];
  r.shots.forEach((s, i) => {
    args.push('-i', path.join(CLIPS, s.clip));
    args.push('-loop', '1', '-framerate', String(FPS), '-t', String(SEG), '-i', path.join(dir, s.overlay + '.png'));
    const v = 2 * i;
    // The opening line is on screen from the first frame; later lines fade in once the shot has settled
    const fadeIn = i === 0 ? '' : `fade=t=in:st=0.4:d=0.35:alpha=1,`;
    graph.push(`[${v}:v]trim=0:${SEG},setpts=PTS-STARTPTS,scale=1080:1920,fps=${FPS},format=yuv420p,settb=AVTB[c${i}]`);
    graph.push(`[${v + 1}:v]format=rgba,${fadeIn}fade=t=out:st=${(SEG - XF - 0.4).toFixed(2)}:d=0.35:alpha=1,settb=AVTB[o${i}]`);
    graph.push(`[c${i}][o${i}]overlay=0:0:format=auto,format=yuv420p,settb=AVTB[s${i}]`);
  });
  const e = 2 * r.shots.length;
  args.push('-loop', '1', '-framerate', String(FPS), '-t', String(END), '-i', path.join(dir, 'end.png'));
  graph.push(`[${e}:v]scale=1080:1920,format=yuv420p,settb=AVTB[s${r.shots.length}]`);
  let prev = 's0';
  for (let i = 1; i <= r.shots.length; i++) {
    const out = i === r.shots.length ? 'v' : `x${i}`;
    graph.push(`[${prev}][s${i}]xfade=transition=fade:duration=${XF}:offset=${(i * (SEG - XF)).toFixed(2)}[${out}]`);
    prev = out;
  }
  const total = r.shots.length * (SEG - XF) + END;
  args.push('-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo');
  const master = path.join(MASTER, `post-${nn}.mp4`);
  execFileSync('ffmpeg', [...args, '-filter_complex', graph.join(';'), '-map', '[v]', '-map', `${e + 1}:a`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', master], { stdio: 'inherit' });
  const preview = path.join(PREVIEW, `post-${nn}.mp4`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', master, '-vf', 'scale=720:1280', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', preview], { stdio: 'inherit' });
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1) + ' MB';
  console.log(`post ${r.post} (${r.pillar}): ${total.toFixed(1)} s, ${mb(master)} → ${master}; preview ${mb(preview)}`);
}
