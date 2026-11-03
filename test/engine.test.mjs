// Rules tests: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { newGame, resolveRound, checkMove, standings, payout, resolveSite, configFor, rng } from "../src/engine.js";
import { POLICIES, houseBot } from "../src/bots.js";

const mv = (site, bid) => ({ site, bid });
// a game with chosen cove values, everything else default
function fixed(players, pots, extra = {}) {
  const g = newGame(players, 1);
  return { ...g, pots: pots.slice(), ...extra };
}

test("setup: players+1 coves holding 1..n gold, 10 oars, 0 gold", () => {
  for (const n of [2, 3, 4]) {
    const g = newGame(n, 42);
    assert.equal(g.pots.length, n + 1);
    assert.deepEqual(g.pots.slice().sort((a, b) => a - b), Array.from({ length: n + 1 }, (_, i) => i + 1));
    assert.deepEqual(g.oars, Array(n).fill(10));
    assert.deepEqual(g.gold, Array(n).fill(0));
    assert.equal(g.round, 1);
  }
  assert.throws(() => configFor(1));
  assert.throws(() => configFor(5));
});

test("alone: take the gold, keep the oars", () => {
  const g = fixed(2, [5, 3, 1]);
  const n = resolveRound(g, [mv(0, 4), mv(1, 0)]);
  assert.deepEqual(n.gold, [5, 3]);
  assert.deepEqual(n.oars, [10, 10]);
  assert.equal(n.pots[0], 1); // taken: restarts at 1
  assert.equal(n.pots[1], 1);
  assert.ok(n.pots[2] >= 2 && n.pots[2] <= 4, "untaken cove gains 1-3 with the tide");
});

test("meeting: most oars takes the gold and hands its oars to the captain it beat", () => {
  const g = fixed(2, [6, 2, 1]);
  const n = resolveRound(g, [mv(0, 4), mv(0, 3)]);
  assert.deepEqual(n.gold, [6, 0]);
  assert.deepEqual(n.oars, [6, 14]);
  const r = n.history[0].results[0];
  assert.equal(r.winner, 0);
  assert.equal(r.paid, 4);
  assert.equal(r.share, 4);
  assert.deepEqual(r.paidTo, [1]);
});

test("three-way meeting: oars split evenly, odd oars sink", () => {
  const g = fixed(3, [9, 1, 1, 1]);
  const n = resolveRound(g, [mv(0, 5), mv(0, 2), mv(0, 0)]);
  assert.deepEqual(n.gold, [9, 0, 0]);
  assert.deepEqual(n.oars, [5, 12, 12]);
  assert.equal(n.history[0].results[0].lost, 1);
  const total = n.oars.reduce((a, b) => a + b, 0);
  assert.equal(total, 29, "one oar sank");
});

test("a winning bid of 0 hands nothing over", () => {
  const g = { ...fixed(2, [4, 2, 1]), gold: [3, 7] };
  const n = resolveRound(g, [mv(0, 0), mv(0, 0)]);
  // tie at 0: the captain with less gold (seat 0) takes it
  assert.deepEqual(n.gold, [7, 7]);
  assert.deepEqual(n.oars, [10, 10]);
  assert.equal(n.history[0].results[0].tie, true);
});

test("tie: less gold wins; equal gold means nobody takes it and the cove grows", () => {
  let g = { ...fixed(2, [6, 2, 1]), gold: [5, 2] };
  let n = resolveRound(g, [mv(0, 3), mv(0, 3)]);
  assert.equal(n.history[0].results[0].winner, 1);
  assert.deepEqual(n.oars, [13, 7]);
  g = fixed(2, [6, 2, 1]);
  n = resolveRound(g, [mv(0, 3), mv(0, 3)]);
  assert.equal(n.history[0].results[0].winner, null);
  assert.deepEqual(n.oars, [10, 10]);
  assert.ok(n.pots[0] >= 7 && n.pots[0] <= 9);
});

