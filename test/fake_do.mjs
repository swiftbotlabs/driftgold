// In-memory stand-in for a Durable Object context, so match.js can be tested in plain Node.
export class FakeStorage {
  constructor() {
    this.data = new Map();
    this.alarm = null;
    this.puts = 0;
    this.alarmSets = 0;
  }
  async get(k) { return this.data.has(k) ? structuredClone(this.data.get(k)) : undefined; }
  async put(k, v) { this.puts++; this.data.set(k, structuredClone(v)); }
  async deleteAll() { this.data.clear(); }
  async setAlarm(t) { this.alarm = t; this.alarmSets++; }
  async deleteAlarm() { this.alarm = null; }
}

export async function newObject(MatchClass) {
  const storage = new FakeStorage();
  const obj = new MatchClass({ storage, blockConcurrencyWhile: (f) => f() }, {});
  await new Promise((r) => setTimeout(r, 0));
  return { obj, storage };
}

export async function call(obj, op, body, { token, client = "test-client" } = {}) {
  const headers = { "x-client-key": client };
  if (token) headers["x-seat-token"] = token;
  const init = body === undefined ? { method: "GET", headers } : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await obj.fetch(new Request(`https://match/${op}`, init));
  return { status: r.status, json: await r.json() };
}
