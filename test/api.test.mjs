// End-to-end API tests against a running server (wrangler dev). usage:
//   BASE=http://127.0.0.1:8799 node --test test/api.test.mjs      (test/run_api.sh starts a fresh server)
// Set LONG=1 to also play a full match driven only by round timers (about 85 s).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { newGame, resolveRound } from "../src/engine.js";

const BASE = process.env.BASE || "http://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token, raw) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  const init = { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) };
  let r;
  try {
    r = await fetch(BASE + path, init);
  } catch {
    // a kept-alive socket may have been closed while a blocking step ran (spawnSync): retry once
    await sleep(300);
    r = await fetch(BASE + path, init);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

test("index, rules and OpenAPI are served as JSON", async () => {
  const a = await call("GET", "/api");
  assert.equal(a.status, 200);
  assert.equal(a.json.name, "Driftgold API");
  const r = await call("GET", "/api/rules");
  assert.equal(r.status, 200);
  assert.match(r.json.rules, /10 oars/);
  const o = await call("GET", "/api/openapi.json");
  assert.equal(o.status, 200);
  assert.equal(o.json.openapi, "3.1.0");
  assert.ok(o.json.paths["/api/match/{code}/move"]);
  assert.equal(a.headers.get("access-control-allow-origin"), "*");
});

test("front end is served", async () => {
  const r = await call("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Driftgold<\/title>/);
  const js = await call("GET", "/app.js");
  assert.equal(js.status, 200);
});

test("full match: two agents and two house bots, through the HTTP API only", async () => {
  const c = await call("POST", "/api/match", { players: 4 });
  assert.equal(c.status, 201);
  const code = c.json.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  const a = await call("POST", `/api/match/${code}/join`, { name: "Alpha", kind: "agent" });
  const b = await call("POST", `/api/match/${code}/join`, { name: "Bravo<script>", kind: "agent" });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.json.state.captains[1].name, "Bravoscript", "names are cleaned");
  // moving before the start is refused
  const early = await call("POST", `/api/match/${code}/move`, { cove: 0, oars: 0 }, a.json.token);
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, "not_started");
  const s = await call("POST", `/api/match/${code}/start`, {}, a.json.token);
  assert.equal(s.status, 200);
  assert.equal(s.json.state.phase, "play");
  assert.deepEqual(s.json.state.captains.map((x) => x.kind), ["agent", "agent", "bot", "bot"]);
  const t0 = Date.now();
  const agents = [a.json, b.json];
  for (let guard = 0; guard < 40; guard++) {
    const st = (await call("GET", `/api/match/${code}`, undefined, agents[0].token)).json;
    if (st.phase === "over") break;
    for (const ag of agents) {
      const me = (await call("GET", `/api/match/${code}`, undefined, ag.token)).json;
      if (me.phase !== "play" || me.you.moved) continue;
      const best = me.coves.reduce((x, y) => (y.payout > x.payout ? y : x));
      const r = await call("POST", `/api/match/${code}/move`, { round: me.round, cove: best.cove, oars: Math.min(me.you.oars, 2) }, ag.token);
      assert.ok(r.status === 200 || (r.status === 409 && r.json.error.code === "round_over"), JSON.stringify(r.json));
    }
  }
  const fin = (await call("GET", `/api/match/${code}`)).json;
  assert.equal(fin.phase, "over");
  assert.ok(Array.isArray(fin.winners) && fin.winners.length >= 1);
  assert.ok(Date.now() - t0 < 60000, "a match with prompt movers finishes in well under 10 minutes");
  // the log replays exactly through the rules engine
  const log = (await call("GET", `/api/match/${code}/log`)).json;
  assert.equal(log.rounds.length, 8);
  let g = newGame(4, 0);
  g = { ...g, pots: log.rounds[0].coves.map((x) => x.gold) };
  for (const rd of log.rounds) {
    assert.deepEqual(rd.coves.map((x) => x.gold), g.pots, `round ${rd.round} coves`);
    const before = g;
    g = resolveRound({ ...g, seed: undefined }, rd.moves.map((m) => ({ site: m.cove, bid: m.oars })));
    // the tide is seeded server-side; take it from the log for the untaken coves
    g.pots = g.pots.map((p, i) => (rd.results[i].winner === null ? before.pots[i] + rd.tide[i] : p));
    assert.deepEqual(rd.goldAfter, g.gold, `round ${rd.round} gold`);
    assert.deepEqual(rd.oarsAfter, g.oars, `round ${rd.round} oars`);
  }
  assert.deepEqual(log.final.gold, g.gold);
  // after the end, moves are refused
  const late = await call("POST", `/api/match/${code}/move`, { cove: 0, oars: 0 }, agents[0].token);
  assert.equal(late.status, 409);
  assert.equal(late.json.error.code, "match_over");
});

