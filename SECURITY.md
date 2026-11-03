# Security notes

Driftgold is a public, login-free game. What it protects and how:

- **Seat tokens** are 144-bit random values from `crypto.getRandomValues`, returned once on join. The
  server stores only their SHA-256 hash. A token only lets you move for your own seat in one match. It is
  accepted in the `Authorization: Bearer` header (or a POST body), never in a URL: `?token=` is refused, and
  between the Worker and the match object it travels in a header, not in the internal URL.
- **Sealed moves and randomness**: a seat's move for the current round is never included in any response
  to another seat, in the state or in the log, until the round closes. The match seed is drawn from
  `crypto.getRandomValues` and used once, for the round-1 cove layout. Every house-bot move, every round's
  tide and the bot names use fresh crypto randomness, so the public layout and log reveal nothing about
  sealed bot moves or future tides. (The house bot's code is open, so anyone can run it on the public state
  and guess what it is likely to do, as with any known opponent; two independent runs on the same state
  pick the same cove about half the time and the exact same move about 1 time in 5.)
- **Input limits**: request bodies are read through a stream capped at 2 KB (declared length or not), must
  be valid UTF-8 and a JSON object; every field is type and range checked (players 2-4, timer 10-120 s,
  cove index, oars within what you hold, round number). Match codes must match `^[A-HJ-NP-Z2-9]{5}$`;
  anything else is a 404 before any storage is touched. Operations are looked up with `Object.hasOwn`.
- **Names** are untrusted text. They are normalised (NFKC), reduced to letters, digits, spaces and `_'-`
  (no dots, so a name cannot look like a link; no control, bidi or format characters), cut to 16
  characters without splitting a surrogate pair, and made well-formed. The browser client renders every
  third-party string with `textContent`, never as HTML. Agents should treat names as data, too.
- **Rate limits and shared quotas**: Cloudflare's free-plan quotas are per account, so one client must not
  be able to spend them. Per network (hashed IPv4 address or IPv6 /64), Cloudflare rate-limiting
  bindings allow 120 API calls and 5 new matches a minute. Inside each match, a seated token has its own
  budget of 120 calls a minute, checked after the token and before anything else, and callers without a
  token get 60 a minute per network, so nobody can freeze someone else's match. Token-less reads
  (spectators, replays) are cached for 1-2 seconds per Worker isolate. The browser client polls adaptively
  (2-5 s) with one request in flight at a time.
- **Storage lifetime**: one Durable Object per match. Create, join-as-creator and start are one call and
  one write. Unstarted lobbies are deleted after 30 minutes, matches where no human or agent moved for two
  rounds in a row are deleted at once, and finished matches (with their logs) are deleted after 3 days.
- **Routing**: the Worker forwards only a fixed set of operations (`state`, `log`, `join`, `start`,
  `move`) plus `create`, which only the match-creation path sends.
- **No secrets** in the code or the repository. Deployment credentials live outside the repo.
- **No third-party scripts**: the front end is plain HTML/CSS/JS served by the Worker; no CDNs, no
  trackers, no cookies. Pages get a strict Content-Security-Policy (`public/_headers`: scripts, styles and
  requests from the same origin only, no framing); API responses send `cache-control: no-store` and
  `x-content-type-options: nosniff`.
- **Sample bots** refuse plain-http servers other than localhost and never follow redirects, so a
  redirect cannot carry a seat token to another host.

Not in scope: accounts, payments or personal data (there are none). A player can open several seats in
an open lobby; that is how a single person plays a hot-seat match.

Report problems through the repository's issue tracker.
