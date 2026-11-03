// Driftgold Worker: JSON API under /api, static front end from ./public, one Durable Object per match.
import { Match } from "./match.js";
import { RULES, OPENAPI } from "./docs.js";
import { configFor, RULES_VERSION } from "./engine.js";

export { Match };

const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_BODY = 2048;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};
const SEC = { "x-content-type-options": "nosniff", "cache-control": "no-store" };

// Best-effort per-isolate limiter (Cloudflare runs many isolates; the match object has its own cap too).
const buckets = new Map();
function rateLimited(ip, kind, limit) {
  const now = Date.now();
  const key = kind + ":" + ip;
  let b = buckets.get(key);
  if (!b || now - b.t > 60000) b = { t: now, n: 0 };
  b.n++;
  buckets.set(key, b);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.t > 60000) buckets.delete(k);
  return b.n > limit;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...SEC } });
}
function fail(status, code, message) {
  return json({ error: { code, message } }, status);
}

async function readBody(request) {
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > MAX_BODY) throw new HttpError(413, "too_large", `body over ${MAX_BODY} bytes`);
  // read at most MAX_BODY bytes even when no length is declared (chunked uploads)
  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel();
        throw new HttpError(413, "too_large", `body over ${MAX_BODY} bytes`);
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw new HttpError(400, "bad_json", "body must be UTF-8 JSON");
    }
  }
  if (!text.trim()) return {};
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "body must be JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "bad_json", "body must be a JSON object");
  return v;
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+([A-Za-z0-9]{8,80})$/.exec(h.trim());
  return m ? m[1] : null;
}

function randomCode() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

async function callMatch(env, code, op, payload, query = "") {
  const stub = env.MATCH.get(env.MATCH.idFromName(code));
  const init = payload === undefined ? { method: "GET" } : { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
  const r = await stub.fetch(`https://match/${op}${query}`, init);
  return { status: r.status, body: await r.json() };
}

async function api(request, env, url) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api", ...]
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const method = request.method;
  if (rateLimited(ip, "api", 600)) return fail(429, "rate_limited", "slow down: max 600 API calls per minute");

  if (parts.length === 1 && method === "GET")
    return json({ name: "Driftgold API", rulesVersion: RULES_VERSION, docs: "/api/openapi.json", rules: "/api/rules",
      endpoints: ["POST /api/match", "GET /api/match/{code}", "POST /api/match/{code}/join", "POST /api/match/{code}/start",
        "POST /api/match/{code}/move", "GET /api/match/{code}/log"] });
  if (parts[1] === "rules" && parts.length === 2 && method === "GET") return json(RULES);
  if (parts[1] === "openapi.json" && parts.length === 2 && method === "GET") return json(OPENAPI);
  if (parts[1] !== "match") return fail(404, "not_found", "unknown endpoint; see /api");

  if (parts.length === 2) {
    if (method !== "POST") return fail(405, "method", "use POST to create a match");
    if (rateLimited(ip, "create", 20)) return fail(429, "rate_limited", "max 20 new matches per minute");
    const body = await readBody(request);
    const players = body.players === undefined ? 4 : body.players;
    if (!Number.isInteger(players) || players < 2 || players > 4) return fail(400, "bad_players", "players must be 2, 3 or 4");
    const roundSeconds = body.roundSeconds === undefined ? 40 : body.roundSeconds;
    if (!Number.isInteger(roundSeconds) || roundSeconds < 10 || roundSeconds > 120) return fail(400, "bad_timer", "roundSeconds must be an integer 10-120");
    configFor(players);
    let code = null;
    for (let i = 0; i < 6 && !code; i++) {
      const c = randomCode();
      const seedArr = new Uint32Array(1);
      crypto.getRandomValues(seedArr);
      const r = await callMatch(env, c, "init", { code: c, players, roundSeconds, seed: seedArr[0] });
      if (r.status === 200) code = c;
    }
    if (!code) return fail(503, "busy", "could not allocate a match code, try again");
    const out = { code, players, roundSeconds, url: `${url.origin}/?m=${code}` };
    if (body.join !== false && (body.name !== undefined || body.join === true)) {
      const j = await callMatch(env, code, "join", { name: body.name, kind: body.kind });
      if (j.status !== 200) return json(j.body, j.status);
      Object.assign(out, { seat: j.body.seat, token: j.body.token, state: j.body.state });
      if (body.start === true) {
        const s = await callMatch(env, code, "start", { token: j.body.token });
        out.state = s.body.state;
      }
    }
    return json(out, 201);
  }

  const code = (parts[2] || "").toUpperCase();
  if (!CODE_RE.test(code)) return fail(404, "no_match", "match codes are 5 characters, letters and digits 2-9");
  const op = parts[3] || "state";
  if (parts.length > 4) return fail(404, "not_found", "unknown endpoint");
  const routes = { state: "GET", log: "GET", join: "POST", start: "POST", move: "POST" };
  if (!routes[op]) return fail(404, "not_found", "unknown endpoint");
  if (routes[op] !== method) return fail(405, "method", `use ${routes[op]} for ${op}`);
  if (method === "GET") {
    const token = bearer(request) || url.searchParams.get("token");
    const q = token && /^[A-Za-z0-9]{8,80}$/.test(token) ? `?token=${token}` : "";
    const r = await callMatch(env, code, op, undefined, q);
    return json(r.body, r.status);
  }
  const body = await readBody(request);
  const payload = { token: bearer(request) || (typeof body.token === "string" ? body.token : null) };
  if (op === "join") Object.assign(payload, { name: body.name, kind: body.kind });
  if (op === "move") Object.assign(payload, { cove: body.cove, oars: body.oars !== undefined ? body.oars : body.bid, round: body.round });
  const r = await callMatch(env, code, op, payload);
  return json(r.body, r.status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      try {
        return await api(request, env, url);
      } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.code, e.message);
        console.log("api error", String(e && e.stack ? e.stack : e).slice(0, 500));
        return fail(500, "internal", "unexpected error");
      }
    }
    return env.ASSETS.fetch(request);
  },
};
