// IPv4 / IPv6 parsing, enough to bucket client addresses for rate limits. Pure, no dependencies.
export function parseIPv4(s) {
  if (typeof s !== "string" || s.length > 15) return null;
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

export function parseIPv6(s) {
  if (typeof s !== "string" || s.length > 45 || s.length < 2 || s.includes("%")) return null;
  let str = s.toLowerCase();
  let tailV4 = null;
  const lastColon = str.lastIndexOf(":");
  if (str.slice(lastColon + 1).includes(".")) {
    tailV4 = parseIPv4(str.slice(lastColon + 1));
    if (tailV4 === null) return null;
    str = str.slice(0, lastColon + 1) + "0:0";
  }
  const dbl = str.split("::");
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(":") : [];
  const tail = dbl.length === 2 ? (dbl[1] ? dbl[1].split(":") : []) : [];
  const groups = dbl.length === 2 ? head.length + tail.length : head.length;
  if (dbl.length === 1 && groups !== 8) return null;
  if (dbl.length === 2 && groups > 7) return null;
  const all = dbl.length === 2 ? [...head, ...Array(8 - groups).fill("0"), ...tail] : head;
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tailV4 !== null) n = (n & ~((1n << 32n) - 1n)) | tailV4;
  return n;
}

export function parseIP(s) {
  const t = String(s || "").trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(t);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIPv6(t);
  if (v6 !== null) return { version: 6, value: v6 };
  return null;
}

const formatIPv4 = (n) => [24n, 16n, 8n, 0n].map((sh) => String((n >> sh) & 255n)).join(".");
function expandIPv6(n) {
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, "0"));
  return g.join(":");
}

// The rate-limit bucket of a client: its IPv4 address, or its IPv6 /64 (one line usually holds a whole
// /64, so per-address keys would hand out a fresh allowance for every address in it).
export function ipBucket(raw) {
  const p = parseIP(String(raw || "").slice(0, 64));
  if (!p) return "unknown";
  if (p.version === 4) return formatIPv4(p.value);
  if (p.value >> 32n === 0xffffn) return formatIPv4(p.value & 0xffffffffn); // IPv4-mapped
  return expandIPv6(p.value).split(":").slice(0, 4).join(":") + "::/64";
}
