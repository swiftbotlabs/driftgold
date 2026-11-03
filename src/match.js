// Durable Object: one instance per match. Holds seats, the engine state, the round timer (an alarm)
// and the house bots. Every request for a match code is routed here, so the match is single-threaded.
import { newGame, resolveRound, checkMove, standings, rng, RULES_VERSION } from "./engine.js";
import { houseBot } from "./bots.js";
import { stateView, logView } from "./view.js";

const LOBBY_TTL_MS = 30 * 60 * 1000; // an unstarted lobby expires after 30 min
const KEEP_FINISHED_MS = 3 * 24 * 3600 * 1000; // finished matches (and their logs) are kept 3 days
const BOT_NAMES = ["Marlin", "Gull", "Kelp", "Pike", "Wren", "Skerry"];
const MAX_REQ_PER_MIN = 900; // per match, all callers together

function err(status, code, message, extra = {}) {
  return { status, body: { error: { code, message }, ...extra } };
}
function ok(body, status = 200) {
  return { status, body };
}

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function cleanName(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  // keep letters, digits, spaces and a little punctuation; no control or bidi characters
  const s = raw.normalize("NFKC").replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return s.length ? s : fallback;
}

export class Match {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.m = null;
    this.rate = { t: 0, n: 0 };
    ctx.blockConcurrencyWhile(async () => {
      this.m = (await ctx.storage.get("m")) || null;
    });
  }

  async save() {
    this.m.version = (this.m.version || 0) + 1;
    await this.ctx.storage.put("m", this.m);
  }

  limited() {
    const now = Date.now();
    if (now - this.rate.t > 60000) this.rate = { t: now, n: 0 };
    this.rate.n++;
    return this.rate.n > MAX_REQ_PER_MIN;
  }

  async seatFor(token) {
    if (!this.m || typeof token !== "string" || token.length < 8 || token.length > 80) return -1;
    const h = await sha256(token);
    return this.m.seats.findIndex((s) => s && s.tokenHash === h);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.split("/").pop();
    let input = {};
    if (request.method === "POST") input = await request.json();
    if (this.limited()) return Response.json({ error: { code: "rate_limited", message: "too many requests for this match" } }, { status: 429 });
    let res;
    try {
      res = await this.handle(op, input, url);
    } catch (e) {
      res = err(500, "internal", "unexpected error");
      console.log("match error", String(e && e.stack ? e.stack : e).slice(0, 500));
    }
    return Response.json(res.body, { status: res.status });
  }

  async handle(op, input, url) {
    if (op === "init") return this.init(input);
    if (!this.m) return err(404, "no_match", "no match with that code");
    await this.tick();
    const token = input.token ?? url.searchParams.get("token") ?? null;
    if (op === "state") return ok(stateView(this.m, await this.seatFor(token), Date.now()));
    if (op === "log") return ok(logView(this.m));
    if (op === "join") return this.join(input);
    if (op === "start") return this.start(await this.seatFor(input.token));
    if (op === "move") return this.move(await this.seatFor(input.token), input);
    return err(404, "not_found", "unknown operation");
  }

  async init({ code, players, roundSeconds, seed }) {
    if (this.m) return err(409, "code_taken", "match code already exists");
    this.m = {
      code, players, roundSeconds, rulesVersion: RULES_VERSION,
      createdAt: Date.now(), phase: "lobby", seats: Array(players).fill(null), seed: seed >>> 0,
      game: null, pending: {}, auto: {}, roundEndsAt: null, finishedAt: null, version: 0,
    };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + LOBBY_TTL_MS);
    return ok({ code });
  }

  async join({ name, kind }) {
    // hash first: nothing below may await before the seat is claimed, or two joins could take one seat
    const token = newToken();
    const tokenHash = await sha256(token);
    const m = this.m;
    if (m.phase !== "lobby") return err(409, "not_joinable", `match is ${m.phase === "play" ? "already running" : m.phase}`);
    const seat = m.seats.findIndex((s) => s === null);
    if (seat < 0) return err(409, "full", "all seats are taken");
    const k = kind === "agent" ? "agent" : "human";
    m.seats[seat] = { name: cleanName(name, `Captain ${seat + 1}`), kind: k, tokenHash, joinedAt: Date.now() };
    if (m.seats.every((s) => s !== null)) this.begin();
    await this.save();
    if (m.phase === "play") await this.ctx.storage.setAlarm(m.roundEndsAt);
    return ok({ seat, token, state: stateView(m, seat, Date.now()) });
  }

  async start(seat) {
    const m = this.m;
    if (seat < 0) return err(403, "bad_token", "a seat token from this match is required");
    if (m.phase !== "lobby") return ok({ started: m.phase === "play" || m.phase === "over", state: stateView(m, seat, Date.now()) });
    this.begin();
    await this.save();
    await this.ctx.storage.setAlarm(m.roundEndsAt);
    return ok({ started: true, state: stateView(m, seat, Date.now()) });
  }

  // Fill empty seats with house bots and start round 1.
  begin() {
    const m = this.m;
    let b = 0;
    for (let i = 0; i < m.players; i++) {
      if (m.seats[i] === null) m.seats[i] = { name: `${BOT_NAMES[(m.seed + b++) % BOT_NAMES.length]} (bot)`, kind: "bot", tokenHash: null, joinedAt: Date.now() };
    }
    m.game = newGame(m.players, m.seed);
    m.phase = "play";
    m.startedAt = Date.now();
    this.openRound();
  }

  openRound() {
    const m = this.m;
    m.pending = {};
    m.roundEndsAt = Date.now() + m.roundSeconds * 1000;
    for (let s = 0; s < m.players; s++) if (m.seats[s].kind === "bot") m.pending[s] = this.botMove(s);
  }

  botMove(seat) {
    const g = this.m.game;
    const r = rng((this.m.seed ^ Math.imul(g.round, 7919) ^ Math.imul(seat + 1, 104729)) >>> 0);
    const botSeats = this.m.seats.map((x, i) => (x && x.kind === "bot" ? i : -1)).filter((i) => i >= 0);
    return houseBot(g, seat, r, { botSeats });
  }

  async move(seat, input) {
    const m = this.m;
    if (seat < 0) return err(403, "bad_token", "a seat token from this match is required");
    if (m.phase === "lobby") return err(409, "not_started", "the match has not started yet");
    if (m.phase !== "play") return err(409, "match_over", "the match is over", { state: stateView(m, seat, Date.now()) });
    const g = m.game;
    if (input.round !== undefined && input.round !== g.round) {
      if (Number.isInteger(input.round) && input.round < g.round)
        return err(409, "round_over", `round ${input.round} is already resolved; it is round ${g.round} now`, { state: stateView(m, seat, Date.now()) });
      return err(400, "bad_round", `it is round ${g.round}`);
    }
    const c = checkMove(g, seat, { site: input.cove, bid: input.oars });
    if (!c.ok) return err(400, "bad_move", c.error);
    const prev = m.pending[seat];
    const same = prev && prev.site === c.move.site && prev.bid === c.move.bid;
    m.pending[seat] = c.move;
    const round = g.round;
    let resolved = false;
    if (Object.keys(m.pending).length === m.players) {
      this.resolve();
      resolved = true;
    }
    await this.save();
    if (resolved && m.phase === "play") await this.ctx.storage.setAlarm(m.roundEndsAt);
    if (resolved && m.phase === "over") await this.ctx.storage.setAlarm(Date.now() + KEEP_FINISHED_MS);
    return ok({ accepted: true, duplicate: !!same, replaced: !!prev && !same, round, move: { cove: c.move.site, oars: c.move.bid }, resolved, state: stateView(m, seat, Date.now()) });
  }

  // Close the current round: seats that did not move get a house-bot move (marked auto).
  resolve() {
    const m = this.m;
    const g = m.game;
    const moves = [];
    const auto = [];
    for (let s = 0; s < m.players; s++) {
      if (m.pending[s]) moves.push(m.pending[s]);
      else {
        moves.push(this.botMove(s));
        auto.push(s);
      }
    }
    m.auto[g.round] = auto;
    m.game = resolveRound(g, moves);
    if (m.game.over) {
      m.phase = "over";
      m.finishedAt = Date.now();
      m.pending = {};
      m.roundEndsAt = null;
      m.final = standings(m.game);
    } else this.openRound();
  }

  // Catch up on a missed alarm (the alarm is the normal path; this keeps reads correct if it is late).
  async tick() {
    const m = this.m;
    let changed = false;
    while (m.phase === "play" && Date.now() >= m.roundEndsAt) {
      this.resolve();
      changed = true;
    }
    if (m.phase === "lobby" && Date.now() - m.createdAt > LOBBY_TTL_MS) {
      m.phase = "expired";
      changed = true;
    }
    if (changed) {
      await this.save();
      if (m.phase === "play") await this.ctx.storage.setAlarm(m.roundEndsAt);
      if (m.phase === "over") await this.ctx.storage.setAlarm(m.finishedAt + KEEP_FINISHED_MS);
    }
  }

  async alarm() {
    if (!this.m) return;
    const m = this.m;
    if ((m.phase === "over" && Date.now() >= m.finishedAt + KEEP_FINISHED_MS) || (m.phase === "expired" && Date.now() - m.createdAt > KEEP_FINISHED_MS)) {
      await this.ctx.storage.deleteAll();
      this.m = null;
      return;
    }
    await this.tick();
    if (m.phase === "play") await this.ctx.storage.setAlarm(m.roundEndsAt);
    else if (m.phase === "over") await this.ctx.storage.setAlarm(m.finishedAt + KEEP_FINISHED_MS + 1000);
    else if (m.phase === "expired") await this.ctx.storage.setAlarm(m.createdAt + KEEP_FINISHED_MS + 1000);
    else if (m.phase === "lobby") await this.ctx.storage.setAlarm(m.createdAt + LOBBY_TTL_MS + 1000);
  }
}

