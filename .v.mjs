import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(process.argv[2]); await p.waitForTimeout(1500);
const v = await p.$$eval('video', vs => vs.map(v => ({ src: v.currentSrc.split('/').pop(), dur: v.duration, err: v.error && v.error.code })));
await p.screenshot({ path: process.env.TMPDIR + '/videos.png', fullPage: false });
console.log(JSON.stringify(v), 'errors:', errs.length ? errs : 'none'); await b.close();
