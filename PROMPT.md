# Prompt: replay a new maze log

Paste this into Claude Code, Codex or any coding agent that can run Node 20+. Replace the folder path.

---

You have the `maze-replay` repo checked out and a new ROE Maze log folder at `<FOLDER>` (from `npm run maze:sync` in tds-network-games: `events.jsonl`, `layout.json`, `config.json`, `players.csv`, `manifest.json`).

1. Run `npm install` if `node_modules` is missing.
2. Run `node test/check.mjs <FOLDER>`. Every line must say PASS. If a privacy check fails, stop and report which pattern leaked. Do not share the page.
3. Run `node render.mjs <FOLDER> --out out/<world> --title "<world name and date>"`.
4. Open `out/<world>/index.html` in a browser. Confirm the map draws, dots move, and the Findings tab has cards. Take a screenshot.
5. Read `out/<world>/insights.json` and write five short findings, most important first. For each, give the number and the "Show me" card it comes from. Say what is an observation and what is a guess about why.
6. Compare with the 23 Nov practice log: the vault door (46 tried, 10 solved, all 24+), peak 16 online, 21 of 92 scored 0. Say which patterns held and which changed.

Do not commit `out/` or the log folder. They contain student data.

---

## Without an agent

```sh
node test/check.mjs <FOLDER> && node render.mjs <FOLDER> --out out/<world> --title "<name>"
```
