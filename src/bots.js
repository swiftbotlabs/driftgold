// Bot policies. Each takes (game, seat, r) where r() is a seeded random in [0,1) and returns {site, bid}
// (bid in oars). They read only public information (coves, gold, oars, history): what every player sees.
import { payout, resolveSite } from "./engine.js";

function argmaxRandom(values, r) {
  const best = Math.max(...values);
  const idx = values.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
  return idx[Math.floor(r() * idx.length)];
}

function weightedPick(weights, r) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return Math.floor(r() * weights.length);
  let x = r() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

const values = (g) => g.pots.map((_, i) => payout(g, i));
const clampBid = (g, seat, b) => Math.max(0, Math.min(g.oars[seat], Math.round(b)));
function pickSite(v, power, r) {
  return weightedPick(v.map((x) => Math.pow(x, power)), r);
}

// ---- simple styles (used to test balance) ----

// Bully: leans hard toward rich coves and rows 40-70% of its oars.
export function bully(g, seat, r) {
  const v = values(g);
  return { site: pickSite(v, 2, r), bid: clampBid(g, seat, g.oars[seat] * (0.4 + 0.3 * r())) };
}

// Dodger: goes where it expects to be alone (rivals assumed to pick in proportion to value), rows 0-1.
export function dodger(g, seat, r) {
  const v = values(g);
  const tot = v.reduce((a, b) => a + b, 0);
  const score = v.map((x) => x * Math.pow(1 - x / tot, g.cfg.players - 1));
  return { site: weightedPick(score.map((x) => x * x), r), bid: clampBid(g, seat, r() < 0.5 ? 0 : 1) };
}

// Shark: leans toward rich coves and never rows: free gold if alone, collects oars if beaten.
export function shark(g, seat, r) {
  const v = values(g);
  return { site: pickSite(v, 2, r), bid: 0 };
}

// Fair: mild lean toward value, rows about half the cove's gold.
export function fair(g, seat, r) {
  const v = values(g);
  const site = pickSite(v, 1, r);
  return { site, bid: clampBid(g, seat, v[site] * (0.4 + 0.2 * r())) };
}

// Steady: always the richest cove, rows half its gold (the sample bot's rule).
export function steady(g, seat, r) {
  const v = values(g);
  const site = argmaxRandom(v, r);
  return { site, bid: clampBid(g, seat, Math.floor(v[site] / 2)) };
}

// Topper: always the richest cove, rows one more than half its gold.
export function topper(g, seat, r) {
  const v = values(g);
  const site = argmaxRandom(v, r);
  return { site, bid: clampBid(g, seat, Math.floor(v[site] / 2) + 1) };
}

// Raider: always the richest cove, rows two more than half its gold (beats Topper head-on).
export function raider(g, seat, r) {
  const v = values(g);
  const site = argmaxRandom(v, r);
  return { site, bid: clampBid(g, seat, Math.floor(v[site] / 2) + 2) };
}

// All-in: always the richest cove with every oar.
export function allin(g, seat, r) {
  const v = values(g);
  return { site: argmaxRandom(v, r), bid: g.oars[seat] };
}

// Patient: lets richer-in-oars rivals win (collecting their oars) and fights for the richest cove only
// when it holds more oars than every rival.
export function patient(g, seat, r) {
  const v = values(g);
  const site = argmaxRandom(v, r);
  const rivalMax = Math.max(...g.oars.filter((_, i) => i !== seat));
  if (g.round === g.cfg.rounds) return { site, bid: g.oars[seat] };
  if (g.oars[seat] > rivalMax) return { site, bid: clampBid(g, seat, Math.floor(v[site] / 2) + 2) };
  return { site, bid: 0 };
}

// Banker: rows nothing (collecting oars from whoever beats it) until the last two rounds, then goes
// all in at the richest cove.
export function banker(g, seat, r) {
  const v = values(g);
  if (g.round >= g.cfg.rounds - 1) return { site: argmaxRandom(v, r), bid: g.oars[seat] };
  return { site: pickSite(v, 1, r), bid: 0 };
}

