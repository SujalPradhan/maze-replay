#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function build(dir, { title = null } = {}) {
  const read = f => readFileSync(join(dir, f), 'utf8');
  const layout = JSON.parse(read('layout.json'));
  const config = JSON.parse(read('config.json'));
  const W = layout.w, H = layout.h;
  const tiles = Buffer.from(layout.tiles, 'base64');
  if (tiles.length !== W * H) throw new Error(`layout.json tiles: ${tiles.length} bytes, expected ${W * H}`);

  const regionAt = new Int16Array(W * H).fill(-1);
  for (const r of layout.regions) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) regionAt[y * W + x] = r.id;

  const players = new Map();
  const csv = existsSync(join(dir, 'players.csv')) ? parseCsv(read('players.csv')) : [];
  const csvBySub = new Map(csv.map(r => [r.sub, r]));
  const events = [];
  let count = 0;
  for (const line of read('events.jsonl').split('\n')) {
    if (!line) continue;
    events.push(JSON.parse(line));
    count++;
  }
  events.sort((a, b) => a.at - b.at || a.id - b.id);
  const t0 = events[0].at;

  const pid = sub => {
    let p = players.get(sub);
    if (!p) {
      const row = csvBySub.get(sub) ?? {};
      p = {
        i: players.size, handle: row.handle ?? `player-${players.size + 1}`, test: row.test === 'true',
        join: null, end: row.ends_at ? Date.parse(row.ends_at) : null, total: row.total ? +row.total : 0,
        explored: +(row.explored ?? 0), steps: 0, track: [], solves: {}, wrong: 0, traps: 0, chats: 0, notes: 0,
        gifts: 0, last: 0, attempts: new Set(), pressAlone: 0,
      };
      players.set(sub, p);
    }
    return p;
  };

  const challenge = Object.fromEntries(config.challenges.map(c => [c.id, c]));
  const out = [];
  const T = { join: 0, answer: 1, token: 2, trap: 3, teleport: 4, chat: 5, note: 6, gift: 7, gamble: 8, press: 9, coop: 10, door: 11, perk: 12, roll: 13, receipt: 14, connect: 15, disconnect: 16, trade: 17 };
  const heat = new Uint32Array(W * H);
  const dwell = new Float64Array(layout.regions.length);
  const cheats = [];
  const scrub = s => String(s ?? '').replace(/eyJ[\w-]{6,}(\.[\w-]*){0,2}/g, '[code]').replace(/[\w.+-]+@[\w.-]+/g, '[email]').replace(/\b\d{2}f\d{7}\b/gi, '[id]').replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '[ip]').replace(/\+?\d[\d -]{8,}\d/g, '[number]').slice(0, 280);

  for (const e of events) {
    const p = pid(e.sub);
    const t = e.at - t0;
    const d = e.data ?? {};
    const idx = e.y * W + e.x;
    const prev = p.track.at(-1);
    if (e.type === 'join') { p.join = e.at; if (!p.end) p.end = d.ends_at; if (d.handle) p.handle = d.handle; }
    if (Number.isFinite(e.x) && Number.isFinite(e.y) && (!prev || prev[1] !== idx)) {
      if (prev) {
        const r = regionAt[prev[1]];
        if (r >= 0) dwell[r] += Math.min(30_000, t - prev[0]);
      }
      p.track.push([t, idx]);
      heat[idx]++;
    }
    p.last = Math.max(p.last, e.at);
    const ev = (type, extra) => out.push([t, p.i, T[type], e.x, e.y, extra ?? null]);
    switch (e.type) {
      case 'move': p.steps++; break;
      case 'join': ev('join'); break;
      case 'connect': ev('connect'); break;
      case 'disconnect': ev('disconnect'); break;
      case 'answer': {
        p.attempts.add(d.spot);
        if (d.result === 'solved' && !p.solves[d.spot]) p.solves[d.spot] = { t: e.at - p.join, marks: d.marks ?? 0 };
        if (d.result === 'open' || d.result === 'failed') p.wrong++;
        if (d.kind === 'client' && d.result === 'solved' && d.truth === false) cheats.push({ handle: p.handle, spot: d.spot });
        ev('answer', { s: d.spot, r: d.result, m: d.marks ?? 0 });
        break;
      }
      case 'token': {
        p.attempts.add(d.spot);
        if (d.result === 'solved' && !p.solves[d.spot]) p.solves[d.spot] = { t: e.at - p.join, marks: d.marks ?? 0 };
        ev('token', { s: d.spot, r: d.result, why: d.reason ?? null, m: d.marks ?? 0 });
        break;
      }
      case 'nonce': p.attempts.add(d.spot); break;
      case 'trap': p.traps++; ev('trap', { s: d.spot, k: d.kind }); break;
      case 'teleport': ev('teleport', { via: d.via, from: d.from }); break;
      case 'chat': p.chats++; ev('chat', { text: scrub(d.text), ch: d.channel }); break;
      case 'note': p.notes++; ev('note', { text: scrub(d.text) }); break;
      case 'gift_claim': p.gifts++; ev('gift', { s: d.spot, perk: d.perk }); break;
      case 'gamble': ev('gamble', { perk: d.perk, win: d.win }); break;
      case 'coop_press': ev('press', { door: d.door }); break;
      case 'coop_open': ev('coop', { door: d.door, n: d.with?.length ?? 0 }); break;
      case 'door_open': ev('door', { door: d.door, via: d.via }); break;
      case 'perk_use': ev('perk', { perk: d.perk, s: d.spot ?? null }); break;
      case 'roll': ev('roll', { s: d.spot, v: d.variant }); break;
      case 'receipt': ev('receipt', { total: d.total, final: d.final }); break;
      case 'trade_offer': ev('trade', { give: d.give, want: d.want }); break;
    }
  }

  const list = [...players.values()].filter(p => p.join !== null).sort((a, b) => a.i - b.i);
  const remap = new Map(list.map((p, j) => [p.i, j]));
  const evs = out.filter(e => remap.has(e[1])).map(e => (e[1] = remap.get(e[1]), e));
  list.forEach((p, j) => (p.i = j));

  const spots = layout.spots.map(s => {
    const c = challenge[s.challenge ?? s.id];
    return { id: s.id, type: s.type, x: s.idx % W, y: Math.floor(s.idx / W), title: c?.title ?? null, marks: c?.marks ?? null, kind: c?.kind ?? null };
  });
  const xy = i => [i % W, Math.floor(i / W)];
  const doors = layout.doors.map(d => ({ id: d.id, kind: d.kind, p: xy(d.idx), pads: d.pads.map(xy) }));

  const insights = analyse({ list, evs, T, config, challenge, layout, dwell, cheats, regionAt, W });
  const playersOut = list.map(p => {
    const dt = [], ix = [];
    let lt = 0;
    for (const [t, i] of p.track) { dt.push(t - lt); ix.push(i); lt = t; }
    return {
      h: p.handle, test: p.test, join: p.join - t0, end: (p.end ?? p.last) - t0, last: p.last - t0, total: p.total,
      solved: Object.keys(p.solves).length, explored: p.explored, steps: p.steps, traps: p.traps, wrong: p.wrong,
      solves: Object.fromEntries(Object.entries(p.solves).map(([k, v]) => [k, [Math.round(v.t / 1000), v.marks]])),
      dt, ix,
    };
  });

  return {
    world: config.id ?? basename(dir), title: title ?? config.title ?? config.id, hash: layout.hash,
    t0, span: events.at(-1).at - t0, w: W, h: H, tiles: layout.tiles,
    regions: layout.regions.map(r => ({ id: r.id, type: r.type, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, market: r.market, hidden: r.hidden })),
    doors, spots, types: Object.keys(T), players: playersOut, events: evs, heat: Array.from(heat),
    insights, counts: { events: count, players: list.length },
  };
}

