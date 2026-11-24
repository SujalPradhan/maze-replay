(() => {
  const D = window.REPLAY;
  const STORY = window.STORY;
  const I = D.insights;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const T = Object.fromEntries(D.types.map((k, i) => [k, i]));
  const W = D.w, H = D.h;
  const tiles = Uint8Array.from(atob(D.tiles), c => c.charCodeAt(0));
  const spotById = new Map(D.spots.map(s => [s.id, s]));
  const taskById = new Map(I.tasks.map(t => [t.id, t]));
  const taskTitle = id => taskById.get(id)?.title ?? spotById.get(id)?.title ?? id;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmt = n => (n == null || !Number.isFinite(n) ? '–' : Number.isInteger(n) ? String(n) : n.toFixed(1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;

  const regionAt = new Int16Array(W * H).fill(-1);
  for (const r of D.regions) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) regionAt[y * W + x] = r.id;
  const regionById = new Map(D.regions.map(r => [r.id, r]));

  const scoredTotals = D.players.filter(p => p.total > 0 && !p.test).map(p => p.total).sort((a, b) => a - b);
  const q = f => scoredTotals.length ? scoredTotals[Math.min(scoredTotals.length - 1, Math.floor(f * scoredTotals.length))] : 0;
  const cut1 = q(0.5), cut2 = Math.max(cut1, q(0.9));
  const bandOf = v => (v <= 0 ? 0 : v < cut1 ? 1 : v < cut2 ? 2 : 3);
  const bandLabel = [
    'Scored 0',
    `Under ${fmt(cut1)}`,
    `${fmt(cut1)} to ${fmt(cut2 - 0.5)}`,
    `${fmt(cut2)} or more`,
  ];

  const P = D.players.map((p, i) => {
    const n = p.dt.length;
    const ts = new Float64Array(n), ix = new Int32Array(n);
    let t = 0;
    for (let k = 0; k < n; k++) { t += p.dt[k]; ts[k] = t; ix[k] = p.ix[k]; }
    const solvesAt = Object.entries(p.solves).map(([s, [sec, m]]) => ({ s, t: p.join + sec * 1000, m })).sort((a, b) => a.t - b.t);
    return { ...p, i, ts, ix, stop: Math.min(p.last, p.end) + 2000, band: bandOf(p.total), solvesAt };
  });

  const E = D.events;
  const realT = Float64Array.from(E, e => e[0]);
  const togOrder = E.map((e, k) => k).sort((a, b) => (E[a][0] - P[E[a][1]].join) - (E[b][0] - P[E[b][1]].join));
  const togT = Float64Array.from(togOrder, k => E[k][0] - P[E[k][1]].join);
  const upper = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };

  const minJoin = Math.min(...P.map(p => p.join));
  const maxStop = Math.max(...P.map(p => p.stop));
  const maxSession = Math.max(...P.map(p => Math.min(p.stop, p.end + 60000) - p.join));
  const range = { together: [0, Math.min(maxSession, 90 * 60000)], real: [minJoin, maxStop] };
  const SPEEDS = { together: [1, 5, 15, 30, 60, 120], real: [15, 60, 120, 300, 600, 1200] };

  const st = {
    mode: 'together', t: 0, playing: true, speed: 30, follow: -1, hover: -1,
    layers: { trails: true, heat: false, labels: true },
    cam: { x: W / 2, y: H / 2, z: 1 }, tween: null, demo: false, lastFeedKey: '', lastBoard: 0,
  };

  let C = {};
  const readTokens = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    C = {
      void: v('--void'), wall: v('--wall'), floor: v('--floor'), market: v('--floor-market'), hidden: v('--floor-hidden'), door: v('--door'),
      ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), surface: v('--surface'), raised: v('--raised'), accent: v('--accent'),
      bands: [v('--band-0'), v('--band-1'), v('--band-2'), v('--band-3')], heat: v('--heat'),
      good: v('--good'), warning: v('--warning'), serious: v('--serious'), critical: v('--critical'), grid: v('--grid'),
    };
  };

  const TS = 24;
  const mapImg = document.createElement('canvas');
  const heatImg = document.createElement('canvas');
  const drawStatic = () => {
    mapImg.width = W * TS; mapImg.height = H * TS;
    const g = mapImg.getContext('2d');
    g.fillStyle = C.void; g.fillRect(0, 0, mapImg.width, mapImg.height);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, v = tiles[k];
      if (v === 0) continue;
      const r = regionById.get(regionAt[k]);
      g.fillStyle = v === 2 ? C.door : r?.hidden ? C.hidden : r?.market ? C.market : C.floor;
      g.fillRect(x * TS, y * TS, TS, TS);
    }
    g.fillStyle = C.wall;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (tiles[y * W + x] !== 0) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dy]) => tiles[(y + dy) * W + x + dx] > 0 && x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H);
      if (near) g.fillRect(x * TS, y * TS, TS, TS);
    }
    g.strokeStyle = C.grid; g.lineWidth = 1; g.globalAlpha = 0.6;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tiles[y * W + x] === 1) g.strokeRect(x * TS + 0.5, y * TS + 0.5, TS - 1, TS - 1);
    g.globalAlpha = 1;
    heatImg.width = W; heatImg.height = H;
    const hg = heatImg.getContext('2d');
    const img = hg.createImageData(W, H);
    const mx = Math.log1p(Math.max(...D.heat));
    for (let k = 0; k < W * H; k++) {
      const a = D.heat[k] ? Math.pow(Math.log1p(D.heat[k]) / mx, 2.4) : 0;
      const [r, gg, b] = C.heat.split(',').map(Number);
      img.data[k * 4] = r; img.data[k * 4 + 1] = gg; img.data[k * 4 + 2] = b; img.data[k * 4 + 3] = Math.round(clamp(a * 1.1, 0, 1) * 225);
    }
    hg.putImageData(img, 0, 0);
  };

  const cv = $('#map'), ctx = cv.getContext('2d');
  let cw = 0, ch = 0, dpr = 1, fit = 1;
  const resize = () => {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = r.width; ch = r.height;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    fit = Math.min(cw / W, ch / H) * 0.96;
    drawSpark();
  };
  const scale = () => fit * st.cam.z;
  const toScreen = (x, y) => [(x - st.cam.x) * scale() + cw / 2, (y - st.cam.y) * scale() + ch / 2];
  const toWorld = (sx, sy) => [(sx - cw / 2) / scale() + st.cam.x, (sy - ch / 2) / scale() + st.cam.y];
  const ease = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const flyTo = (x, y, z, ms = 1400) => { st.tween = { from: { ...st.cam }, to: { x, y, z }, t0: performance.now(), ms }; };

  const playerTime = p => (st.mode === 'together' ? p.join + st.t : st.t);
  const posAt = (p, t) => {
    const k = upper(p.ts, t) - 1;
    if (k < 0) return [p.ix[0] % W + 0.5, Math.floor(p.ix[0] / W) + 0.5];
    const a = p.ix[k];
    let x = a % W + 0.5, y = Math.floor(a / W) + 0.5;
    if (k + 1 < p.ts.length) {
      const gap = p.ts[k + 1] - p.ts[k];
      if (gap <= 400) {
        const b = p.ix[k + 1], f = clamp((t - p.ts[k]) / gap, 0, 1);
        const bx = b % W + 0.5, by = Math.floor(b / W) + 0.5;
        if (Math.abs(bx - x) + Math.abs(by - y) <= 2) { x = lerp(x, bx, f); y = lerp(y, by, f); }
      }
    }
    return [x, y];
  };
  const visible = p => { const t = playerTime(p); return t >= p.join && t <= p.stop; };
  const marksAt = (p, t) => { let m = 0; for (const s of p.solvesAt) if (s.t <= t) m += s.m; return m; };

  const FX = {
    [T.answer]: e => (e[5].r === 'solved' ? C.good : e[5].r === 'pending' ? C.muted : C.critical),
    [T.token]: e => (e[5].r === 'solved' ? C.good : C.critical),
    [T.trap]: () => C.serious, [T.teleport]: () => C.serious,
    [T.coop]: () => C.warning, [T.door]: () => C.warning, [T.gift]: () => C.accent,
  };
  const draw = now => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.void; ctx.fillRect(0, 0, cw, ch);
    const s = scale();
    const [ox, oy] = toScreen(0, 0);
    ctx.imageSmoothingEnabled = s < TS;
    ctx.drawImage(mapImg, ox, oy, W * s, H * s);
    if (st.layers.heat) { ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.85; ctx.drawImage(heatImg, ox, oy, W * s, H * s); ctx.globalAlpha = 1; }

    if (st.layers.labels && s > 7) {
      ctx.font = `600 ${clamp(s * 0.42, 9, 15)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const r of D.regions) {
        if (r.w * s < 60) continue;
        const [x, y] = toScreen(r.x + r.w / 2, r.y + 0.9);
        ctx.fillStyle = C.muted; ctx.globalAlpha = 0.95;
        ctx.fillText(r.name, x, y);
      }
      ctx.globalAlpha = 1;
    }
    drawSpots(s);

    const pulseLife = 1600 * st.speed, bubbleLife = 5200 * st.speed;
    const arr = st.mode === 'together' ? togT : realT;
    const hi = upper(arr, st.t);
    const lo = upper(arr, st.t - bubbleLife);
    const bubbles = [];
    for (let j = lo; j < hi; j++) {
      const k = st.mode === 'together' ? togOrder[j] : j;
      const e = E[k], age = st.t - arr[j];
      if (st.follow >= 0 && e[1] !== st.follow && e[2] !== T.coop) continue;
      if (e[2] === T.chat || e[2] === T.note) { bubbles.push([e, age]); continue; }
      if (age > pulseLife) continue;
      const col = FX[e[2]]?.(e);
      if (!col) continue;
      const k01 = age / pulseLife;
      const [x, y] = toScreen(e[3] + 0.5, e[4] + 0.5);
      const big = e[2] === T.coop || e[2] === T.door;
      ctx.strokeStyle = col; ctx.lineWidth = big ? 3 : 2; ctx.globalAlpha = 1 - k01;
      ctx.beginPath(); ctx.arc(x, y, Math.max(6, s * 0.5) + k01 * Math.max(18, s * (big ? 3 : 1.6)), 0, Math.PI * 2); ctx.stroke();
      if (e[2] === T.teleport && e[5].from) {
        const [fx, fy] = toScreen(e[5].from[0] + 0.5, e[5].from[1] + 0.5);
        ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
      }
      if ((e[2] === T.answer || e[2] === T.token) && e[5].r === 'solved' && e[5].m) {
        ctx.fillStyle = col; ctx.font = `700 ${clamp(s * 0.6, 11, 18)}px system-ui`; ctx.textAlign = 'center';
        ctx.fillText(`+${e[5].m}`, x, y - Math.max(12, s) - k01 * 18);
      }
      ctx.globalAlpha = 1;
    }

    const trailMs = clamp(st.speed * 2200, 2500, 150000);
    const dots = [];
    for (const p of P) {
      if (!visible(p)) continue;
      const t = playerTime(p);
      const [x, y] = posAt(p, t);
      dots.push([p, x, y]);
      if (st.layers.trails) {
        const dim = st.follow >= 0 && p.i !== st.follow;
        ctx.strokeStyle = C.bands[p.band];
        ctx.lineWidth = clamp(s * (p.i === st.follow ? 0.22 : 0.12), 1, 4);
        ctx.globalAlpha = dim ? 0.08 : p.i === st.follow ? 0.7 : 0.35;
        ctx.lineJoin = 'round'; ctx.beginPath();
        let [px, py] = toScreen(x, y); ctx.moveTo(px, py);
        let k = upper(p.ts, t) - 1, n = 0;
        let lx = x, ly = y;
        const limit = p.i === st.follow ? 600 : 140;
        while (k >= 0 && p.ts[k] >= t - (p.i === st.follow ? trailMs * 4 : trailMs) && n < limit) {
          const tx = p.ix[k] % W + 0.5, ty = Math.floor(p.ix[k] / W) + 0.5;
          const [sx, sy] = toScreen(tx, ty);
          if (Math.abs(tx - lx) + Math.abs(ty - ly) > 2) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          lx = tx; ly = ty; k--; n++;
        }
        ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    const r = clamp(s * 0.36, 2.6, 9);
    for (const [p, x, y] of dots) {
      const [sx, sy] = toScreen(x, y);
      const dim = st.follow >= 0 && p.i !== st.follow;
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.fillStyle = C.bands[p.band];
      ctx.strokeStyle = C.surface; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, p.i === st.follow ? r * 1.5 : r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const [p, x, y] of dots) {
      if (p.i !== st.follow && p.i !== st.hover) continue;
      const [sx, sy] = toScreen(x, y);
      ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, r * 1.5 + 4, 0, Math.PI * 2); ctx.stroke();
      label(`${p.h} · ${fmt(marksAt(p, playerTime(p)))}`, sx, sy - r * 1.5 - 12);
    }
    bubbles.sort((a, b) => a[1] - b[1]).slice(0, 5).forEach(([e, age]) => {
      const p = P[e[1]];
      const pos = visible(p) && e[2] === T.chat ? posAt(p, playerTime(p)) : [e[3] + 0.5, e[4] + 0.5];
      const [sx, sy] = toScreen(...pos);
      bubble(e[2] === T.note ? `Note: ${e[5].text}` : e[5].text, p.h, sx, sy - r - 10, 1 - age / bubbleLife);
    });
    st.dots = dots;
  };

  const drawSpots = s => {
    const sz = clamp(s * 0.8, 5, 22);
    for (const sp of D.spots) {
      const [x, y] = toScreen(sp.x + 0.5, sp.y + 0.5);
      if (x < -30 || y < -30 || x > cw + 30 || y > ch + 30) continue;
      ctx.lineWidth = 1.5;
      if (sp.type === 'challenge') {
        ctx.fillStyle = C.raised; ctx.strokeStyle = C.ink2;
        roundRect(x - sz / 2, y - sz / 2, sz, sz, 3); ctx.fill(); ctx.stroke();
        if (sz > 10) { ctx.fillStyle = C.ink; ctx.font = `700 ${sz * 0.6}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(sp.marks ?? '', x, y + 0.5); }
        if (s > 12) { ctx.fillStyle = C.ink2; ctx.font = `600 ${clamp(s * 0.36, 9, 13)}px system-ui`; ctx.fillText(sp.title ?? sp.id, x, y + sz * 0.95); }
      } else if (sp.type === 'trap') {
        ctx.strokeStyle = C.serious; ctx.lineWidth = 2;
        const d = sz * 0.32;
        ctx.beginPath(); ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d); ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d); ctx.stroke();
      } else if (sp.type === 'perk') {
        ctx.fillStyle = C.accent; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(x, y - sz * 0.35); ctx.lineTo(x + sz * 0.35, y); ctx.lineTo(x, y + sz * 0.35); ctx.lineTo(x - sz * 0.35, y); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (sp.type === 'dice') {
        ctx.strokeStyle = C.ink2; roundRect(x - sz * 0.3, y - sz * 0.3, sz * 0.6, sz * 0.6, 2); ctx.stroke();
        ctx.fillStyle = C.ink2; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    }
    for (const d of D.doors) {
      if (d.kind === 'plain') continue;
      for (const [px, py] of d.pads) {
        const [x, y] = toScreen(px + 0.5, py + 0.5);
        ctx.fillStyle = C.critical; ctx.globalAlpha = 0.75; ctx.fillRect(x - s * 0.32, y - s * 0.32, s * 0.64, s * 0.64); ctx.globalAlpha = 1;
      }
      const [x, y] = toScreen(d.p[0] + 0.5, d.p[1] + 0.5);
      ctx.strokeStyle = C.warning; ctx.lineWidth = 2.5; ctx.strokeRect(x - s * 0.45, y - s * 0.45, s * 0.9, s * 0.9);
    }
  };
  const roundRect = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); };
  const ui = () => (st.demo ? 1.5 : 1);
  const label = (text, x, y) => {
    ctx.font = `600 ${12 * ui()}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = C.raised; ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    const lh = 22 * ui();
    roundRect(x - w / 2, y - lh / 2, w, lh, lh / 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.ink; ctx.fillText(text, x, y + 0.5);
  };
  const bubble = (text, who, x, y, alpha) => {
    const u = ui(), max = 240 * u;
    ctx.font = `${13 * u}px system-ui`;
    const words = String(text).split(/\s+/).map(w => (w.length > 28 ? `${w.slice(0, 27)}…` : w)), lines = [];
    let line = '';
    for (const w of words) { const t = line ? `${line} ${w}` : w; if (ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    const shown = lines.slice(0, 3);
    if (lines.length > 3) shown[2] += '…';
    const bw = Math.min(max, Math.max(...shown.map(l => ctx.measureText(l).width), ctx.measureText(who).width)) + 20 * u;
    const bh = (shown.length * 17 + 26) * u;
    const bx = clamp(x - bw / 2, 6, cw - bw - 6), by = clamp(y - bh - 8, 6, ch - bh - 6);
    ctx.globalAlpha = clamp(alpha * 1.6, 0, 1);
    ctx.fillStyle = C.raised; ctx.strokeStyle = C.grid;
    roundRect(bx, by, bw, bh, 10); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = C.muted; ctx.font = `600 ${11 * u}px system-ui`; ctx.fillText(who, bx + 10 * u, by + 7 * u);
    ctx.fillStyle = C.ink; ctx.font = `${13 * u}px system-ui`;
    shown.forEach((l, i) => ctx.fillText(l, bx + 10 * u, by + (23 + i * 17) * u));
    ctx.globalAlpha = 1;
  };

  const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const updateClock = () => {
    const n = P.filter(visible).length;
    if (st.mode === 'together') {
      $('#clock').innerHTML = `<span class="big">Minute ${mmss(st.t)}</span><span class="sub">Everyone starts together · ${n} playing</span>`;
      $('#time').textContent = `${mmss(st.t)} / ${mmss(range.together[1])}`;
    } else {
      $('#clock').innerHTML = `<span class="big">${ist.format(D.t0 + st.t)} IST</span><span class="sub">As it happened · ${n} online</span>`;
      $('#time').textContent = ist.format(D.t0 + st.t).replace(/^\w+ /, '');
    }
    const [a, b] = range[st.mode];
    const f = (st.t - a) / (b - a);
    $('#playhead').style.left = `${clamp(f, 0, 1) * 100}%`;
    $('#scrub').value = Math.round(clamp(f, 0, 1) * 1000);
  };
  const spark = $('#spark'), sg = spark.getContext('2d');
  const drawSpark = () => {
    const r = spark.getBoundingClientRect();
    if (!r.width) return;
    spark.width = Math.round(r.width * dpr); spark.height = Math.round(r.height * dpr);
    sg.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [a, b] = range[st.mode];
    const bins = Math.max(20, Math.floor(r.width / 3));
    const counts = new Float64Array(bins);
    const marks = [];
    const arr = st.mode === 'together' ? togT : realT;
    for (let j = 0; j < arr.length; j++) {
      const k = st.mode === 'together' ? togOrder[j] : j;
      const e = E[k];
      const f = (arr[j] - a) / (b - a);
      if (f < 0 || f >= 1) continue;
      if (e[2] === T.coop) marks.push(f);
      if (e[2] === T.answer || e[2] === T.token || e[2] === T.trap || (st.mode === 'real' && e[2] === T.join)) counts[Math.floor(f * bins)]++;
    }
    const mx = Math.max(1, ...counts);
    sg.clearRect(0, 0, r.width, r.height);
    sg.fillStyle = C.grid; sg.fillRect(0, r.height - 1, r.width, 1);
    sg.fillStyle = C.bands[1];
    const bw = r.width / bins;
    for (let i = 0; i < bins; i++) {
      if (!counts[i]) continue;
      const h = Math.max(2, (counts[i] / mx) * (r.height - 8));
      sg.fillRect(i * bw + 0.5, r.height - 1 - h, Math.max(1, bw - 1), h);
    }
    sg.fillStyle = C.warning;
    for (const f of marks) sg.fillRect(f * r.width - 1, 0, 2, 7);
  };

  const setMode = (mode, keepTime) => {
    if (mode === st.mode && keepTime) return;
    const pin = st.follow >= 0 ? P[st.follow] : null;
    if (pin && keepTime !== false) st.t = mode === 'real' ? pin.join + st.t : st.t - pin.join;
    else if (!keepTime) st.t = range[mode][0];
    st.mode = mode;
    st.t = clamp(st.t, ...range[mode]);
    $$('.seg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    const sp = $('#speed');
    sp.innerHTML = SPEEDS[mode].map(v => `<option value="${v}">${v}×</option>`).join('');
    if (!SPEEDS[mode].includes(st.speed)) st.speed = mode === 'together' ? 30 : 300;
    sp.value = st.speed;
    drawSpark(); st.lastFeedKey = '';
  };
  const setSpeed = v => {
    st.speed = v;
    const sp = $('#speed');
    if (![...sp.options].some(o => +o.value === v)) sp.insertAdjacentHTML('beforeend', `<option value="${v}">${v}×</option>`);
    sp.value = v;
  };
  const setPlaying = on => {
    st.playing = on;
    $('#play').setAttribute('aria-label', on ? 'Pause' : 'Play');
    $('#playIcon').setAttribute('d', on ? 'M6 4h3v12H6zM11 4h3v12h-3z' : 'M6 4l10 6-10 6z');
  };
  const setFollow = i => {
    st.follow = i;
    $('#followChip').hidden = i < 0;
    if (i >= 0) {
      $('#followName').textContent = `Following ${P[i].h} · final ${fmt(P[i].total)}`;
      $('#followSw').style.background = C.bands[P[i].band];
      if (st.cam.z < 2.4) flyTo(st.cam.x, st.cam.y, 2.8, 900);
    }
    st.lastFeedKey = ''; st.lastBoard = 0;
  };
  const setLayer = (k, on) => {
    st.layers[k] = on;
    const b = $(`[data-layer="${k}"]`);
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  };

  const PERK = { hint: 'a hint', skip: 'a skip', reveal: 'a floor plan', compass: 'a compass', teleport: 'a teleport', bonus: 'a bonus task', swap: 'a re-roll', retry: 'a retry' };
  const perkName = p => (PERK[p] ?? (p?.startsWith('minutes') ? 'extra time' : p?.startsWith('freeze') ? 'a clock freeze' : p?.startsWith('key:') ? `the ${p.slice(4)} key` : p));
  const describe = e => {
    const x = e[5] ?? {};
    switch (e[2]) {
      case T.answer:
        if (x.r === 'solved') return `solved ${esc(taskTitle(x.s))} <span class="tag good">+${fmt(x.m)}</span>`;
        if (x.r === 'pending') return `handed in ${esc(taskTitle(x.s))} for marking`;
        if (x.r === 'failed') return `ran out of tries at ${esc(taskTitle(x.s))} <span class="tag bad">failed</span>`;
        return `wrong answer at ${esc(taskTitle(x.s))} <span class="tag bad">wrong</span>`;
      case T.token:
        return x.r === 'solved' ? `handed in a code at ${esc(taskTitle(x.s))} <span class="tag good">+${fmt(x.m)}</span>` : `code refused at ${esc(taskTitle(x.s))} <span class="tag bad">${esc(x.why ?? x.r)}</span>`;
      case T.trap: return `walked into a ${esc(x.k ?? '')} trap <span class="tag warn">trap</span>`;
      case T.teleport: return x.via === 'trap' ? 'was teleported by a trap <span class="tag warn">trap</span>' : 'teleported';
      case T.chat: return `said <q>${esc(x.text)}</q>`;
      case T.note: return `left a note <q>${esc(x.text)}</q>`;
      case T.gift: return `took a gift: ${esc(perkName(x.perk))}`;
      case T.gamble: return `gambled ${esc(perkName(x.perk))} and ${x.win ? 'won' : 'lost'}`;
      case T.coop: return `opened the ${esc(x.door)} door with ${Math.max(0, x.n - 1)} others <span class="tag good">team</span>`;
      case T.door: return `opened the ${esc(x.door)} door with a key`;
      case T.join: return 'joined';
      case T.trade: return 'offered a trade';
      default: return null;
    }
  };
  const NOTABLE = new Set([T.answer, T.token, T.trap, T.teleport, T.chat, T.note, T.gift, T.gamble, T.coop, T.door, T.join, T.trade]);
  const updateFeed = () => {
    if ($('#tab-feed').hidden) return;
    const arr = st.mode === 'together' ? togT : realT;
    const hi = upper(arr, st.t);
    const key = `${st.mode}:${hi}:${st.follow}`;
    if (key === st.lastFeedKey) return;
    st.lastFeedKey = key;
    const items = [];
    for (let j = hi - 1; j >= 0 && items.length < 60; j--) {
      const k = st.mode === 'together' ? togOrder[j] : j;
      const e = E[k];
      if (!NOTABLE.has(e[2]) || (st.follow >= 0 && e[1] !== st.follow)) continue;
      const html = describe(e);
      if (html) items.push([j, k, e, html]);
    }
    $('#feedHint').textContent = st.follow >= 0 ? `Only ${P[st.follow].h}. Click the × on the map to see everyone.` : 'Newest first. Click a line to follow that player.';
    $('#feed').innerHTML = items.map(([j, k, e, html]) => {
      const p = P[e[1]];
      const tl = st.mode === 'together' ? mmss(arr[j]) : ist.format(D.t0 + e[0]).split(', ').pop();
      return `<li data-k="${k}"><span class="t">${tl}</span><span><span class="who"><span class="sw" style="background:${C.bands[p.band]}"></span>${esc(p.h)}</span> <span class="what">${html}</span></span></li>`;
    }).join('') || '<li><span></span><span class="what">Nothing yet. Press play.</span></li>';
  };

  const updateBoard = force => {
    if ($('#tab-players').hidden) return;
    const now = performance.now();
    if (!force && now - st.lastBoard < 400) return;
    st.lastBoard = now;
    const qy = $('#search').value.trim().toLowerCase();
    const rows = P.filter(p => !p.test && (!qy || p.h.includes(qy))).map(p => {
      const t = playerTime(p);
      return { p, m: marksAt(p, t), on: visible(p), started: t >= p.join };
    }).sort((a, b) => b.m - a.m || b.p.total - a.p.total);
    $('#board').innerHTML = rows.map((r, i) => `<li data-i="${r.p.i}" class="${r.on ? '' : 'off'} ${r.p.i === st.follow ? 'sel' : ''}"><span class="rank">${i + 1}</span><span class="name"><span class="sw" style="background:${C.bands[r.p.band]}"></span><span>${esc(r.p.h)}</span></span><span class="score">${fmt(r.m)} <small>/ ${fmt(r.p.total)}</small></span></li>`).join('');
  };

  const svgBars = (rows, { w = 340, rowH = 22, labelW = 120, max, hl } = {}) => {
    const mx = max ?? Math.max(1, ...rows.map(r => r.v));
    const h = rows.length * rowH;
    const bw = w - labelW - 40;
    const g = rows.map((r, i) => {
      const y = i * rowH;
      const len = Math.max(r.v ? 3 : 0, (r.v / mx) * bw);
      const track = r.of != null ? `<rect class="track" x="${labelW}" y="${y + 5}" width="${(r.of / mx) * bw}" height="${rowH - 10}" rx="3"/>` : '';
      return `<g class="m" data-tip="${esc(r.tip ?? `${r.label}: ${r.v}`)}"><rect class="hit" x="0" y="${y}" width="${w}" height="${rowH}"/>${track}<rect class="bar ${hl?.(r) ? 'hl' : ''}" x="${labelW}" y="${y + 5}" width="${len}" height="${rowH - 10}" rx="3"/><text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(r.label)}</text><text class="val" x="${labelW + len + 6}" y="${y + rowH / 2 + 4}">${esc(r.text ?? r.v)}</text></g>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img">${g}</svg>`;
  };
  const svgColumns = (rows, { w = 340, h = 120, hl } = {}) => {
    const mx = Math.max(1, ...rows.map(r => r.v));
    const gap = 2, bw = (w - gap * (rows.length - 1)) / rows.length, ph = h - 18;
    const g = rows.map((r, i) => {
      const x = i * (bw + gap), bh = Math.max(r.v ? 3 : 0, (r.v / mx) * (ph - 14));
      return `<g class="m" data-tip="${esc(r.tip)}"><rect class="hit" x="${x}" y="0" width="${bw}" height="${h}"/><rect class="bar ${hl?.(r, i) ? 'hl' : ''}" x="${x}" y="${ph - bh}" width="${bw}" height="${bh}" rx="3"/>${r.v ? `<text class="val" x="${x + bw / 2}" y="${ph - bh - 4}" text-anchor="middle">${r.v}</text>` : ''}${r.label != null ? `<text x="${x + bw / 2}" y="${h - 2}" text-anchor="middle">${esc(r.label)}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img"><line class="axis" x1="0" x2="${w}" y1="${ph}" y2="${ph}"/>${g}</svg>`;
  };
  const table = (head, rows) => `<details><summary>Show as a table</summary><table><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></details>`;

  const findings = [];
  const add = f => findings.push(f);
  const coopDoors = Object.entries(I.coop).filter(([, c]) => c.task);
  const teamDoor = coopDoors.sort((a, b) => b[1].pads - a[1].pads)[0];
  if (teamDoor) {
    const [id, c] = teamDoor;
    const door = D.doors.find(d => d.id === id);
    const task = taskById.get(c.task);
    add({
      id: 'team-door', lead: true, kicker: `${c.pads}-person team door`,
      title: `Only ${c.solvers} of ${c.pressers} who tried got the ${esc(task?.title ?? c.task)} task`,
      body: `The ${esc(id)} door opens only when ${c.pads} people stand on its pads and push together. It opened ${c.openings} time${c.openings === 1 ? '' : 's'}, from ${c.presses.toLocaleString()} presses. ` + (c.solvers ? `Everyone who solved the task behind it scored ${fmt(c.solver_min_total)} or more, including ${c.top_through} of the ${I.top_count} players on the top score of ${fmt(I.max)}.` : 'Nobody solved the task behind it.'),
      hero: [[c.pressers, 'pressed a pad'], [c.solvers, 'solved the task'], [c.openings, 'openings']],
      show: () => jump({ mode: 'real', t: c.first_open_ms != null ? c.first_open_ms - 25000 : range.real[0], x: door.p[0] - 3, y: door.p[1] - 3, z: 3.2, speed: 15, layers: { heat: false } }),
      headline: `<b>${c.solvers} of ${c.pressers}</b> students who tried the ${c.pads}-person team door got through.` + (c.solvers ? ` All of them scored ${fmt(c.solver_min_total)}+.` : ''),
    });
  }
  const zw = I.zero_why;
  add({
    id: 'scores', kicker: 'Scores',
    title: scoredTotals.length ? `${I.zero} of ${I.players} scored nothing; most others landed between ${fmt(cut1)} and ${fmt(I.max)}` : `None of the ${I.players} players scored`,
    body: `${zw.never_moved} never moved, ${zw.left_early} left within 10 minutes and ${zw.explored_no_solve} explored without solving anything. ${I.max > 0 ? `${I.top_count} reached the top score of ${fmt(I.max)}. ` : ''}Configured tasks add up to ${I.marks_available}, but ${(I.tasks.find(t => t.retry === 'offline')?.pending ?? 0)} written answers are still waiting to be marked.`,
    chart: svgColumns(I.score_bins.map(b => ({ v: b.n, label: b.lo, tip: `${b.n} player${b.n === 1 ? '' : 's'} scored ${b.lo} to ${b.hi - 0.5}` })), { hl: (r, i) => I.score_bins[i].lo >= cut2 - 2 }),
    table: table(['Score', 'Players'], I.score_bins.map(b => [`${b.lo} to ${b.hi - 0.5}`, b.n])),
    show: () => { setLayer('heat', false); $('[data-tab="players"]').click(); },
    showLabel: 'See the board',
  });
  const tasks = [...I.tasks].filter(t => t.tried).sort((a, b) => b.solved - a.solved);
  add({
    id: 'tasks', kicker: 'Tasks',
    title: (() => {
      const open = tasks.filter(t => !t.behind && !t.bonus && t.retry !== 'offline').map(t => t.solved).sort((a, b) => a - b);
      const locked = tasks.filter(t => t.behind).map(t => t.solved);
      const mid = open[open.length >> 1] ?? 0;
      if (!mid && !locked.some(Boolean)) return 'No task was solved in this log';
      return locked.length ? `About ${mid} players solved each open task. Behind locked doors, ${locked.join(' and ')}.` : `About ${mid} players solved each task`;
    })(),
    body: 'Bars show players who solved each task. The grey track is everyone who tried. Darker bars are the tasks behind a key or team door.',
    chart: svgBars(tasks.map(t => ({ label: t.title, v: t.solved, of: t.tried, text: t.retry === 'offline' ? `${t.pending} waiting` : `${t.solved}`, tip: `${t.title}: ${t.solved} of ${t.tried} solved${t.median_min ? `, median minute ${t.median_min}` : ''}${t.wrong ? `, ${t.wrong} wrong answers` : ''}`, behind: t.behind || t.bonus })), { hl: r => r.behind, labelW: 130 }),
    table: table(['Task', 'Solved', 'Tried', 'Median minute'], tasks.map(t => [t.title, t.solved, t.tried, t.median_min ?? '-'])),
  });
  const firsts = Object.entries(I.first_task).sort((a, b) => b[1] - a[1]);
  if (firsts.length) {
    const first = spotById.get(firsts[0][0]);
    add({
      id: 'first', kicker: 'First moves',
      title: `The first task solved was usually ${esc(taskTitle(firsts[0][0]))}`,
      body: `The median player solved their first task at minute ${I.first_solve_min}. The three-mark tasks near the start went first.`,
      chart: svgBars(firsts.slice(0, 5).map(([k, n]) => ({ label: taskTitle(k), v: n, tip: `${n} players solved ${taskTitle(k)} first` })), { labelW: 130 }),
      show: () => jump({ mode: 'together', t: 0, x: first?.x ?? W / 2, y: first?.y ?? H / 2, z: 1.6, speed: 30 }),
    });
  }
  const traps = Object.entries(I.trap_hits).sort((a, b) => b[1] - a[1]);
  if (traps.length) {
    const tr = spotById.get(traps[0][0]);
    const room = tr ? regionById.get(regionAt[tr.y * W + tr.x]) : null;
    add({
      id: 'traps', kicker: 'Traps',
      title: `One trap${room ? ` in ${esc(room.name)}` : ''} caught players ${traps[0][1]} times`,
      body: `Traps were hit ${traps.reduce((s, [, n]) => s + n, 0)} times in all. Players left ${I.notes} notes on the floor; ${I.notes_about_traps} of them warned about traps.`,
      chart: svgBars(traps.map(([k, n]) => { const s = spotById.get(k); const r = s ? regionById.get(regionAt[s.y * W + s.x]) : null; return { label: r?.name ?? k, v: n, tip: `${n} hits in ${r?.name ?? k}` }; }), { labelW: 130 }),
      show: () => tr && jump({ mode: 'together', t: 6 * 60000, x: tr.x, y: tr.y, z: 3, speed: 30 }),
    });
  }
  add({
    id: 'dwell', kicker: 'Where time went',
    title: `Players spent the most time in ${esc(I.region_dwell[0]?.name)}`,
    body: 'Total player-minutes per room, counting a pause of up to 30 seconds on a tile. Turn on the heatmap to see the paths.',
    chart: svgBars(I.region_dwell.slice(0, 6).map(r => ({ label: r.name, v: r.min, text: `${r.min} min`, tip: `${r.name}: ${r.min} player-minutes` })), { labelW: 130 }),
    show: () => { setLayer('heat', true); jump({ fit: true }); },
    showLabel: 'Show the heatmap',
  });
  add({
    id: 'when', kicker: 'When people played',
    title: `At most ${I.peak_online} players were online at the same moment`,
    body: `The world was open for ${(D.span / 3600000).toFixed(0)} hours, so players were spread thin. Each bar counts players active in a 10-minute slot. A ${teamDoor ? teamDoor[1].pads : 3}-person door needs that many at once. There were ${I.chats} chat messages and ${I.trades} trade offers in total.`,
    chart: svgColumns(I.concurrency.map((n, i) => ({ v: n, tip: `${ist.format(I.concurrency_start_at + i * 600000)} IST: ${n} active in these 10 minutes` })), { h: 90 }).replace(/<text class="val"[^>]*>\d+<\/text>/g, ''),
    show: () => jump({ mode: 'real', fit: true, speed: 600 }),
  });

  const renderFindings = () => {
    $('#tab-findings').innerHTML = findings.map(f => `
      <article class="finding ${f.lead ? 'lead' : ''}" id="f-${f.id}">
        <p class="kicker">${f.kicker}</p>
        <h3>${f.title}</h3>
        ${f.hero ? `<div class="hero">${f.hero.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>` : ''}
        <p>${f.body}</p>
        ${f.chart ?? ''}
        <div class="actions">${f.show ? `<button type="button" class="show" data-show="${f.id}">${f.showLabel ?? 'Show me'}</button>` : '<span></span>'}${f.table ?? ''}</div>
      </article>`).join('');
    const lead = findings.find(f => f.headline);
    $('#headline').innerHTML = lead ? lead.headline : esc(findings[0]?.title ?? '');
  };

  const jump = o => {
    if (o.mode) setMode(o.mode, false);
    if (o.t != null) st.t = clamp(o.t, ...range[st.mode]);
    if (o.speed) setSpeed(o.speed);
    if (o.layers) for (const [k, v] of Object.entries(o.layers)) setLayer(k, v);
    if (o.follow !== undefined) setFollow(o.follow);
    if (o.fit) flyTo(W / 2, H / 2, 1, o.ms);
    else if (o.x != null) flyTo(o.x + 0.5, o.y + 0.5, o.z ?? 2.5, o.ms);
    setPlaying(true);
    st.lastFeedKey = '';
  };

  const renderLegend = () => {
    const used = new Set(P.map(p => p.band));
    $('#legend').innerHTML = `<span class="title">Final score</span>${bandLabel.map((l, i) => (used.has(i) ? `<span class="row"><span class="sw" style="background:${C.bands[i]}"></span>${l}</span>` : '')).join('')}
      <span class="evs"><span class="ev"><i style="border-color:${C.good}"></i>Solved</span><span class="ev"><i style="border-color:${C.critical}"></i>Wrong</span><span class="ev"><i style="border-color:${C.serious}"></i>Trap</span><span class="ev"><i style="border-color:${C.warning}"></i>Door</span></span>`;
  };

  const tip = $('#tip');
  document.addEventListener('pointermove', e => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.hidden = false; tip.textContent = t.dataset.tip;
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });

  const pickPlayer = (mx, my) => {
    let best = -1, bd = 14 * 14;
    for (const [p, x, y] of st.dots ?? []) {
      const [sx, sy] = toScreen(x, y);
      const d = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d < bd) { bd = d; best = p.i; }
    }
    return best;
  };
  let drag = null;
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, cx: st.cam.x, cy: st.cam.y, moved: false }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; cv.classList.add('dragging'); st.tween = null; if (st.follow >= 0) setFollow(-1); }
      if (drag.moved) { st.cam.x = drag.cx - dx / scale(); st.cam.y = drag.cy - dy / scale(); }
    } else st.hover = pickPlayer(e.clientX - r.left, e.clientY - r.top);
  });
  cv.addEventListener('pointerup', e => {
    const r = cv.getBoundingClientRect();
    if (drag && !drag.moved) setFollow(pickPlayer(e.clientX - r.left, e.clientY - r.top));
    drag = null; cv.classList.remove('dragging');
  });
  cv.addEventListener('pointerleave', () => { st.hover = -1; });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
    const z = clamp(st.cam.z * Math.exp(-e.deltaY * 0.0015), 0.8, 8);
    st.tween = null;
    st.cam.z = z;
    const [nx, ny] = toWorld(e.clientX - r.left, e.clientY - r.top);
    st.cam.x += wx - nx; st.cam.y += wy - ny;
  }, { passive: false });
  cv.addEventListener('dblclick', () => flyTo(W / 2, H / 2, 1, 700));

  $('#play').addEventListener('click', () => setPlaying(!st.playing));
  $$('.seg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode, true)));
  $('#speed').addEventListener('change', e => { st.speed = +e.target.value; });
  $('#scrub').addEventListener('input', e => { const [a, b] = range[st.mode]; st.t = a + (b - a) * (e.target.value / 1000); st.lastFeedKey = ''; });
  $$('[data-layer]').forEach(b => b.addEventListener('click', () => setLayer(b.dataset.layer, !st.layers[b.dataset.layer])));
  $('#fit').addEventListener('click', () => { setFollow(-1); flyTo(W / 2, H / 2, 1, 700); });
  $('#unfollow').addEventListener('click', () => setFollow(-1));
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $$('.tab-body').forEach(x => (x.hidden = x.id !== `tab-${b.dataset.tab}`));
    st.lastFeedKey = ''; updateFeed(); updateBoard(true);
  }));
  $('#tab-findings').addEventListener('click', e => { const b = e.target.closest('[data-show]'); if (b) findings.find(f => f.id === b.dataset.show)?.show?.(); });
  $('#feed').addEventListener('click', e => {
    const li = e.target.closest('[data-k]'); if (!li) return;
    const ev = E[+li.dataset.k];
    setFollow(ev[1]);
    st.t = clamp((st.mode === 'together' ? ev[0] - P[ev[1]].join : ev[0]) - 3000, ...range[st.mode]);
  });
  $('#board').addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) setFollow(+li.dataset.i); });
  $('#search').addEventListener('input', () => updateBoard(true));
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!st.playing); }
    if (e.key === 'h') setLayer('heat', !st.layers.heat);
    if (e.key === 'Escape') setFollow(-1);
  });
  const themes = ['auto', 'dark', 'light'];
  let themeIdx = 0;
  $('#theme').addEventListener('click', () => {
    themeIdx = (themeIdx + 1) % 3;
    if (themes[themeIdx] === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = themes[themeIdx];
    retheme();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => retheme());
  const retheme = () => { readTokens(); drawStatic(); drawSpark(); renderLegend(); st.lastFeedKey = ''; st.lastBoard = 0; if (st.follow >= 0) $('#followSw').style.background = C.bands[P[st.follow].band]; };
  new ResizeObserver(resize).observe(cv);
  window.addEventListener('resize', resize);

  let last = performance.now();
  const tick = now => {
    const dt = Math.min(100, now - last); last = now;
    if (st.playing) {
      st.t += dt * st.speed;
      const [a, b] = range[st.mode];
      if (st.mode === 'real' && !P.some(visible)) {
        const next = Math.min(...P.filter(p => p.join > st.t).map(p => p.join));
        if (Number.isFinite(next)) st.t = next - 1500;
      }
      if (st.t >= b) { st.t = b; if (!st.demo) setPlaying(false); }
      if (st.t < a) st.t = a;
    }
    if (st.tween) {
      const k = clamp((now - st.tween.t0) / st.tween.ms, 0, 1), e = ease(k);
      st.cam.x = lerp(st.tween.from.x, st.tween.to.x, e);
      st.cam.y = lerp(st.tween.from.y, st.tween.to.y, e);
      st.cam.z = lerp(st.tween.from.z, st.tween.to.z, e);
      if (k >= 1) st.tween = null;
    }
    if (st.follow >= 0 && visible(P[st.follow])) {
      const [x, y] = posAt(P[st.follow], playerTime(P[st.follow]));
      const k = st.tween ? 0.06 : 0.12;
      st.cam.x = lerp(st.cam.x, x, k); st.cam.y = lerp(st.cam.y, y, k);
    }
    draw(now);
    updateClock();
    updateFeed();
    updateBoard();
    requestAnimationFrame(tick);
  };

  readTokens();
  drawStatic();
  $('#world').textContent = `${D.title} · ${D.counts.players} players · ${D.counts.events.toLocaleString()} events`;
  renderFindings();
  renderLegend();
  setMode('together', false);
  resize();
  requestAnimationFrame(tick);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const findHandle = h => P.findIndex(p => p.h === h);
  const runDemo = async () => {
    st.demo = true;
    document.body.classList.add('demo');
    resize();
    const vo = window.VO_DUR ?? {};
    window.demoCues = [];
    const cue = id => window.demoCues.push({ id, t: Date.now() / 1000 });
    const cap = $('#caption'), call = $('#callout'), card = $('#card'), panel = $('#panel');
    await sleep(STORY.lead_ms ?? 800);
    for (const sc of STORY.scenes) {
      const words = (sc.vo ?? '').split(/\s+/).filter(Boolean).length;
      const voDur = vo[sc.id] ?? words / 2.7;
      const dur = Math.max(sc.min ?? 2, voDur + (sc.pad ?? 0.7)) * 1000;
      if (sc.sfx) cue(`sfx:${sc.sfx}`);
      if (sc.vo) cue(sc.id);
      if (sc.theme) { document.documentElement.dataset.theme = sc.theme; retheme(); }
      if (sc.mode) setMode(sc.mode, false);
      if (sc.t != null) st.t = clamp(sc.t, ...range[st.mode]);
      if (sc.speed) setSpeed(sc.speed);
      if (sc.layers) for (const [k, v] of Object.entries(sc.layers)) setLayer(k, v);
      if (sc.follow !== undefined) setFollow(sc.follow ? findHandle(sc.follow) : -1);
      if (sc.cam === 'fit') flyTo(W / 2, H / 2, 1, sc.cam_ms ?? 1600);
      else if (sc.cam) flyTo(sc.cam[0] + 0.5, sc.cam[1] + 0.5, sc.cam[2] ?? 2.5, sc.cam_ms ?? 1600);
      if (sc.playing !== undefined) setPlaying(sc.playing);
      panel.classList.toggle('show-panel', !!sc.panel);
      if (sc.panel) {
        $(`[data-tab="${sc.panel}"]`).click();
        $$('.finding').forEach(f => f.classList.remove('pulse'));
        if (sc.finding) { const f = $(`#f-${sc.finding}`); f?.classList.add('pulse'); f?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      }
      card.hidden = !sc.card;
      if (sc.card) card.innerHTML = `<div class="inner">${sc.card.eyebrow ? `<div class="eyebrow">${esc(sc.card.eyebrow)}</div>` : ''}<h2>${esc(sc.card.title)}</h2>${sc.card.sub ? `<p>${esc(sc.card.sub)}</p>` : ''}</div>`;
      call.hidden = !sc.callout;
      if (sc.callout) {
        call.innerHTML = `<h4>${esc(sc.callout.title)}</h4><ul>${sc.callout.items.map(it => (it.quote ? `<li class="quote">“${esc(it.quote)}”</li>` : `<li><b>${esc(it.n)}</b><span>${esc(it.text)}</span></li>`)).join('')}</ul>`;
        const lis = [...call.querySelectorAll('li')];
        const stepMs = Math.min(1400, (dur * 0.6) / Math.max(1, lis.length));
        lis.forEach((li, i) => setTimeout(() => li.classList.add('in'), 300 + i * stepMs));
      }
      captions(cap, sc.vo, voDur * 1000);
      for (const [at, act] of sc.at ?? []) setTimeout(() => {
        if (act.cam) flyTo(act.cam[0] + 0.5, act.cam[1] + 0.5, act.cam[2] ?? st.cam.z, act.cam_ms ?? 1400);
        if (act.cam === 'fit') flyTo(W / 2, H / 2, 1, act.cam_ms ?? 1400);
        if (act.follow !== undefined) setFollow(act.follow ? findHandle(act.follow) : -1);
        if (act.layers) for (const [k, v] of Object.entries(act.layers)) setLayer(k, v);
        if (act.speed) setSpeed(act.speed);
        if (act.sfx) cue(`sfx:${act.sfx}`);
        if (act.finding) { $$('.finding').forEach(f => f.classList.remove('pulse')); const f = $(`#f-${act.finding}`); f?.classList.add('pulse'); f?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      }, at * 1000);
      await sleep(dur);
    }
    cap.hidden = true;
    await sleep(STORY.tail_ms ?? 600);
    window.demoDone = true;
  };
  const captions = (el, text, ms) => {
    clearTimeout(captions.t);
    if (!text) { el.hidden = true; return; }
    const chunks = [];
    let cur = [];
    for (const w of text.split(/\s+/)) {
      cur.push(w);
      if ((cur.length >= 6 && /[,.;:?!]$/.test(w)) || cur.length >= 11) { chunks.push(cur.join(' ')); cur = []; }
    }
    if (cur.length) chunks.push(cur.join(' '));
    const total = chunks.reduce((s, c) => s + c.length, 0);
    let i = 0;
    const next = () => {
      if (i >= chunks.length) { el.hidden = true; return; }
      el.hidden = false; el.textContent = chunks[i];
      captions.t = setTimeout(next, (chunks[i].length / total) * ms);
      i++;
    };
    next();
  };
  window.replay = { st, P, jump, setMode, setFollow, findings, insights: I };
  if (STORY && new URLSearchParams(location.search).has('demo')) runDemo();
})();
