// usage: node sim/trace.mjs policyA,policyB[,..] [seed] [json-rules]
import { newGame, resolveRound, standings, rng } from "../src/engine.js";
import { POLICIES, reader } from "../src/bots.js";
const names = (process.argv[2] || "topper,reader").split(",");
const seed = parseInt(process.argv[3] || "7", 10);
const over = process.argv[4] ? JSON.parse(process.argv[4]) : {};
import { houseBot } from "../src/bots.js";
import { payout } from "../src/engine.js";
const vv = (g) => g.pots.map((_, i) => payout(g, i));
const pol = { ...POLICIES, house: houseBot, strong: (g, s, r) => reader(g, s, r, { oarWorth: 1, temp: 0.3 }),
  secondHalf: (g, s) => { const x = vv(g), o = x.map((_, i) => i).sort((a, b) => x[b] - x[a]); return { site: o[1], bid: Math.min(g.oars[s], Math.floor(x[o[1]] / 2) + 1) }; } };
const r = rng(seed ^ 0x9e3779b9);
let g = newGame(names.length, seed, over);
while (!g.over) {
  const moves = names.map((p, s) => pol[p](g, s, r));
  const pots = g.pots.join(","), gd = g.gold.join(","), oa = g.oars.join(",");
  g = resolveRound(g, moves);
  const h = g.history.at(-1);
  console.log(`R${h.round}${h.double ? "x2" : "  "} coves[${pots}] gold[${gd}] oars[${oa}] ${moves.map((m, i) => names[i].slice(0, 3) + ":" + m.site + "/" + m.bid).join(" ")} -> ${h.results.filter((x) => x.winner != null).map((x) => names[x.winner].slice(0, 3) + "@" + x.site + "+" + x.value + (x.paid ? "(-" + x.paid + "oar)" : "")).join(" ")}`);
}
console.log("final gold", g.gold, "oars", g.oars, standings(g).winners.map((w) => names[w]));