function analyse({ list, evs, T, config, challenge, layout, dwell, cheats }) {
  const real = list.filter(p => !p.test);
  const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const totals = real.map(p => p.total);
  const max = Math.max(...totals);
  const marksAvailable = config.challenges.reduce((s, c) => s + (c.marks ?? 0), 0);

  const zero = real.filter(p => p.total === 0);
  const stop = p => Math.min(p.last, p.end ?? p.last);
  const active = p => (stop(p) - p.join) / 60000;
  const zeroWhy = {
    never_moved: zero.filter(p => p.steps === 0).length,
    left_early: zero.filter(p => p.steps > 0 && active(p) < 10).length,
    explored_no_solve: zero.filter(p => p.steps > 0 && active(p) >= 10).length,
  };

  const tasks = config.challenges.map(c => {
    const tried = real.filter(p => p.attempts.has(c.id));
    const solved = real.filter(p => p.solves[c.id]);
    const wrong = evs.filter(e => (e[2] === T.answer) && e[5].s === c.id && (e[5].r === 'open' || e[5].r === 'failed')).length;
    return {
      id: c.id, title: c.title, kind: c.kind, marks: c.marks, retry: c.retry?.policy ?? null, behind: c.behind ?? null, bonus: !!c.bonus,
      tried: tried.length, solved: solved.length, wrong,
      median_min: round1(med(solved.map(p => p.solves[c.id].t / 60000))),
      pending: c.retry?.policy === 'offline' ? evs.filter(e => e[2] === T.answer && e[5].s === c.id && e[5].r === 'pending').length : 0,
    };
  });

  const scored = real.filter(p => p.total > 0);
  const firstSolve = scored.map(p => Math.min(...Object.values(p.solves).map(s => s.t)) / 60000).filter(Number.isFinite);
  const top = [...real].sort((a, b) => b.total - a.total).slice(0, 5);
  const mid = real.filter(p => p.total > 0 && !top.includes(p));
  const profile = g => ({
    n: g.length, total: round1(med(g.map(p => p.total))), explored: med(g.map(p => p.explored)), steps: med(g.map(p => p.steps)),
    wrong: med(g.map(p => p.wrong)), traps: med(g.map(p => p.traps)), active_min: round1(med(g.map(active))),
  });

  const firstTask = {};
  for (const p of scored) {
    const f = Object.entries(p.solves).sort((a, b) => a[1].t - b[1].t)[0];
    if (f) firstTask[f[0]] = (firstTask[f[0]] ?? 0) + 1;
  }

  const notesAboutTraps = evs.filter(e => e[2] === T.note && /trap/i.test(e[5].text)).length;
  const trapHits = {};
  for (const e of evs) if (e[2] === T.trap) trapHits[e[5].s] = (trapHits[e[5].s] ?? 0) + 1;

  const coop = {};
  for (const d of layout.doors.filter(d => d.kind === 'coop')) {
    const presses = evs.filter(e => e[2] === T.press && e[5].door === d.id);
    const opens = evs.filter(e => e[2] === T.coop && e[5].door === d.id);
    const task = config.challenges.find(c => c.behind === d.id);
    const solvers = task ? real.filter(p => p.solves[task.id]) : [];
    const pressers = new Set(presses.map(e => e[1]));
    coop[d.id] = {
      pads: d.pads.length, presses: presses.length, pressers: pressers.size, openings: Math.round(opens.length / Math.max(1, d.pads.length)),
      task: task?.id ?? null, solvers: solvers.length, solver_min_total: solvers.length ? Math.min(...solvers.map(p => p.total)) : null,
      top_through: task ? real.filter(p => p.total === max && p.solves[task.id]).length : 0,
      first_open_ms: opens[0] ? opens[0][0] : null, where: d.pads.map(i => [i % layout.w, Math.floor(i / layout.w)])[0],
    };
  }

  const concurrency = [];
  const step = 10 * 60000;
  const tStart = Math.min(...list.map(p => p.join));
  const tEnd = Math.max(...list.map(stop));
  for (let t = tStart; t <= tEnd; t += step) concurrency.push(real.filter(p => p.join < t + step && stop(p) >= t).length);

  let online = 0, peakOnline = 0;
  for (const [, d] of real.flatMap(p => [[p.join, 1], [stop(p), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])) peakOnline = Math.max(peakOnline, (online += d));
  const regionDwell = layout.regions.map((r, i) => ({ name: r.name, type: r.type, min: Math.round(dwell[i] / 60000) })).sort((a, b) => b.min - a.min).slice(0, 8);

  const bins = Array.from({ length: Math.floor(max / 3) + 1 }, (_, i) => ({ lo: i * 3, hi: i * 3 + 3, n: 0 }));
  for (const v of totals) bins[Math.min(bins.length - 1, Math.floor(v / 3))].n++;

  const sessionMin = round1(med(real.map(p => (p.end - p.join) / 60000)));
  return {
    players: real.length, max, top_count: totals.filter(v => v === max).length, marks_available: marksAvailable,
    median_total: med(totals), median_scored: med(scored.map(p => p.total)), zero: zero.length, zero_why: zeroWhy,
    session_min: sessionMin, first_solve_min: round1(med(firstSolve)), first_task: firstTask,
    tasks, top: profile(top), rest: profile(mid), top_handles: top.map(p => p.handle),
    cheats: cheats.length, cheat_detail: cheats, notes: evs.filter(e => e[2] === T.note).length, notes_about_traps: notesAboutTraps,
    chats: evs.filter(e => e[2] === T.chat).length, trades: evs.filter(e => e[2] === T.trade).length,
    trap_hits: trapHits, coop, concurrency, concurrency_step_min: 10, peak_online: peakOnline, concurrency_start_at: tStart, region_dwell: regionDwell, score_bins: bins,
  };
}

const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

function parseCsv(text) {
  const [head, ...rows] = text.trim().split('\n').map(l => l.split(','));
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

export function anonymise(data, story = null, { handles = false } = {}) {
  const names = new Map(data.players.map((p, i) => [p.h, handles ? p.h : `Player ${i + 1}`]));
  const quiet = new Set(['chat', 'note'].map(t => data.types.indexOf(t)));
  const ins = data.insights;
  const out = {
    ...data,
    players: data.players.map(p => ({ ...p, h: names.get(p.h) })),
    events: data.events.filter(e => !quiet.has(e[2])),
    insights: { ...ins, top_handles: ins.top_handles.map(h => names.get(h) ?? h), cheat_detail: ins.cheat_detail.map(c => ({ ...c, handle: names.get(c.handle) ?? c.handle })) },
  };
  const swap = s => [...names].sort((a, b) => b[0].length - a[0].length).reduce((t, [h, n]) => t.replaceAll(h, n), s);
  const unquote = s => {
    const st = JSON.parse(s);
    for (const sc of st.scenes ?? []) if (sc.callout?.items?.some(i => 'quote' in i)) delete sc.callout;
    return JSON.stringify(st);
  };
  return { data: out, story: story && unquote(swap(story)) };
}

export function html(data, story = null) {
  const tpl = readFileSync(join(HERE, 'viewer', 'index.html'), 'utf8');
  const css = readFileSync(join(HERE, 'viewer', 'style.css'), 'utf8');
  const js = readFileSync(join(HERE, 'viewer', 'app.js'), 'utf8');
  const safe = s => s.replace(/<\/script/gi, '<\\/script');
  return tpl
    .replace('/*STYLE*/', () => css)
    .replace('/*DATA*/', () => safe(`window.REPLAY=${JSON.stringify(data)};window.STORY=${story ?? 'null'};`))
    .replace('/*APP*/', () => safe(js))
    .replaceAll('{{TITLE}}', () => escapeHtml(data.title));
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : fallback;
  };
  const outDir = resolve(flag('--out', 'out'));
  const title = flag('--title', null);
  const storyFile = flag('--story', null);
  const bool = name => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const anon = bool('--anon');
  const keepHandles = bool('--keep-handles');
  const src = args[0];
  if (!src || args.includes('--help')) {
    console.log('Usage: node render.mjs <maze-sync-folder> [--out out] [--title "ROE practice"] [--story demo/storyboard.json] [--anon [--keep-handles]]');
    console.log('The folder is one world from `npm run maze:sync` (events.jsonl, layout.json, config.json, players.csv).');
    process.exit(src ? 0 : 1);
  }
  const raw = build(resolve(src), { title });
  const story0 = storyFile ? readFileSync(resolve(storyFile), 'utf8') : null;
  const { data, story } = anon ? anonymise(raw, story0, { handles: keepHandles }) : { data: raw, story: story0 };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html(data, story));
  writeFileSync(join(outDir, 'insights.json'), JSON.stringify(data.insights, null, 2));
  const kb = n => `${Math.round(n / 1024)} KB`;
  console.log(`${data.world}: ${data.counts.events} events, ${data.counts.players} players, ${(data.span / 3600000).toFixed(1)} h`);
  console.log(`wrote ${join(outDir, 'index.html')} (${kb(readFileSync(join(outDir, 'index.html')).length)}) and insights.json`);
}