test("moves are idempotent, can be changed until the round closes, and stale rounds are refused", async () => {
  const c = await call("POST", "/api/match", { players: 3, name: "Idem", kind: "agent" });
  const code = c.json.code, tok = c.json.token;
  const j2 = await call("POST", `/api/match/${code}/join`, { name: "Second" });
  await call("POST", `/api/match/${code}/start`, {}, tok);
  const m1 = await call("POST", `/api/match/${code}/move`, { round: 1, cove: 1, oars: 3 }, tok);
  assert.equal(m1.status, 200);
  assert.equal(m1.json.duplicate, false);
  assert.equal(m1.json.resolved, false, "the other human has not moved");
  const m2 = await call("POST", `/api/match/${code}/move`, { round: 1, cove: 1, oars: 3 }, tok);
  assert.equal(m2.json.duplicate, true);
  const m3 = await call("POST", `/api/match/${code}/move`, { round: 1, cove: 2, oars: 1 }, tok);
  assert.equal(m3.json.replaced, true);
  // sealed: the other player cannot see my pending move
  const other = (await call("GET", `/api/match/${code}`, undefined, j2.json.token)).json;
  assert.equal(other.you.move, null);
  assert.equal(other.captains[0].moved, true);
  assert.ok(!JSON.stringify(other).includes('"oars":1,"auto"'));
  const fin = await call("POST", `/api/match/${code}/move`, { round: 1, cove: 0, oars: 0 }, j2.json.token);
  assert.equal(fin.json.resolved, true);
  assert.equal(fin.json.state.round, 2);
  assert.equal(fin.json.state.previous.moves[0].cove, 2, "the replaced move counted");
  const stale = await call("POST", `/api/match/${code}/move`, { round: 1, cove: 0, oars: 0 }, tok);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "round_over");
  const future = await call("POST", `/api/match/${code}/move`, { round: 5, cove: 0, oars: 0 }, tok);
  assert.equal(future.status, 400);
});

test("bad input gets clear errors", async () => {
  const c = await call("POST", "/api/match", { players: 2, name: "Err", start: true });
  const code = c.json.code, tok = c.json.token;
  const cases = [
    [await call("POST", "/api/match", undefined, null, "{not json"), 400, "bad_json"],
    [await call("POST", "/api/match", undefined, null, "[1,2]"), 400, "bad_json"],
    [await call("POST", "/api/match", undefined, null, JSON.stringify({ name: "x".repeat(5000) })), 413, "too_large"],
    [await call("POST", "/api/match", { players: 5 }), 400, "bad_players"],
    [await call("POST", "/api/match", { players: "4" }), 400, "bad_players"],
    [await call("POST", "/api/match", { roundSeconds: 5 }), 400, "bad_timer"],
    [await call("GET", "/api/match/ZZZZZ"), 404, "no_match"],
    [await call("GET", "/api/match/../../etc"), 404, null],
    [await call("GET", "/api/match/abc"), 404, "no_match"],
    [await call("GET", "/api/nope"), 404, "not_found"],
    [await call("GET", `/api/match/${code}/constructor`), 404, "not_found"],
    [await call("POST", `/api/match/${code}/init`, { code, players: 2 }), 404, "not_found"],
    [await call("GET", `/api/match/${code}/move`), 405, "method"],
    [await call("POST", `/api/match/${code}/move`, { cove: 0, oars: 1 }, "wrongtoken123"), 403, "bad_token"],
    [await call("POST", `/api/match/${code}/move`, { cove: 0, oars: 1 }), 403, "bad_token"],
    [await call("POST", `/api/match/${code}/move`, { cove: 7, oars: 1 }, tok), 400, "bad_move"],
    [await call("POST", `/api/match/${code}/move`, { cove: 0, oars: 99 }, tok), 400, "bad_move"],
    [await call("POST", `/api/match/${code}/move`, { cove: 0, oars: -1 }, tok), 400, "bad_move"],
    [await call("POST", `/api/match/${code}/move`, { cove: "0", oars: 1 }, tok), 400, "bad_move"],
    [await call("POST", `/api/match/${code}/join`, { name: "Late" }), 409, "not_joinable"],
    [await call("POST", `/api/match/${code}/start`, {}, "nottheright1"), 403, "bad_token"],
    [await call("GET", `/api/match/${code}?token=${tok}`), 400, "token_in_url"],
  ];
  for (const [r, status, code2] of cases) {
    assert.equal(r.status, status, `${status} ${code2}: got ${r.status} ${r.text.slice(0, 120)}`);
    if (code2) assert.equal(r.json.error.code, code2);
  }
  // the token also works in a POST body
  const st0 = (await call("GET", `/api/match/${code}`, undefined, tok)).json;
  const bodyTok = await call("POST", `/api/match/${code}/move`, { round: st0.round, cove: 0, oars: 0, token: tok });
  assert.equal(bodyTok.status, 200, bodyTok.text);
  // lowercase codes work
  const lc = await call("GET", `/api/match/${code.toLowerCase()}`);
  assert.equal(lc.status, 200);
  // a full table refuses more joins and starts by itself
  const t = await call("POST", "/api/match", { players: 2, name: "One" });
  const j = await call("POST", `/api/match/${t.json.code}/join`, { name: "Two" });
  assert.equal(j.json.state.phase, "play", "full table starts by itself");
  const j3 = await call("POST", `/api/match/${t.json.code}/join`, { name: "Three" });
  assert.equal(j3.status, 409);
});