// Random: uniform cove and bid. Baseline only.
export function random(g, seat, r) {
  return { site: Math.floor(r() * g.cfg.sites), bid: Math.floor(r() * (g.oars[seat] + 1)) };
}

// ---- Reader: the adaptive bot ----
// Learns each rival's habits from the match so far (which value rank it visits, what it rows relative
// to the cove's gold), samples likely rounds, and picks the move with the best result relative to the
// table: gold now, plus oars valued by how much of the match is left. Softmax keeps it unpredictable.
const RATIOS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2];

function rivalModel(g, o) {
  const rank = Array(g.cfg.sites).fill(1);
  rank[0] += 1;
  const ratio = RATIOS.map(() => 1);
  for (const h of g.history) {
    const vals = h.pots.map((p) => p * (h.double ? 2 : 1));
    const order = vals.map((_, i) => i).sort((a, b) => vals[b] - vals[a]);
    const m = h.moves[o];
    rank[order.indexOf(m.site)] += 2;
    const q = m.bid / Math.max(1, vals[m.site]);
    let k = 0;
    for (let i = 1; i < RATIOS.length; i++) if (Math.abs(RATIOS[i] - q) < Math.abs(RATIOS[k] - q)) k = i;
    ratio[k] += 2;
  }
  return { rank, ratio };
}

// Score every sensible (cove, oars) option for `seat`. sampleRival(o) draws one likely move for rival o.
function scoreOptions(g, seat, r, opts, sampleRival) {
  const samples = opts.samples ?? 32;
  const n = g.cfg.players;
  const v = values(g);
  const left = (g.cfg.rounds - g.round) / g.cfg.rounds; // share of the match still to play after this round
  const oarWorth = (opts.oarWorth ?? 1) * left;
  const scen = [];
  for (let k = 0; k < samples; k++) {
    const sc = [];
    for (let o = 0; o < n; o++) if (o !== seat) { const m = sampleRival(o); sc.push({ seat: o, site: m.site, bid: m.bid, gold: g.gold[o] }); }
    scen.push(sc);
  }
  const worth = (out, s) => out.gold.get(s) + oarWorth * out.oars.get(s);
  // what rivals gain at each cove if I stay away
  const base = scen.map((sc) => {
    const bySite = v.map(() => 0);
    for (let site = 0; site < v.length; site++) {
      const ent = sc.filter((x) => x.site === site);
      if (ent.length) { const o = resolveSite(g.cfg, v[site], ent); for (const x of ent) bySite[site] += worth(o, x.seat); }
    }
    return { bySite, total: bySite.reduce((a, b) => a + b, 0) };
  });
  // Only 0 and the bids that tie or just beat a sampled rival bid can be best: between those points a
  // bigger bid changes no outcome and only hands over more oars. (Plus all-in, which matters last round.)
  const cands = [];
  for (let site = 0; site < v.length; site++) {
    const pts = new Set([0, g.oars[seat]]);
    for (const sc of scen) for (const x of sc) if (x.site === site) { pts.add(x.bid); pts.add(x.bid + 1); }
    for (const bid of pts) {
      if (bid > g.oars[seat]) continue;
      let total = 0;
      scen.forEach((sc, k) => {
        const ent = sc.filter((x) => x.site === site);
        const o = resolveSite(g.cfg, v[site], [...ent, { seat, bid, gold: g.gold[seat] }]);
        let rivalsHere = 0;
        for (const x of ent) rivalsHere += worth(o, x.seat);
        const rivalsAll = base[k].total - base[k].bySite[site] + rivalsHere;
        // judged relative to the table: my gain minus the average rival gain this round
        total += worth(o, seat) - rivalsAll / (n - 1);
      });
      // in the last round oars are worth nothing afterwards: among equal options, row more
      cands.push({ site, bid, u: total / samples + (left === 0 ? 1e-3 * bid : 0) });
    }
  }
  return cands;
}

function softPick(cands, temp, r) {
  const maxU = Math.max(...cands.map((c) => c.u));
  return cands[weightedPick(cands.map((c) => Math.exp((c.u - maxU) / temp)), r)];
}

