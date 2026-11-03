// Driftgold rules engine: pure and deterministic, shared by the Worker, the tests and the simulator.
// No I/O and no randomness except the seeded RNG the caller passes in.
//
// Gold is the score; oars are what you bid with. Each round every captain secretly picks one cove and
// a number of oars. Alone at a cove, you take its gold and keep your oars. Where captains meet, the
// most oars takes the gold and hands the oars it bid to the captains it beat, split evenly (odd oars
// are lost). Tied top bids go to the captain with less gold; if still tied, nobody takes it.
// Untaken coves gain 1-3 gold (the tide, random but fixed by the match seed); a taken cove restarts at 1.
// Round 8 pays double. Most gold wins; oars left break ties.

export const RULES_VERSION = 4;

export function configFor(players, opts = {}) {
  if (!Number.isInteger(players) || players < 2 || players > 4) throw new Error("players must be 2-4");
  return {
    players,
    sites: players + (opts.siteDelta ?? 1),
    rounds: opts.rounds ?? 8,
    startOars: opts.startOars ?? 10,
    resetTo: opts.resetTo ?? 1,
    loserShare: opts.loserShare ?? 1,
    lastRoundDouble: opts.lastRoundDouble ?? true,
    tide: opts.tide ?? [1, 3],
  };
}

// mulberry32: small seeded PRNG, good enough for shuffles and bot noise.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, r) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function newGame(players, seed, opts = {}) {
  const cfg = configFor(players, opts);
  const r = rng(seed);
  const pots = shuffle(Array.from({ length: cfg.sites }, (_, i) => i + 1), r);
  return { cfg, seed: seed >>> 0, round: 1, over: false, pots, gold: Array(players).fill(0), oars: Array(players).fill(cfg.startOars), history: [] };
}

export function isLastRound(g) {
  return g.round === g.cfg.rounds;
}

// Gold a cove pays this round (the last round pays double).
export function payout(g, site) {
  return g.pots[site] * (isLastRound(g) && g.cfg.lastRoundDouble ? 2 : 1);
}

// Returns {ok:true, move} or {ok:false, error}. A move is {site, bid} with integers; bid is in oars.
export function checkMove(g, seat, move) {
  if (g.over) return { ok: false, error: "match is over" };
  if (!move || typeof move !== "object" || Array.isArray(move)) return { ok: false, error: "move must be an object" };
  const { site, bid } = move;
  if (!Number.isInteger(site) || site < 0 || site >= g.cfg.sites) return { ok: false, error: `cove must be an integer 0-${g.cfg.sites - 1}` };
  if (!Number.isInteger(bid) || bid < 0) return { ok: false, error: "oars must be a non-negative integer" };
  if (bid > g.oars[seat]) return { ok: false, error: `you bid ${bid} oars but have ${g.oars[seat]}` };
  return { ok: true, move: { site, bid } };
}

// Resolve one cove. entrants = [{seat, bid, gold}] (gold = holdings at the start of the round).
// Returns {winner, gold: Map(seat -> gold change), oars: Map(seat -> oar change), paid, share, paidTo, lost, tie}.
export function resolveSite(cfg, value, entrants) {
  const out = { winner: null, gold: new Map(), oars: new Map(), paid: 0, share: 0, paidTo: [], lost: 0, tie: false };
  for (const x of entrants) { out.gold.set(x.seat, 0); out.oars.set(x.seat, 0); }
  if (!entrants.length) return out;
  const top = Math.max(...entrants.map((x) => x.bid));
  let best = entrants.filter((x) => x.bid === top);
  if (best.length > 1) {
    // Comeback rule: a tie goes to whoever has less gold; if that is still tied, nobody takes it.
    const low = Math.min(...best.map((x) => x.gold));
    best = best.filter((x) => x.gold === low);
    out.tie = true;
  }
  if (best.length !== 1) return out;
  const w = best[0];
  const others = entrants.filter((x) => x !== w);
  out.winner = w.seat;
  out.gold.set(w.seat, value);
  if (others.length && top > 0) {
    // The winner hands the oars it bid to the captains it beat, split evenly; odd oars are lost.
    const share = Math.floor(Math.floor(top * cfg.loserShare) / others.length);
    Object.assign(out, { paid: top, share, paidTo: others.map((x) => x.seat), lost: top - share * others.length });
    out.oars.set(w.seat, -top);
    for (const u of others) out.oars.set(u.seat, share);
  }
  return out;
}

// Resolve one round. moves[seat] = {site, bid}. Returns a NEW state; the input is not mutated.
export function resolveRound(g0, moves) {
  if (g0.over) throw new Error("match is over");
  const n = g0.cfg.players;
  if (!Array.isArray(moves) || moves.length !== n) throw new Error("need one move per seat");
  for (let s = 0; s < n; s++) {
    const c = checkMove(g0, s, moves[s]);
    if (!c.ok) throw new Error(`seat ${s}: ${c.error}`);
  }
  const cfg = g0.cfg;
  const gold = g0.gold.slice();
  const oars = g0.oars.slice();
  const pots = g0.pots.slice();
  const results = [];
  // The tide: each untaken cove gains a random amount in cfg.tide (inclusive), fixed by the match seed.
  const tr = rng(((g0.seed ?? 0) ^ Math.imul(g0.round, 0x9e3779b1)) >>> 0);
  const tide = Array.from({ length: cfg.sites }, () => cfg.tide[0] + Math.floor(tr() * (cfg.tide[1] - cfg.tide[0] + 1)));
  for (let site = 0; site < cfg.sites; site++) {
    const here = [];
    for (let s = 0; s < n; s++) if (moves[s].site === site) here.push(s);
    const value = payout(g0, site);
    const o = resolveSite(cfg, value, here.map((s) => ({ seat: s, bid: moves[s].bid, gold: g0.gold[s] })));
    for (const [s, d] of o.gold) gold[s] += d;
    for (const [s, d] of o.oars) oars[s] += d;
    results.push({ site, value, seats: here, bids: here.map((s) => moves[s].bid), winner: o.winner, paid: o.paid, share: o.share, paidTo: o.paidTo, lost: o.lost, tie: o.tie });
    pots[site] = o.winner === null ? g0.pots[site] + tide[site] : cfg.resetTo;
  }
  const g = { cfg, seed: g0.seed, round: g0.round, over: false, pots, gold, oars, history: g0.history.slice() };
  g.history.push({
    round: g0.round,
    pots: g0.pots.slice(),
    double: isLastRound(g0) && cfg.lastRoundDouble,
    goldBefore: g0.gold.slice(),
    oarsBefore: g0.oars.slice(),
    moves: moves.map((m) => ({ site: m.site, bid: m.bid })),
    results,
    tide,
    gold: gold.slice(),
    oars: oars.slice(),
  });
  if (g0.round >= cfg.rounds) g.over = true;
  else g.round = g0.round + 1;
  return g;
}

// Final ranking: most gold; oars left break ties. Returns seats best-first and the winners.
export function standings(g) {
  const order = g.gold.map((_, i) => i).sort((a, b) => g.gold[b] - g.gold[a] || g.oars[b] - g.oars[a] || a - b);
  const top = order[0];
  const winners = order.filter((s) => g.gold[s] === g.gold[top] && g.oars[s] === g.oars[top]);
  return { order, winners };
}