test("an idle seat is played by the house bot when the timer runs out", async () => {
  const c = await call("POST", "/api/match", { players: 2, roundSeconds: 10, name: "Idle", kind: "agent", start: true });
  assert.equal(c.status, 201);
  const code = c.json.code;
  assert.ok(c.json.state.secondsLeft <= 10 && c.json.state.secondsLeft >= 9);
  await sleep(11500);
  const st = (await call("GET", `/api/match/${code}`, undefined, c.json.token)).json;
  assert.equal(st.round, 2, "round 1 closed on its timer");
  assert.equal(st.previous.moves[0].auto, true, "my missed move was played for me");
  assert.equal(st.previous.moves[1].auto, false, "the bot seat moved normally");
});

test("sample bot plays a whole match", { timeout: 120000 }, () => {
  const r = spawnSync("python3", ["bot/sample_bot.py", "--create", "3", "--base", BASE, "--name", "Sample"], { encoding: "utf8", timeout: 110000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /round 8:/);
  assert.match(r.stdout, /winner:/);
});

test("Node sample bot plays a whole match", { timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, ["bot/sample_bot.mjs", "--create", "2", "--base", BASE], { encoding: "utf8", timeout: 110000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /round 8:/);
  assert.match(r.stdout, /winner:/);
});

test("a match where nobody moves for two rounds is ended and deleted", { timeout: 60000 }, async () => {
  const c = await call("POST", "/api/match", { players: 2, roundSeconds: 10, name: "Gone", start: true });
  const code = c.json.code;
  await sleep(11500);
  assert.equal((await call("GET", `/api/match/${code}`)).status, 200, "one idle round is fine");
  await sleep(10500);
  const r = await call("GET", `/api/match/${code}`);
  assert.equal(r.status, 404, r.text); // deleted by its alarm (or on this read, whichever came first)
  assert.equal(r.json.error.code, "no_match");
});

test("round timers drive a full match to the end (human moves every other round)", { skip: !process.env.LONG, timeout: 200000 }, async () => {
  const c = await call("POST", "/api/match", { players: 4, roundSeconds: 10, name: "Half", start: true });
  const code = c.json.code, tok = c.json.token;
  const t0 = Date.now();
  let st;
  do {
    st = (await call("GET", `/api/match/${code}`, undefined, tok)).json;
    if (st.phase === "play" && st.round % 2 === 1 && !st.you.moved) await call("POST", `/api/match/${code}/move`, { round: st.round, cove: 0, oars: 0 }, tok);
    await sleep(2000);
  } while (st.phase === "play" && Date.now() - t0 < 150000);
  assert.equal(st.phase, "over");
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs < 8 * 10 + 15, `took ${secs}s`);
  const log = (await call("GET", `/api/match/${code}/log`)).json;
  assert.equal(log.rounds.length, 8);
  assert.ok(log.rounds.filter((r) => r.moves[0].auto).length === 4, "even rounds were auto-played");
});
