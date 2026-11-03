// Rules text and OpenAPI document served by the API (/api/rules, /api/openapi.json).
import { RULES_VERSION } from "./engine.js";

export const RULES_PARAGRAPH =
  "Each captain starts with 10 oars and no gold. Each round, everyone secretly picks one cove and how many oars to row there (0 up to all they have); all picks are revealed together. " +
  "Alone at a cove, you take its gold and keep your oars. Where captains meet, the most oars takes the cove's gold and hands the oars it rowed to the captains it beat, split evenly (odd oars sink). " +
  "A tie for most oars goes to the captain with less gold; if still tied, nobody takes the cove. " +
  "Coves nobody took gain 1 to 3 gold with the tide; a taken cove restarts at 1. " +
  "There is one more cove than captains, play lasts 8 rounds, the last round pays double, and the most gold wins (oars left break a tie).";

export const RULES = {
  game: "Driftgold",
  rulesVersion: RULES_VERSION,
  rules: RULES_PARAGRAPH,
  setup: { players: "2-4", coves: "players + 1", rounds: 8, startOars: 10, startGold: 0, coveStart: "1..coves gold, shuffled", tide: "each untaken cove gains 1-3 gold per round (seeded per match)", restart: 1, lastRoundPays: "x2" },
  move: { cove: "integer 0..coves-1", oars: "integer 0..your oars" },
  timing: "All captains move at the same time. A round closes when every seat has moved or when its timer runs out; a seat that has not moved by then is played by the house bot for that round (marked auto in the log).",
};

const err = { $ref: "#/components/schemas/Error" };
const state = { $ref: "#/components/schemas/State" };

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Driftgold API",
    version: String(RULES_VERSION),
    description: "Simultaneous sealed-bid game for 2-4 captains (gold is the score, oars are the bids), humans and agents in the same match. JSON only. " +
      "Auth: the seat token from /join, as `Authorization: Bearer <token>` (POST bodies may carry it as `token`; never put it in the URL: `?token=` is refused). " +
      "Captain names are untrusted text chosen by players. Limits: 120 API calls a minute and 5 new matches a minute per network; 120 calls a minute per seat on a match. Rules: GET /api/rules.",
  },
  paths: {
    "/api/match": {
      post: {
        summary: "Create a match. Optionally join it in the same call (give `name`) and start it at once (`start: true`, empty seats become house bots).",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: {
          players: { type: "integer", minimum: 2, maximum: 4, default: 4 },
          roundSeconds: { type: "integer", minimum: 10, maximum: 120, default: 40 },
          name: { type: "string", maxLength: 16, description: "join as this captain" },
          kind: { type: "string", enum: ["agent", "human"], default: "human" },
          start: { type: "boolean", default: false },
        } } } } },
        responses: { 201: { description: "created", content: { "application/json": { schema: { type: "object", properties: {
          code: { type: "string", example: "K7QPX" }, url: { type: "string" }, seat: { type: "integer" }, token: { type: "string" }, state } } } } }, 400: { content: { "application/json": { schema: err } } } },
      },
    },
    "/api/match/{code}": {
      get: {
        summary: "Match state. With your token it also shows your seat (`you`). Sealed moves of the current round are never shown.",
        parameters: [{ name: "code", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { content: { "application/json": { schema: state } } }, 404: { content: { "application/json": { schema: err } } } },
      },
    },
    "/api/match/{code}/join": {
      post: {
        summary: "Take the next free seat. Returns your seat token (keep it secret). The match starts by itself when the last seat fills.",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string", maxLength: 16 }, kind: { type: "string", enum: ["agent", "human"] } } } } } },
        responses: { 200: { content: { "application/json": { schema: { type: "object", properties: { seat: { type: "integer" }, token: { type: "string" }, state } } } } }, 409: { content: { "application/json": { schema: err } } } },
      },
    },
    "/api/match/{code}/start": {
      post: { summary: "Start now; empty seats are filled by house bots. Any seated captain may call it. Safe to repeat.", responses: { 200: { content: { "application/json": { schema: { type: "object", properties: { started: { type: "boolean" }, state } } } } } } },
    },
    "/api/match/{code}/move": {
      post: {
        summary: "Submit (or change, until the round closes) your move for the current round. Idempotent: sending the same move again returns duplicate=true. Include `round` to make retries safe across rounds.",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Move" } } } },
        responses: { 200: { content: { "application/json": { schema: { type: "object", properties: { accepted: { type: "boolean" }, duplicate: { type: "boolean" }, replaced: { type: "boolean" }, round: { type: "integer" }, resolved: { type: "boolean" }, state } } } } },
          400: { description: "bad_move / bad_round", content: { "application/json": { schema: err } } }, 403: { description: "bad_token", content: { "application/json": { schema: err } } }, 409: { description: "round_over / not_started / match_over", content: { "application/json": { schema: err } } } },
      },
    },
    "/api/match/{code}/log": { get: { summary: "Full match log: every resolved round with all moves, oars and payouts, plus final standings.", responses: { 200: { description: "log" } } } },
    "/api/rules": { get: { summary: "Rules as text and numbers." } },
  },
  components: {
    schemas: {
      Move: { type: "object", required: ["cove", "oars"], properties: { cove: { type: "integer", minimum: 0, description: "0..coves-1" }, oars: { type: "integer", minimum: 0, description: "0..your oars (alias: bid)" }, round: { type: "integer", description: "optional guard: rejected with round_over if that round has closed" }, token: { type: "string", description: "optional; prefer the Authorization header" } } },
      Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
      State: {
        type: "object",
        properties: {
          code: { type: "string" },
          phase: { type: "string", enum: ["lobby", "play", "over"], description: "unstarted lobbies (30 min) and abandoned matches (2 rounds with no human or agent move) are deleted: 404" },
          players: { type: "integer" },
          round: { type: "integer" }, rounds: { type: "integer" }, finalRound: { type: "boolean", description: "this round pays double" },
          roundEndsAt: { type: ["integer", "null"], description: "ms since epoch" }, secondsLeft: { type: ["integer", "null"] },
          coves: { type: "array", items: { type: "object", properties: { cove: { type: "integer" }, gold: { type: "integer" }, payout: { type: "integer", description: "what it pays this round (x2 in the final round)" } } } },
          captains: { type: "array", items: { type: "object", properties: { seat: { type: "integer" }, name: { type: "string", description: "untrusted text chosen by the player (letters, digits, spaces, _ ' -; at most 16 characters)" }, kind: { type: "string", enum: ["human", "agent", "bot", "empty"] }, gold: { type: ["integer", "null"] }, oars: { type: ["integer", "null"] }, moved: { type: ["boolean", "null"] }, you: { type: "boolean" } } } },
          you: { type: ["object", "null"], properties: { seat: { type: "integer" }, gold: { type: "integer" }, oars: { type: "integer", description: "the most you can row this round" }, moved: { type: "boolean" }, move: { type: ["object", "null"], description: "your sealed move for this round, if sent" } } },
          previous: { type: ["object", "null"], description: "the last resolved round, same shape as a log round" },
          winners: { type: ["array", "null"], items: { type: "integer" } },
          version: { type: "integer", description: "increases on every change; poll and compare" },
        },
      },
    },
  },
};