test("last round pays double and ends the match", () => {
  let g = fixed(2, [4, 2, 1]);
  g = { ...g, round: 8 };
  assert.equal(payout(g, 0), 8);
  const n = resolveRound(g, [mv(0, 0), mv(1, 0)]);
  assert.deepEqual(n.gold, [8, 4]);
  assert.equal(n.over, true);
  assert.throws(() => resolveRound(n, [mv(0, 0), mv(1, 0)]));
});

test("bad moves are rejected with a reason", () => {
  const g = fixed(2, [4, 2, 1]);
  assert.equal(checkMove(g, 0, mv(3, 0)).ok, false);
  assert.equal(checkMove(g, 0, mv(-1, 0)).ok, false);
  assert.equal(checkMove(g, 0, mv(0, 11)).ok, false);
  assert.equal(checkMove(g, 0, mv(0, -1)).ok, false);
  assert.equal(checkMove(g, 0, mv(0, 1.5)).ok, false);
  assert.equal(checkMove(g, 0, { site: "0", bid: 1 }).ok, false);
  assert.equal(checkMove(g, 0, null).ok, false);
  assert.equal(checkMove(g, 0, [0, 1]).ok, false);
  assert.match(checkMove(g, 0, mv(0, 11)).error, /11 oars but have 10/);
  assert.throws(() => resolveRound(g, [mv(0, 0)]), /one move per seat/);
  assert.throws(() => resolveRound(g, [mv(0, 0), mv(9, 0)]), /seat 1/);
});

test("resolveRound does not mutate its input", () => {
  const g = newGame(4, 9);
  const snap = JSON.stringify(g);
  resolveRound(g, [mv(0, 1), mv(1, 2), mv(0, 3), mv(2, 0)]);
  assert.equal(JSON.stringify(g), snap);
});

test("same seed and moves give the same match (replays are exact)", () => {
  const play = () => {
    const r = rng(5);
    let g = newGame(4, 77);
    while (!g.over) g = resolveRound(g, [0, 1, 2, 3].map((s) => houseBot(g, s, r)));
    return JSON.stringify(g.history);
  };
  assert.equal(play(), play());
});

test("property: 3,000 random matches keep every invariant", () => {
  const r = rng(123);
  for (let m = 0; m < 3000; m++) {
    const n = 2 + (m % 3);
    let g = newGame(n, m);
    while (!g.over) {
      const moves = Array.from({ length: n }, (_, s) => POLICIES.random(g, s, r));
      const before = { gold: g.gold.reduce((a, b) => a + b, 0), oars: g.oars.reduce((a, b) => a + b, 0) };
      const next = resolveRound(g, moves);
      const h = next.history.at(-1);
      const taken = h.results.filter((x) => x.winner !== null).reduce((a, x) => a + x.value, 0);
      const sunk = h.results.reduce((a, x) => a + x.lost, 0);
      assert.equal(next.gold.reduce((a, b) => a + b, 0), before.gold + taken, "gold only comes from coves");
      assert.equal(next.oars.reduce((a, b) => a + b, 0), before.oars - sunk, "oars are only moved, or sunk as odd oars");
      assert.ok(next.oars.every((x) => x >= 0) && next.gold.every((x) => x >= 0));
      assert.ok(next.pots.every((x) => x >= 1));
      g = next;
    }
    const { winners, order } = standings(g);
    assert.ok(winners.length >= 1 && order.length === n);
  }
});

test("every bot policy always returns a legal move", () => {
  const r = rng(321);
  for (const [name, f] of Object.entries({ ...POLICIES, houseBot })) {
    for (let m = 0; m < (name === "reader" || name === "houseBot" || name === "house" ? 15 : 200); m++) {
      const n = 2 + (m % 3);
      let g = newGame(n, m + 1000);
      while (!g.over) {
        const moves = Array.from({ length: n }, (_, s) => f(g, s, r));
        moves.forEach((x, s) => assert.ok(checkMove(g, s, x).ok, `${name} made an illegal move ${JSON.stringify(x)}`));
        g = resolveRound(g, moves);
      }
    }
  }
});

test("resolveSite with nobody there is a no-op", () => {
  const o = resolveSite(configFor(2), 5, []);
  assert.equal(o.winner, null);
});
