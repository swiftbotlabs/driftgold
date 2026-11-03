# Security notes

Driftgold is a public, login-free game. What it protects and how:

- **Seat tokens** are 144-bit random values from `crypto.getRandomValues`, returned once on join. The
  server stores only their SHA-256 hash. A token only lets you move for your own seat in one match.
- **Sealed moves**: a seat's move for the current round is never included in any response to another
  seat, in the state or in the log, until the round closes.
- **Input limits**: request bodies are read through a stream capped at 2 KB (declared length or not), must
  be valid UTF-8 and a JSON object; every field is type and
  range checked (players 2-4, timer 10-120 s, cove index, oars within what you hold, round number).
  Match codes must match `^[A-HJ-NP-Z2-9]{5}$`; anything else is a 404 before any storage is touched.
- **Names** are normalised (NFKC), reduced to letters, digits, spaces and `._'-`, and cut to 16
  characters, so control and bidi characters never reach other players. The browser client renders every
  third-party string with `textContent`, never as HTML.
- **Rate limits**: 600 API calls a minute per client address and 20 new matches a minute (per Worker
  isolate, best effort), and 900 calls a minute per match inside its Durable Object.
- **Storage**: one Durable Object per match; the Worker forwards only a fixed set of operations
  (`state`, `log`, `join`, `start`, `move`) and the internal `init` is reachable only from match
  creation. Unstarted lobbies expire after 30 minutes; finished matches are deleted after 3 days.
- **No secrets** in the code or the repository. Deployment credentials live outside the repo.
- **No third-party scripts**: the front end is plain HTML/CSS/JS served by the Worker; no CDNs, no
  trackers, no cookies. Pages get a strict Content-Security-Policy (`public/_headers`: scripts, styles and
  requests from the same origin only, no framing); API responses send `cache-control: no-store` and
  `x-content-type-options: nosniff`.

Not in scope: accounts, payments or personal data (there are none). A player can open several seats in
an open lobby; that is how a single person plays a hot-seat match.

Report problems through the repository's issue tracker.