// opts: temp, samples, oarWorth, botSeats (seats known to run this same algorithm: public, since seat
// kinds are public and the code is open). For those rivals the Reader predicts their move by running
// their decision one level down instead of extrapolating their history, so bots do not all pile onto
// the same cove.
export function reader(g, seat, r, opts = {}) {
  const temp = opts.temp ?? 0.35;
  const n = g.cfg.players;
  const v = values(g);
  const order = v.map((_, i) => i).sort((a, b) => v[b] - v[a] || (r() < 0.5 ? -1 : 1));
  const models = [];
  for (let o = 0; o < n; o++) models.push(rivalModel(g, o));
  const last = g.round === g.cfg.rounds;
  const fromHistory = (o) => {
    const site = order[weightedPick(models[o].rank, r)];
    // in the last round, expect half of rivals to throw in every oar they have
    if (last && r() < 0.5) return { site, bid: g.oars[o] };
    return { site, bid: clampBid(g, o, RATIOS[weightedPick(models[o].ratio, r)] * v[site]) };
  };
  let sampleRival = fromHistory;
  const bots = (opts.botSeats || []).filter((o) => o !== seat);
  if (bots.length && opts.level2 !== false) {
    const predicted = {};
    for (const o of bots) {
      const c = scoreOptions(g, o, r, { ...opts, samples: opts.level2Samples ?? 16 }, fromHistory);
      const maxU = Math.max(...c.map((x) => x.u));
      predicted[o] = { c, w: c.map((x) => Math.exp((x.u - maxU) / temp)) };
    }
    const mix = opts.level2Mix ?? 0.7; // share of samples that use the one-level-down prediction
    sampleRival = (o) => (predicted[o] && r() < mix ? predicted[o].c[weightedPick(predicted[o].w, r)] : fromHistory(o));
  }
  const pick = softPick(scoreOptions(g, seat, r, opts, sampleRival), temp, r);
  return { site: pick.site, bid: pick.bid };
}

// Human-like versions of the three richest-cove plans: 80% the richest cove (else the second), bids
// jittered by one oar either way. Used for the balance table.
function noisy(base) {
  return (g, seat, r) => {
    const v = values(g);
    const order = v.map((_, i) => i).sort((a, b) => v[b] - v[a] || (r() < 0.5 ? -1 : 1));
    const m = base(g, seat, r);
    const site = r() < 0.8 ? m.site : order[1];
    return { site, bid: clampBid(g, seat, m.bid + Math.floor(r() * 3) - 1) };
  };
}
export const steadyN = noisy(steady), topperN = noisy(topper), patientN = noisy(patient);

export const POLICIES = { bully, dodger, shark, fair, steady, topper, raider, allin, patient, banker, reader, random, steadyN, topperN, patientN };

// House bot for empty seats: the Reader, with a per-seat temperament so a table of bots is not three
// copies of one player. Each temperament mixes in one simple style some of the time.
const TEMPERAMENTS = [fair, shark, bully, dodger];
export function houseBot(g, seat, r, ctx = {}) {
  const style = TEMPERAMENTS[seat % TEMPERAMENTS.length];
  if (g.round === g.cfg.rounds) {
    // last round: oars are worth nothing afterwards, so choose the cove and row everything
    const m = reader(g, seat, r, { temp: 0.35, samples: ctx.samples ?? 24, level2Samples: ctx.level2Samples ?? 10, botSeats: ctx.botSeats, level2Mix: ctx.level2Mix ?? 0.7 });
    return { site: m.site, bid: g.oars[seat] };
  }
  if (g.round > 1 && r() < (ctx.mix ?? 0.1)) return style(g, seat, r);
  // round 1 has no history to read, so a light search is as good and keeps a cold start cheap
  if (g.round === 1) return reader(g, seat, r, { temp: 0.6, samples: 12, level2: false });
  return reader(g, seat, r, { temp: (ctx.temp ?? 0.35) + 0.1 * (seat % 3), oarWorth: ctx.oarWorth ?? 1, samples: ctx.samples ?? 24, level2Samples: ctx.level2Samples ?? 10, botSeats: ctx.botSeats, level2: ctx.level2, level2Mix: ctx.level2Mix ?? 0.7 });
}
POLICIES.house = houseBot;
