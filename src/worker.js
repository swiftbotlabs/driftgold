// Driftgold Worker: JSON API under /api, static front end from ./public, one Durable Object per match.
import { Match } from "./match.js";
import { RULES, OPENAPI } from "./docs.js";
import { configFor, RULES_VERSION } from "./engine.js";
import { ipBucket } from "./ip.js";

export { Match };

const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_RE = /^[0-9a-f]{36}$/;
const MAX_BODY = 2048;
const API_PER_MIN = 120; // per client address bucket (IPv4 address or IPv6 /64), all API calls
const CREATE_PER_MIN = 5; // new matches per client address bucket
const CACHE_MS = { state: 1000, log: 2000 }; // token-less reads are shared for this long per isolate
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};
const SEC = { "x-content-type-options": "nosniff", "cache-control": "no-store" };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...SEC, ...extra } });
}
function fail(status, code, message, extra) {
  return json({ error: { code, message } }, status, extra);
}

async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// rate-limit keys are hashed, so no address is handed to the limiter or the match object in clear
const clientKey = async (request) => (await sha256hex("driftgold-ip:" + ipBucket(request.headers.get("cf-connecting-ip")))).slice(0, 32);

// Cloudflare rate-limiting binding when deployed; a per-isolate counter in local dev and tests.
const memLimits = new Map();
async function limited(env, binding, key, limit) {
  const rl = env[binding];
  if (rl && typeof rl.limit === "function") {
    try {
      const { success } = await rl.limit({ key });
      return !success;
    } catch {
      /* fall through to the local counter */
    }
  }
  const now = Date.now();
  const k = binding + ":" + key;
  const e = memLimits.get(k);
  if (!e || e.reset < now) {
    if (memLimits.size > 5000) memLimits.clear();
    memLimits.set(k, { n: 1, reset: now + 60000 });
    return false;
  }
  e.n++;
  return e.n > limit;
}

// Short shared cache for reads without a token (spectators, replays): many viewers, one object call.
const readCache = new Map();
function cached(key) {
  const e = readCache.get(key);
  if (e && e.exp > Date.now()) return e;
  if (e) readCache.delete(key);
  return null;
}
function remember(key, status, body, ms) {
  if (readCache.size > 500) readCache.clear();
  readCache.set(key, { status, body, exp: Date.now() + ms });
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

function bearer(request) {
  const m = /^Bearer\s+(\S{1,100})$/.exec((request.headers.get("authorization") || "").trim());
  return m ? m[1] : null;
}

function randomCode() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

// The seat token and the client key travel to the match object in headers, never in its URL.
async function callMatch(env, code, op, payload, token, ckey) {
  const stub = env.MATCH.get(env.MATCH.idFromName(code));
  const headers = { "x-client-key": ckey };
  if (token && TOKEN_RE.test(token)) headers["x-seat-token"] = token;
  const init = payload === undefined ? { method: "GET", headers } : { method: "POST", body: JSON.stringify(payload), headers: { ...headers, "content-type": "application/json" } };
  const r = await stub.fetch(`https://match/${op}`, init);
  return { status: r.status, body: await r.json() };
}

async function api(request, env, url) {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api", ...]
  const method = request.method;
  const ckey = await clientKey(request);
  if (await limited(env, "RL_API", ckey, Number(env.API_PER_MIN) || API_PER_MIN)) return fail(429, "rate_limited", `slow down: at most ${API_PER_MIN} API calls a minute per network`, { "retry-after": "60" });
  if (url.searchParams.has("token")) return fail(400, "token_in_url", "send the seat token as Authorization: Bearer <token>, not in the URL");

  if (parts.length === 1 && method === "GET")
    return json({ name: "Driftgold API", rulesVersion: RULES_VERSION, docs: "/api/openapi.json", rules: "/api/rules",
      endpoints: ["POST /api/match", "GET /api/match/{code}", "POST /api/match/{code}/join", "POST /api/match/{code}/start",
        "POST /api/match/{code}/move", "GET /api/match/{code}/log"] });
  if (parts[1] === "rules" && parts.length === 2 && method === "GET") return json(RULES);
  if (parts[1] === "openapi.json" && parts.length === 2 && method === "GET") return json(OPENAPI);
  if (parts[1] !== "match") return fail(404, "not_found", "unknown endpoint; see /api");

  if (parts.length === 2) {
    if (method !== "POST") return fail(405, "method", "use POST to create a match");
    if (await limited(env, "RL_CREATE", ckey, Number(env.CREATE_PER_MIN) || CREATE_PER_MIN)) return fail(429, "rate_limited", `at most ${CREATE_PER_MIN} new matches a minute per network`, { "retry-after": "60" });
    const body = await readBody(request);
    const players = body.players === undefined ? 4 : body.players;
    if (!Number.isInteger(players) || players < 2 || players > 4) return fail(400, "bad_players", "players must be 2, 3 or 4");
    const roundSeconds = body.roundSeconds === undefined ? 40 : body.roundSeconds;
    if (!Number.isInteger(roundSeconds) || roundSeconds < 10 || roundSeconds > 120) return fail(400, "bad_timer", "roundSeconds must be an integer 10-120");
    configFor(players);
    const join = body.join !== false && (body.name !== undefined || body.join === true);
    const payload = { players, roundSeconds, join, start: join && body.start === true, name: body.name, kind: body.kind };
    for (let i = 0; i < 6; i++) {
      const code = randomCode();
      const r = await callMatch(env, code, "create", { ...payload, code }, null, ckey);
      if (r.status === 409) continue;
      if (r.status !== 200) return json(r.body, r.status);
      return json({ code, players, roundSeconds, url: `${url.origin}/?m=${code}`, ...r.body }, 201);
    }
    return fail(503, "busy", "could not allocate a match code, try again");
  }

  const code = (parts[2] || "").toUpperCase();
  if (!CODE_RE.test(code)) return fail(404, "no_match", "match codes are 5 characters, letters and digits 2-9");
  const op = parts[3] || "state";
  if (parts.length > 4) return fail(404, "not_found", "unknown endpoint");
  const routes = { state: "GET", log: "GET", join: "POST", start: "POST", move: "POST" };
  if (!Object.hasOwn(routes, op)) return fail(404, "not_found", "unknown endpoint");
  if (routes[op] !== method) return fail(405, "method", `use ${routes[op]} for ${op}`);
  if (method === "GET") {
    const token = bearer(request);
    const key = `${code}:${op}`;
    if (!token) {
      const hit = cached(key);
      if (hit) return json(hit.body, hit.status);
    }
    const r = await callMatch(env, code, op, undefined, token, ckey);
    if (!token && r.status === 200) remember(key, r.status, r.body, CACHE_MS[op]);
    return json(r.body, r.status);
  }
  const body = await readBody(request);
  const token = bearer(request) || (typeof body.token === "string" ? body.token : null);
  let payload = {};
  if (op === "join") payload = { name: body.name, kind: body.kind };
  if (op === "move") payload = { cove: body.cove, oars: body.oars !== undefined ? body.oars : body.bid, round: body.round };
  const r = await callMatch(env, code, op, payload, token, ckey);
  readCache.delete(`${code}:state`);
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
