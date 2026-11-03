// How does the house bot hold up against simple fixed plans? usage: node sim/vs_house.mjs [matches] [json-rules]
// Reports the fixed plan's win share: vs 3 house bots (fair share 0.25) and vs 1 house bot (fair share 0.50).
import { newGame, resolveRound, standings, rng, payout } from "../src/engine.js";
import { POLICIES, houseBot } from "../src/bots.js";
const N = parseInt(process.argv[2] || "200", 10);
const over = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const v = (g) => g.pots.map((_, i) => payout(g, i));
const richest = (g) => { const x = v(g); return x.indexOf(Math.max(...x)); };
const extra = {
  topper2: (g, s) => { const i = richest(g); return { site: i, bid: Math.min(g.oars[s], Math.floor(v(g)[i] / 2) + 2) }; },
  allin: (g, s) => ({ site: richest(g), bid: g.oars[s] }),
  // the rule in bot/sample_bot.py
  sample: (g, s) => {
    const x = v(g), i = x.indexOf(Math.max(...x));
    const rivalOars = Math.max(...g.oars.filter((_, k) => k !== s));
    const last = g.round === g.cfg.rounds;
    return { site: i, bid: last ? g.oars[s] : g.oars[s] > rivalOars ? Math.min(g.oars[s], Math.floor(x[i] / 2) + 1) : 0 };
  },
};
const pol = { ...POLICIES, ...extra };
const plans = (process.argv[4] || "sample,topper,patient").split(",");
function run(p, n) {
  let wins = 0;
  for (let m = 0; m < N; m++) {
    const r = rng(m * 31 + 7 + n);
    const k = m % n;
    const seats = Array(n).fill("house"); seats[k] = p;
    let g = newGame(n, m * 977 + 3 + n, over);
    while (!g.over) g = resolveRound(g, seats.map((q, s) => (q === "house" ? houseBot : pol[q])(g, s, r)));
    const { winners } = standings(g);
    if (winners.includes(k)) wins += 1 / winners.length;
  }
  return +(wins / N).toFixed(3);
}
const out = {};
for (const p of plans) out[p] = { vs3house: run(p, 4), vs1house: run(p, 2) };
console.log(JSON.stringify(out));
