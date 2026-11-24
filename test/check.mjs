import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, html, anonymise } from '../render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['data/local-sandbox', 'data/practice-sandbox'];
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };

const leaks = (text, subs) => {
  const found = [];
  for (const s of subs) if (text.includes(s)) found.push(s);
  for (const m of text.matchAll(/\b\d{2}f\d{7}\b/gi)) found.push(m[0]);
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) found.push(m[0]);
  for (const m of text.matchAll(/\b\d{1,3}(\.\d{1,3}){3}\b/g)) found.push(m[0]);
  for (const m of text.matchAll(/eyJ[\w-]{10,}/g)) found.push(`${m[0].slice(0, 12)}…`);
  return found;
};

for (const rel of dirs) {
  const dir = resolve(ROOT, rel);
  console.log(`\n${rel}`);
  const raw = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const csv = readFileSync(join(dir, 'players.csv'), 'utf8').trim().split('\n');
  const head = csv[0].split(',');
  const rows = csv.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
  const data = build(dir);
  const page = html(data);
  const subs = [...new Set(raw.map(e => e.sub))];

  ok(raw.length === manifest.events && data.counts.events === raw.length, `events: raw ${raw.length}, manifest ${manifest.events}, built ${data.counts.events}`);
  ok(data.players.length === rows.length, `players: built ${data.players.length}, players.csv ${rows.length}`);
  const byHandle = new Map(rows.map(r => [r.handle, r]));
  const mism = data.players.filter(p => +byHandle.get(p.h)?.total !== p.total);
  ok(mism.length === 0, `final totals match players.csv (${mism.length} mismatches)`);

  const moves = raw.filter(e => e.type === 'move').length;
  ok(data.players.reduce((s, p) => s + p.steps, 0) === moves, `steps add up to the ${moves} move events`);
  let endOk = 0;
  for (const p of data.players) {
    const sub = rows.find(r => r.handle === p.h).sub;
    const last = raw.filter(e => e.sub === sub && Number.isFinite(e.x)).at(-1);
    if (p.ix.at(-1) === last.y * data.w + last.x) endOk++;
  }
  ok(endOk === data.players.length, `replayed final position equals the last logged position for ${endOk}/${data.players.length} players`);

  const solvedBy = spot => new Set(raw.filter(e => (e.type === 'answer' || e.type === 'token') && e.data.spot === spot && e.data.result === 'solved' && !rows.find(r => r.sub === e.sub && r.test === 'true')).map(e => e.sub)).size;
  const tm = data.insights.tasks.filter(t => t.solved !== solvedBy(t.id));
  ok(tm.length === 0, `solved count per task matches a direct count from events.jsonl${tm.length ? `: ${tm.map(t => t.id).join(', ')}` : ''}`);
  for (const [door, c] of Object.entries(data.insights.coop)) {
    const pressers = new Set(raw.filter(e => e.type === 'coop_press' && e.data.door === door).map(e => e.sub)).size;
    ok(c.pressers === pressers, `${door} door: ${c.pressers} pressers, direct count ${pressers}`);
  }

  const found = leaks(page, subs);
  ok(found.length === 0, `no emails, roll numbers or IP addresses in the page${found.length ? `: ${[...new Set(found)].slice(0, 5).join(', ')}` : ''}`);
  const planted = leaks(`${page}<!-- ${subs.find(s => s.includes('@'))} 21f1234567 10.0.0.1 eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig -->`, subs);
  ok(planted.length >= 4, `privacy check catches a planted email, roll number, IP and token (${planted.length} found)`);

  const story = readFileSync(join(ROOT, 'demo', 'storyboard.json'), 'utf8');
  const anon = anonymise(data, story);
  const anonPage = html(anon.data, anon.story);
  const handles = rows.map(r => r.handle).filter(Boolean);
  const texts = raw.filter(e => (e.type === 'chat' || e.type === 'note') && String(e.data?.text ?? '').length >= 12).map(e => String(e.data.text).slice(0, 40));
  const anonLeaks = s => [...handles.filter(h => s.includes(h)), ...texts.filter(t => s.includes(JSON.stringify(t).slice(1, -1)))];
  const al = anonLeaks(anonPage);
  ok(al.length === 0 && leaks(anonPage, subs).length === 0, `anonymised page has no handles, chat or note text (${al.length} found${al.length ? `: ${al.slice(0, 3).join(' | ')}` : ''})`);
  const plantedAnon = anonLeaks(`${anonPage}${handles[0]}${JSON.stringify(texts[0] ?? '')}`);
  ok(plantedAnon.length >= (texts.length ? 2 : 1), `anonymised check catches a planted handle and note (${plantedAnon.length} found)`);
  const site = anonymise(data, story, { handles: true });
  const sitePage = html(site.data, site.story);
  const sl = texts.filter(t => sitePage.includes(JSON.stringify(t).slice(1, -1)));
  ok(sl.length === 0 && leaks(sitePage, subs).length === 0 && site.data.players.every((p, i) => p.h === data.players[i].h), `site page keeps handles and has no chat or note text (${sl.length} found)`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
