// Tune the house bot against simple and exploit plans. usage: node sim/tune_house.mjs [matches] '[{reader opts}, ...]'
import { newGame, resolveRound, standings, rng, payout } from "../src/engine.js";
import { POLICIES, houseBot } from "../src/bots.js";
const N = parseInt(process.argv[2] || "100", 10);
const variants = JSON.parse(process.argv[3] || '[{"oarWorth":1,"temp":0.35}]');
const vv = (g) => g.pots.map((_, i) => payout(g, i));
const rankAt = (g, k) => { const x = vv(g); return x.map((_, i) => i).sort((a, b) => x[b] - x[a])[k]; };
const plans = {
  secondHalf: (g, s) => { const i = rankAt(g, 1); return { site: i, bid: Math.min(g.oars[s], Math.floor(vv(g)[i] / 2) + 1) }; },
  second: (g, s) => ({ site: rankAt(g, 1), bid: Math.min(g.oars[s], 1) }),
  sample: (g, s) => { const i = rankAt(g, 0), ro = Math.max(...g.oars.filter((_, k) => k !== s));
    return { site: i, bid: g.round === g.cfg.rounds ? g.oars[s] : g.oars[s] > ro ? Math.min(g.oars[s], Math.floor(vv(g)[i] / 2) + 1) : 0 }; },
  topper: POLICIES.topper, patient: POLICIES.patient, raider: POLICIES.raider, bully: POLICIES.bully, steady: POLICIES.steady, fair: POLICIES.fair,
};
function house(o) {
  return (g, seat, r, botSeats) => houseBot(g, seat, r, { ...o, botSeats });
}
for (const o of variants) {
  const hb = house(o);
  const row = {};
  let worst = 0;
  for (const [name, p] of Object.entries(plans)) {
    const cell = [];
    for (const n of [4, 2]) {
      let w = 0;
      for (let m = 0; m < N; m++) {
        const k = m % n, r = rng(m * 31 + n);
        let g = newGame(n, m * 977 + n + 5);
        const bs = Array.from({ length: n }, (_, s) => s).filter((s) => s !== k);
        while (!g.over) g = resolveRound(g, Array.from({ length: n }, (_, s) => (s === k ? p(g, s, r) : hb(g, s, r, bs))));
        const ws = standings(g).winners; if (ws.includes(k)) w += 1 / ws.length;
      }
      cell.push(+(w / N).toFixed(2));
      worst = Math.max(worst, (w / N) / (1 / n));
    }
    row[name] = cell.join("/");
  }
  console.log(worst.toFixed(2), JSON.stringify(o), JSON.stringify(row));
}
