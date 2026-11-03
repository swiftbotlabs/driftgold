#!/bin/bash
# Starts a throwaway local server (fresh state) on port 8799, runs the API tests against it, stops it.
# usage: test/run_api.sh            (LONG=1 test/run_api.sh adds the 85-second timer-only match)
set -u
cd "$(dirname "$0")/.."
WRANGLER="${WRANGLER:-wrangler}"
STATE="$(mktemp -d "${TMPDIR:-/tmp}/driftgold-test.XXXXXX")"
export WRANGLER_SEND_METRICS=false XDG_CONFIG_HOME="$STATE/xdg" CI=1
"$WRANGLER" dev --ip 127.0.0.1 --port 8799 --persist-to "$STATE/state" > "$STATE/dev.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$STATE"' EXIT
for _ in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:8799/api >/dev/null && break; sleep 1; done
curl -sf -m 2 http://127.0.0.1:8799/api >/dev/null || { echo "server did not start"; tail -20 "$STATE/dev.log"; exit 1; }
BASE=http://127.0.0.1:8799 node --test --test-concurrency=1 test/api.test.mjs
