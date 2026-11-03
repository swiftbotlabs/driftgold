// Round-robin win shares. usage: node sim/rr.mjs pool [matches-per-group] [json-rules]
// 4p: every 4-policy table from the pool; 2p: every pairing. Seats are shuffled; a shared win counts 1/k.
import { newGame, resolveRound, standings, rng, shuffle } from "../src/engine.js";
import { POLICIES } from "../src/bots.js";
const POOL = process.argv[2].split(","), N = parseInt(process.argv[3] || "300", 10);
const over = process.argv[4] ? JSON.parse(process.argv[4]) : {};
function combos(a, k) { if (!k) return [[]]; const o = []; a.forEach((x, i) => combos(a.slice(i + 1), k - 1).forEach((c) => o.push([x, ...c]))); return o; }
const report = { pool: POOL, matchesPerTable: N, rules: over };
for (const k of [4, 3, 2]) {
  if (POOL.length < k) continue;
  const wins = {}, games = {}, pair = {};
  POOL.forEach((p) => (wins[p] = games[p] = 0));
  let m = 0, total = 0;
  for (const grp of combos(POOL, k)) for (let j = 0; j < N; j++, m++) {
    const seats = shuffle(grp, rng(m * 13 + 1 + k)), r = rng(m * 7 + 5 + k * 1000);
    let g = newGame(k, m * 101 + 9 + k, over);
    while (!g.over) g = resolveRound(g, seats.map((p, s) => POLICIES[p](g, s, r)));
    const { winners } = standings(g);
    total++;
    seats.forEach((p) => games[p]++);
    winners.forEach((w) => (wins[seats[w]] += 1 / winners.length));
    if (k === 2) { const key = grp.join(" v "); pair[key] = (pair[key] || 0) + winners.filter((w) => seats[w] === grp[0]).length / winners.length; }
  }
  report[k + "p"] = { matches: total, winShare: Object.fromEntries(POOL.map((p) => [p, +(wins[p] / games[p]).toFixed(3)])) };
  if (k === 2) report["2p"].pairings = Object.fromEntries(Object.entries(pair).map(([a, b]) => [a, +(b / N).toFixed(2)]));
}
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 1));
else for (const k of ["4p", "3p", "2p"]) if (report[k]) { console.log(k, report[k].matches, JSON.stringify(report[k].winShare)); if (report[k].pairings) console.log("   ", JSON.stringify(report[k].pairings)); }
