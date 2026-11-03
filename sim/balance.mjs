// Balance evidence for DESIGN.md and README. usage: node sim/balance.mjs [matches=2000] > sim/balance.json
// 1. Every simple fixed plan vs the house bot (4p: plan + 3 house bots; 2p: plan vs 1 house bot).
// 2. Head-to-head of the three strongest simple plans (2p): they form a cycle.
// 3. Round-robin of all simple plans (4p tables of four different plans; 2p every pairing).
// 4. House bot self-play: seat balance.
// A shared win counts 1/k. Seats rotate or shuffle every match; seeds are fixed, so reruns match.
import { newGame, resolveRound, standings, rng, shuffle, payout } from "../src/engine.js";
import { POLICIES, houseBot } from "../src/bots.js";
const N = parseInt(process.argv[2] || "2000", 10);
const HOUSE_N = Math.max(100, Math.round(N / 4));
const SIMPLE = ["bully", "dodger", "shark", "fair", "steady", "topper", "raider", "allin", "patient", "banker", "random"];
// plans written to probe the house bot (not in the round-robin): the second-richest cove, and the sample bot's rule
const vv = (g) => g.pots.map((_, i) => payout(g, i));
const rankAt = (g, k) => { const x = vv(g); return x.map((_, i) => i).sort((a, b) => x[b] - x[a])[k]; };
POLICIES.second = (g, s) => { const i = rankAt(g, 1); return { site: i, bid: Math.min(g.oars[s], Math.floor(vv(g)[i] / 2) + 1) }; };
POLICIES.sample = (g, s) => { const i = rankAt(g, 0), ro = Math.max(...g.oars.filter((_, k) => k !== s));
  return { site: i, bid: g.round === g.cfg.rounds ? g.oars[s] : g.oars[s] > ro ? Math.min(g.oars[s], Math.floor(vv(g)[i] / 2) + 1) : 0 }; };
const PROBES = [...SIMPLE, "second", "sample"];
function match(seats, seed) {
  const r = rng(seed * 7 + 5);
  let g = newGame(seats.length, seed * 101 + 9);
  const botSeats = seats.map((p, i) => (p === "house" ? i : -1)).filter((i) => i >= 0);
  while (!g.over) g = resolveRound(g, seats.map((p, s) => (p === "house" ? houseBot(g, s, r, { botSeats }) : POLICIES[p](g, s, r))));
  return { winners: standings(g).winners, gold: g.gold };
}
function combos(a, k) { if (!k) return [[]]; const o = []; a.forEach((x, i) => combos(a.slice(i + 1), k - 1).forEach((c) => o.push([x, ...c]))); return o; }
const out = { generated: new Date().toISOString().slice(0, 16) + "Z", rulesVersion: 4 };

out.vsHouse = { matchesPerCell: HOUSE_N, note: "win share of the plan; fair share is 0.25 at 4 seats, 0.50 at 2", rows: {} };
for (const p of PROBES) {
  const cell = {};
  for (const n of [4, 2]) {
    let w = 0;
    for (let m = 0; m < HOUSE_N; m++) {
      const k = m % n, seats = Array(n).fill("house"); seats[k] = p;
      const res = match(seats, m + n * 7919 + PROBES.indexOf(p) * 104729);
      if (res.winners.includes(k)) w += 1 / res.winners.length;
    }
    cell[n === 4 ? "vs3house" : "vs1house"] = +(w / HOUSE_N).toFixed(3);
  }
  out.vsHouse.rows[p] = cell;
}

// Table A: 4 players, six simple plans, every table of four different plans.
// Table B: 2 players, the three plans that contest the richest cove, every pairing.
for (const [label, pool, k] of [["fourPlayer", ["bully", "fair", "steady", "topper", "patient", "raider"], 4], ["twoPlayer", ["steady", "topper", "patient"], 2]]) {
  const groups = combos(pool, k), per = Math.ceil(N / groups.length);
  const wins = {}, games = {}, pair = {};
  pool.forEach((p) => (wins[p] = games[p] = 0));
  let m = 0;
  for (const grp of groups) for (let j = 0; j < per; j++, m++) {
    const seats = shuffle(grp, rng(m * 13 + k));
    const res = match(seats, m + k * 1000003);
    seats.forEach((p) => games[p]++);
    res.winners.forEach((s) => (wins[seats[s]] += 1 / res.winners.length));
    if (k === 2) { const key = grp.join(" v "); pair[key] = pair[key] || [0, 0]; pair[key][1]++; res.winners.forEach((s) => { if (seats[s] === grp[0]) pair[key][0] += 1 / res.winners.length; }); }
  }
  out[label] = { matches: m, tables: groups.length, winShare: Object.fromEntries(pool.map((p) => [p, +(wins[p] / games[p]).toFixed(3)])) };
  if (k === 2) out[label].headToHead = Object.fromEntries(Object.entries(pair).map(([a, [x, n]]) => [a, +(x / n).toFixed(3)]));
}
// For reference: every simple plan against every other (includes deliberately weak ones).
for (const k of [4, 2]) {
  const groups = combos(SIMPLE, k), per = Math.max(1, Math.ceil(N / groups.length));
  const wins = {}, games = {};
  SIMPLE.forEach((p) => (wins[p] = games[p] = 0));
  let m = 0;
  for (const grp of groups) for (let j = 0; j < per; j++, m++) {
    const seats = shuffle(grp, rng(m * 17 + k));
    const res = match(seats, m + k * 2000003);
    seats.forEach((p) => games[p]++);
    res.winners.forEach((s) => (wins[seats[s]] += 1 / res.winners.length));
  }
  out[`allPlans${k}p`] = { matches: m, winShare: Object.fromEntries(SIMPLE.map((p) => [p, +(wins[p] / games[p]).toFixed(3)])) };
}

out.houseSelfPlay = {};
for (const n of [4, 2]) {
  const w = Array(n).fill(0), M = HOUSE_N;
  let margin = 0;
  for (let m = 0; m < M; m++) {
    const res = match(Array(n).fill("house"), m + n * 555);
    res.winners.forEach((s) => (w[s] += 1 / res.winners.length));
    const s = res.gold.slice().sort((a, b) => b - a); margin += s[0] - s[1];
  }
  out.houseSelfPlay[n + "p"] = { matches: M, seatWinShare: w.map((x) => +(x / M).toFixed(3)), avgWinningMargin: +(margin / M).toFixed(1) };
}
console.log(JSON.stringify(out, null, 1));
