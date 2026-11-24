import { chromium } from 'playwright';
import { mkdir, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VO = join(HERE, 'vo');
const SFX = join(HERE, 'sfx');
const PAGE = resolve(process.env.PAGE ?? join(HERE, '..', 'out', 'index.html'));
const OUT = resolve(process.argv[2] ?? join(HERE, 'maze-replay-demo.mp4'));
const FRAMES = join(process.env.TMPDIR ?? '/tmp', `maze-replay-frames-${Date.now()}`);
const SFX_GAIN = Number(process.env.SFX_GAIN ?? 0.35);

const vo = existsSync(join(VO, 'vo.json')) ? JSON.parse(await readFile(join(VO, 'vo.json'), 'utf8')) : {};
await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: Number(process.env.DPR ?? 1), colorScheme: 'dark' });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.addInitScript(d => { window.VO_DUR = d; }, vo);
const cdp = await page.context().newCDPSession(page);
const frames = [];
const writes = [];
cdp.on('Page.screencastFrame', async f => {
  const i = frames.length;
  frames.push({ file: `f${String(i).padStart(6, '0')}.jpg`, t: f.metadata.timestamp });
  writes.push(writeFile(join(FRAMES, frames[i].file), Buffer.from(f.data, 'base64')));
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await page.goto(`${pathToFileURL(PAGE).href}?demo`, { waitUntil: 'load' });
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await page.waitForFunction(() => window.demoDone, null, { timeout: 400_000, polling: 500 });
await cdp.send('Page.stopScreencast');
const cues = (await page.evaluate(() => window.demoCues ?? [])) ?? [];
await new Promise(r => setTimeout(r, 500));
await browser.close();
await Promise.all(writes);

frames.sort((a, b) => a.t - b.t);
const dur = frames.at(-1).t - frames[0].t;
console.log(`${frames.length} frames over ${dur.toFixed(1)} s (${(frames.length / dur).toFixed(1)} fps captured)`);
const list = frames.map((f, i) => `file '${join(FRAMES, f.file)}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 0.04) - f.t).toFixed(4)}`).join('\n') + `\nfile '${join(FRAMES, frames.at(-1).file)}'\n`;
await writeFile(join(FRAMES, 'list.txt'), list);
const SILENT = join(FRAMES, 'silent.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(FRAMES, 'list.txt'), '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', SILENT], { stdio: 'inherit' });

const clips = cues.map(c => {
  const sfx = c.id.startsWith('sfx:');
  const file = sfx ? join(SFX, `${c.id.slice(4)}.wav`) : join(VO, `${c.id}.wav`);
  return { id: c.id, file, sfx, off: Math.max(0, c.t - frames[0].t), dur: sfx ? 0 : vo[c.id] ?? 0 };
}).filter(c => existsSync(c.file)).sort((a, b) => a.off - b.off);
const voClips = clips.filter(c => !c.sfx);
voClips.forEach((c, i) => {
  const n = voClips[i + 1];
  console.log(`cue ${c.id}: ${c.off.toFixed(2)} s for ${c.dur.toFixed(2)} s`);
  if (n && c.off + c.dur > n.off) console.log(`WARN overlap: ${c.id} ends ${(c.off + c.dur).toFixed(2)} s, ${n.id} starts ${n.off.toFixed(2)} s`);
});
if (!clips.length) await copyFile(SILENT, OUT);
else {
  const args = ['-loglevel', 'error', '-y', '-i', SILENT, ...clips.flatMap(c => ['-i', c.file])];
  const chains = clips.map((c, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${c.sfx ? SFX_GAIN : 1},adelay=${Math.round(c.off * 1000)}|${Math.round(c.off * 1000)}[a${i}]`);
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]`;
  execFileSync('ffmpeg', [...args, '-filter_complex', [...chains, mix].join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
}
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '30', '-i', OUT, '-frames:v', '1', '-q:v', '3', OUT.replace(/\.mp4$/, '.jpg')]);
await rm(FRAMES, { recursive: true, force: true });
console.log('wrote', OUT);
