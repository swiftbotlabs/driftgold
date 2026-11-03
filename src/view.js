// Turns internal match state into the public JSON the API returns. The engine says site; the API says
// cove. Sealed moves of the current round are never included.
import { payout, isLastRound } from "./engine.js";

export function roundView(h, auto = []) {
  return {
    round: h.round,
    double: h.double,
    goldBefore: h.goldBefore,
    oarsBefore: h.oarsBefore,
    coves: h.pots.map((p, i) => ({ cove: i, gold: p, payout: p * (h.double ? 2 : 1) })),
    moves: h.moves.map((mv, seat) => ({ seat, cove: mv.site, oars: mv.bid, auto: auto.includes(seat) })),
    results: h.results.map((r) => ({
      cove: r.site,
      payout: r.value,
      captains: r.seats,
      oars: r.bids,
      winner: r.winner,
      oarsPaid: r.paid,
      oarsPerCaptain: r.share,
      paidTo: r.paidTo,
      oarsLost: r.lost,
      tie: r.tie,
    })),
    // gold the tide added to each cove that nobody took (0 for taken coves)
    tide: h.tide ? h.tide.map((t, i) => (h.results[i].winner === null ? t : 0)) : null,
    goldAfter: h.gold,
    oarsAfter: h.oars,
  };
}

function captains(m, you, g) {
  return m.seats.map((s, seat) => ({
    seat,
    name: s ? s.name : null,
    kind: s ? s.kind : "empty",
    gold: g ? g.gold[seat] : null,
    oars: g ? g.oars[seat] : null,
    moved: m.phase === "play" ? !!m.pending[seat] : null,
    you: seat === you,
  }));
}

export function stateView(m, you, now) {
  const g = m.game;
  const v = {
    code: m.code,
    phase: m.phase,
    rulesVersion: m.rulesVersion,
    players: m.players,
    roundSeconds: m.roundSeconds,
    version: m.version,
    serverTime: now,
    captains: captains(m, you, g),
    round: g ? (m.phase === "over" ? g.cfg.rounds : g.round) : 0,
    rounds: g ? g.cfg.rounds : 8,
    finalRound: g ? isLastRound(g) && m.phase === "play" : false,
    roundEndsAt: m.phase === "play" ? m.roundEndsAt : null,
    secondsLeft: m.phase === "play" ? Math.max(0, Math.ceil((m.roundEndsAt - now) / 1000)) : null,
    coves: g && m.phase === "play" ? g.pots.map((p, i) => ({ cove: i, gold: p, payout: payout(g, i) })) : [],
    previous: g && g.history.length ? roundView(g.history[g.history.length - 1], m.auto[g.history.length] || []) : null,
    you: null,
    winners: m.phase === "over" && m.final ? m.final.winners : null,
  };
  if (you >= 0) {
    const mine = m.pending[you];
    v.you = {
      seat: you,
      gold: g ? g.gold[you] : null,
      oars: g ? g.oars[you] : null,
      moved: !!mine && m.phase === "play",
      move: mine && m.phase === "play" ? { cove: mine.site, oars: mine.bid } : null,
    };
  }
  return v;
}

export function logView(m) {
  const g = m.game;
  return {
    code: m.code,
    phase: m.phase,
    rulesVersion: m.rulesVersion,
    players: m.players,
    captains: m.seats.map((s, seat) => ({ seat, name: s ? s.name : null, kind: s ? s.kind : "empty" })),
    start: g ? { gold: 0, oars: g.cfg.startOars } : null,
    startedAt: m.startedAt || null,
    finishedAt: m.finishedAt || null,
    rounds: g ? g.history.map((h) => roundView(h, m.auto[h.round] || [])) : [],
    final: m.phase === "over" && m.final ? { gold: g.gold, oars: g.oars, order: m.final.order, winners: m.final.winners } : null,
  };
}
