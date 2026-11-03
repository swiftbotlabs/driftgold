// Durable Object: one instance per match. Holds seats, the engine state, the round timer (an alarm)
// and the house bots. Every request for a match code is routed here, so the match is single-threaded.
//
// Randomness: the match seed is drawn here and used once, for the round-1 cove layout. Every bot move,
// every round's tide and the bot names use fresh crypto randomness, so public data (the layout, the log)
// says nothing about sealed moves or future tides.
import { newGame, resolveRound, checkMove, standings, rng, RULES_VERSION } from "./engine.js";
import { houseBot } from "./bots.js";
import { stateView, logView } from "./view.js";

const LOBBY_TTL_MS = 30 * 60 * 1000; // an unstarted lobby is deleted after 30 min
const KEEP_FINISHED_MS = 3 * 24 * 3600 * 1000; // finished matches (and their logs) are kept 3 days
const IDLE_ROUNDS_TO_END = 2; // two rounds in a row where no human or agent moved: the match is deleted
const BOT_NAMES = ["Marlin", "Gull", "Kelp", "Pike", "Wren", "Skerry"];
const SEAT_REQ_PER_MIN = 120; // per seated token
const ANON_REQ_PER_MIN = 60; // per client (address bucket) without a token
const TOKEN_RE = /^[0-9a-f]{36}$/;

function err(status, code, message, extra = {}) {
  return { status, body: { error: { code, message }, ...extra } };
}
function ok(body, status = 200) {
  return { status, body };
}

export function randomU32() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
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

