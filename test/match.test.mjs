// Match object tests (lifecycle, budgets, names) with an in-memory storage: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { Match, cleanName } from "../src/match.js";
import { newObject, call } from "./fake_do.mjs";

const realNow = Date.now;
function clockAt(t) { Date.now = () => t; }
test.afterEach(() => { Date.now = realNow; });

test("create + join + start is one save and one alarm", async () => {
  const { obj, storage } = await newObject(Match);
  const r = await call(obj, "create", { code: "AAAAA", players: 4, roundSeconds: 40, join: true, start: true, name: "Ana", kind: "human" });
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^[0-9a-f]{36}$/);
  assert.equal(r.json.state.phase, "play");
  assert.equal(storage.puts, 1);
  assert.equal(storage.alarmSets, 1);
  assert.equal(storage.alarm, r.json.state.roundEndsAt);
  const again = await call(obj, "create", { code: "AAAAA", players: 2, roundSeconds: 40 });
  assert.equal(again.status, 409);
});

test("bot names come from fresh randomness, not from anything public", async () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const { obj } = await newObject(Match);
    const r = await call(obj, "create", { code: "BBBBB", players: 4, roundSeconds: 40, join: true, start: true, name: "x" });
    seen.add(r.json.state.captains.slice(1).map((c) => c.name).join(","));
  }
  assert.ok(seen.size > 10, `only ${seen.size} different bot line-ups in 30 matches`);
});

test("an unstarted lobby is deleted when it expires", async () => {
  const t0 = realNow();
  clockAt(t0);
  const { obj, storage } = await newObject(Match);
  await call(obj, "create", { code: "CCCCC", players: 3, roundSeconds: 40 });
  assert.equal((await call(obj, "state")).status, 200);
  clockAt(t0 + 31 * 60 * 1000);
  const r = await call(obj, "state");
  assert.equal(r.status, 404);
  assert.equal(storage.data.size, 0, "storage wiped");
  assert.equal(storage.alarm, null);
});

test("two rounds with no human or agent move end the match and delete it", async () => {
  const t0 = realNow();
  clockAt(t0);
  const { obj, storage } = await newObject(Match);
  const c = await call(obj, "create", { code: "DDDDD", players: 2, roundSeconds: 10, join: true, start: true, name: "Away" });
  clockAt(t0 + 10500);
  const r1 = await call(obj, "state", undefined, { token: c.json.token });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.round, 2, "one idle round is fine");
  assert.equal(r1.json.previous.moves[0].auto, true);
  clockAt(t0 + 21000);
  await obj.alarm();
  assert.equal(storage.data.size, 0, "deleted after the second idle round");
  assert.equal((await call(obj, "state")).status, 404);
});

test("moving every other round keeps a match alive to the end", async () => {
  let t = realNow();
  clockAt(t);
  const { obj } = await newObject(Match);
  const c = await call(obj, "create", { code: "EEEEE", players: 2, roundSeconds: 10, join: true, start: true, name: "Half" });
  for (let round = 1; round <= 8; round++) {
    if (round % 2) {
      const m = await call(obj, "move", { round, cove: 0, oars: 0 }, { token: c.json.token });
      assert.equal(m.status, 200, JSON.stringify(m.json));
    } else {
      t += 10500;
      clockAt(t);
      await obj.alarm();
    }
  }
  const s = await call(obj, "state");
  assert.equal(s.status, 200);
  assert.equal(s.json.phase, "over");
});

test("anonymous callers cannot spend a seated captain's budget", async () => {
  const { obj } = await newObject(Match);
  const c = await call(obj, "create", { code: "FFFFF", players: 2, roundSeconds: 40, join: true, start: true, name: "Seated" });
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await call(obj, "state", undefined, { client: "flooder" })).status === 429) limited++;
  assert.ok(limited >= 9, "the flooding client is limited");
  assert.equal((await call(obj, "state", undefined, { token: c.json.token, client: "flooder" })).status, 200, "the seat still gets through");
  assert.equal((await call(obj, "state", undefined, { client: "someone-else" })).status, 200, "other clients still get through");
  const mv = await call(obj, "move", { round: 1, cove: 0, oars: 1 }, { token: c.json.token, client: "flooder" });
  assert.equal(mv.status, 200);
});

test("names: no broken surrogate pairs, no dots, no control or bidi characters", () => {
  const n = cleanName("AAAAAAAAAAAAAAA\u{20000}", "x");
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(n), false);
  assert.equal([...n].length <= 16, true);
  assert.equal(cleanName("free-gold.example", "x").includes("."), false);
  assert.equal(cleanName("a‮b​c\u0007d", "x"), "abcd");
  assert.equal(cleanName("   ", "Captain 2"), "Captain 2");
  assert.equal(cleanName(42, "Captain 3"), "Captain 3");
});
