#!/usr/bin/env node
// Driftgold sample bot for Node 18+ (no dependencies). Same strategy as sample_bot.py.
//   node bot/sample_bot.mjs --create 4 [--base URL] [--name NAME]
//   node bot/sample_bot.mjs --code K7QPX [--base URL]
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const BASE = (args.base || "https://driftgold.swiftbotlab.workers.dev").replace(/\/+$/, "");
{
  const u = new URL(BASE);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) { console.log("refusing a non-https server (http is only allowed for localhost)"); process.exit(2); }
}
const NAME = args.name || "SampleBotJS";

async function call(method, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // redirect: "error" so a redirect can never carry the seat token to another host
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "error" });
  let json;
  try { json = await r.json(); } catch { json = { error: { code: "not_json", message: `HTTP ${r.status} with a non-JSON body` } }; }
  return { status: r.status, json };
}

// Richest cove; row just over half its gold when we hold more oars than any rival, else nothing.
// Final round: row everything (oars are worth nothing afterwards).
function choose(s) {
  const best = s.coves.reduce((a, c) => (c.payout > a.payout ? c : a));
  const rivalOars = Math.max(...s.captains.filter((c) => c.seat !== s.you.seat).map((c) => c.oars));
  const oars = s.finalRound ? s.you.oars : s.you.oars > rivalOars ? Math.min(s.you.oars, Math.floor(best.payout / 2) + 1) : 0;
  return { cove: best.cove, oars };
}

let code, token;
if (args.create) {
  const r = await call("POST", "/api/match", { players: Number(args.create), name: NAME, kind: "agent", start: true });
  if (r.status !== 201) throw new Error(JSON.stringify(r.json));
  ({ code, token } = r.json);
  console.log(`created ${code}: ${BASE}/?m=${code}`);
} else if (args.code) {
  code = args.code.toUpperCase();
  const r = await call("POST", `/api/match/${code}/join`, { name: NAME, kind: "agent" });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  token = r.json.token;
  console.log(`joined ${code} as seat ${r.json.seat}`);
} else {
  console.log("give --code CODE or --create N");
  process.exit(2);
}

let lastRound = 0;
for (;;) {
  const { status, json: s } = await call("GET", `/api/match/${code}`, undefined, token);
  if (status !== 200) { await new Promise((r) => setTimeout(r, 2000)); continue; }
  if (s.phase === "over") {
    console.log("final gold:", Object.fromEntries(s.captains.map((c) => [c.name, c.gold])));
    console.log("winner:", s.winners.map((w) => s.captains[w].name).join(", "));
    break;
  }
  if (s.phase === "expired") { console.log("match expired"); process.exit(1); }
  if (s.phase === "play" && !s.you.moved && s.round !== lastRound) {
    const move = choose(s);
    const r = await call("POST", `/api/match/${code}/move`, { round: s.round, ...move }, token);
    if (r.status === 200) { lastRound = s.round; console.log(`round ${s.round}: cove ${move.cove}, ${move.oars} oars`); }
    else if (r.json.error?.code !== "round_over") console.log("move rejected:", r.json);
  }
  await new Promise((r) => setTimeout(r, 700));
}
