#!/bin/bash
# Local dev server: http://127.0.0.1:8797 (state lives in .wrangler/state, nothing is deployed).
# Uses `wrangler` from PATH; set WRANGLER=/path/to/wrangler to use another copy.
cd "$(dirname "$0")"
export WRANGLER_SEND_METRICS=false
exec ${WRANGLER:-wrangler} dev --ip 127.0.0.1 --port "${PORT:-8797}" "$@"