// Names are untrusted text: keep letters, digits, spaces and _ ' - only (no control, bidi or format
// characters, no dots so a name cannot pass for a link), at most 16 characters, never a broken pair.
export function cleanName(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const s = raw.slice(0, 200).normalize("NFKC").replace(/[^\p{L}\p{N} _'-]/gu, "").replace(/\s+/g, " ").trim();
  const cut = [...s].slice(0, 16).join("").toWellFormed().trim();
  return cut.length ? cut : fallback;
}

export class Match {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.m = null;
    this.budget = new Map(); // "s<seat>" or "k<client key>" -> {t, n}
    ctx.blockConcurrencyWhile(async () => {
      this.m = (await ctx.storage.get("m")) || null;
    });
  }

  async save() {
    this.m.version = (this.m.version || 0) + 1;
    await this.ctx.storage.put("m", this.m);
  }

  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.m = null;
  }

  overBudget(key, limit) {
    const now = Date.now();
    let b = this.budget.get(key);
    if (!b || now - b.t > 60000) {
      b = { t: now, n: 0 };
      if (this.budget.size > 2000) this.budget.clear();
      this.budget.set(key, b);
    }
    b.n++;
    return b.n > limit;
  }

  async seatFor(token) {
    if (!this.m || typeof token !== "string" || !TOKEN_RE.test(token)) return -1;
    const h = await sha256(token);
    return this.m.seats.findIndex((s) => s && s.tokenHash === h);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.split("/").pop();
    let input = {};
    if (request.method === "POST") input = await request.json();
    let res;
    try {
      res = await this.route(op, input, request.headers.get("x-seat-token"), request.headers.get("x-client-key") || "unknown");
    } catch (e) {
      res = err(500, "internal", "unexpected error");
      console.log("match error", String(e && e.stack ? e.stack : e).slice(0, 500));
    }
    return Response.json(res.body, { status: res.status });
  }

  async route(op, input, token, clientKey) {
    if (op === "create") return this.create(input); // only the Worker's create path reaches this
    if (!this.m) return err(404, "no_match", "no match with that code");
    // the token is checked first, so a seated captain has its own budget nobody else can spend
    const seat = await this.seatFor(token);
    if (this.overBudget(seat >= 0 ? "s" + seat : "k" + clientKey, seat >= 0 ? SEAT_REQ_PER_MIN : ANON_REQ_PER_MIN))
      return err(429, "rate_limited", "too many requests for this match; poll at most about once a second");
    await this.tick();
    if (!this.m) return err(404, "no_match", "this match has ended (expired, or nobody played for two rounds)");
    if (op === "state") return ok(stateView(this.m, seat, Date.now()));
    if (op === "log") return ok(logView(this.m));
    if (op === "join") return this.join(input);
    if (op === "start") return this.start(seat);
    if (op === "move") return this.move(seat, input);
    return err(404, "not_found", "unknown operation");
  }

  // One call creates the match and, if asked, seats the creator and starts it; one save, one alarm.
  async create({ code, players, roundSeconds, name, kind, join, start }) {
    if (this.m) return err(409, "code_taken", "match code already exists");
    let token = null, tokenHash = null;
    if (join) { token = newToken(); tokenHash = await sha256(token); }
    this.m = {
      code, players, roundSeconds, rulesVersion: RULES_VERSION,
      createdAt: Date.now(), phase: "lobby", seats: Array(players).fill(null),
      game: null, pending: {}, auto: {}, idle: 0, roundEndsAt: null, finishedAt: null, version: 0,
    };
    let seat = -1;
    if (join) seat = this.seat(name, kind, tokenHash);
    if (this.m.phase === "lobby" && start && seat >= 0) this.begin();
    await this.save();
    await this.ctx.storage.setAlarm(this.m.phase === "play" ? this.m.roundEndsAt : this.m.createdAt + LOBBY_TTL_MS);
    const out = { code };
    if (seat >= 0) Object.assign(out, { seat, token });
    out.state = stateView(this.m, seat, Date.now());
    return ok(out);
  }

  // Put a captain in the next free seat (synchronous: no await between finding and taking the seat).
  seat(name, kind, tokenHash) {
    const m = this.m;
    const seat = m.seats.findIndex((s) => s === null);
    if (seat < 0) return -1;
    m.seats[seat] = { name: cleanName(name, `Captain ${seat + 1}`), kind: kind === "agent" ? "agent" : "human", tokenHash, joinedAt: Date.now() };
    if (m.seats.every((s) => s !== null)) this.begin();
    return seat;
  }

  async join({ name, kind }) {
    const token = newToken();
    const tokenHash = await sha256(token);
    const m = this.m;
    if (m.phase !== "lobby") return err(409, "not_joinable", `match is ${m.phase === "play" ? "already running" : m.phase}`);
    const seat = this.seat(name, kind, tokenHash);
    if (seat < 0) return err(409, "full", "all seats are taken");
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

  // Fill empty seats with house bots (names drawn at random) and start round 1.
  begin() {
    const m = this.m;
    const names = BOT_NAMES.slice();
    const pick = rng(randomU32());
    for (let i = 0; i < m.players; i++) {
      if (m.seats[i] !== null) continue;
      const name = names.splice(Math.floor(pick() * names.length), 1)[0];
      m.seats[i] = { name: `${name} (bot)`, kind: "bot", tokenHash: null, joinedAt: Date.now() };
    }
    m.game = newGame(m.players, randomU32()); // the match seed: used for the cove layout only
    delete m.game.seed;
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
    const botSeats = this.m.seats.map((x, i) => (x && x.kind === "bot" ? i : -1)).filter((i) => i >= 0);
    return houseBot(this.m.game, seat, rng(randomU32()), { botSeats });
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
    if (resolved) await this.ctx.storage.setAlarm(m.phase === "play" ? m.roundEndsAt : m.finishedAt + KEEP_FINISHED_MS);
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
    const people = m.seats.map((x, i) => (x.kind === "bot" ? -1 : i)).filter((i) => i >= 0);
    m.idle = people.length && people.every((s) => auto.includes(s)) ? (m.idle || 0) + 1 : 0;
    m.game = resolveRound(g, moves, { tideSeed: randomU32() });
    if (m.game.over) {
      m.phase = "over";
      m.finishedAt = Date.now();
      m.pending = {};
      m.roundEndsAt = null;
      m.final = standings(m.game);
    } else if (m.idle >= IDLE_ROUNDS_TO_END) {
      m.phase = "abandoned";
      m.pending = {};
    } else this.openRound();
  }

  // Apply anything that is due (round timers, lobby expiry, abandonment). Returns true if state changed.
  async tick() {
    const m = this.m;
    let changed = false;
    while (m.phase === "play" && Date.now() >= m.roundEndsAt) {
      this.resolve();
      changed = true;
    }
    if (m.phase === "abandoned" || (m.phase === "lobby" && Date.now() - m.createdAt > LOBBY_TTL_MS)) {
      await this.wipe();
      return true;
    }
    if (changed) {
      await this.save();
      await this.ctx.storage.setAlarm(m.phase === "play" ? m.roundEndsAt : m.finishedAt + KEEP_FINISHED_MS);
    }
    return changed;
  }

  async alarm() {
    if (!this.m) return;
    const m = this.m;
    if (m.phase === "over" && Date.now() >= m.finishedAt + KEEP_FINISHED_MS) return this.wipe();
    if (await this.tick()) return; // tick saved and set the next alarm (or wiped the match)
    // fired early (clock skew): re-arm for whatever is due next
    if (m.phase === "play") await this.ctx.storage.setAlarm(m.roundEndsAt);
    else if (m.phase === "over") await this.ctx.storage.setAlarm(m.finishedAt + KEEP_FINISHED_MS);
    else if (m.phase === "lobby") await this.ctx.storage.setAlarm(m.createdAt + LOBBY_TTL_MS + 1000);
  }
}
