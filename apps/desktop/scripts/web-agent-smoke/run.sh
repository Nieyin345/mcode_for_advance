#!/usr/bin/env bash
# Headless smoke for the web-agent engine's pure-function layer
# (main/providers/web-agent/{sseFramer,parsers,adapters}).
#
# This is the ONLY part of the web-agent engine that can be tested without a real
# browser and a real site login — everything else (CDP injection, DOM typing,
# live SSE tapping) needs a live page, see the W4 verification step in
# .trae/documents/web-agent-engine.md.
#
# Covered: SSE framing (all the ways a naive implementation breaks — chunks
# splitting a frame, CRLF split across chunks, multi-line data, heartbeat
# comments, [DONE]), the three parser strategies and their tolerated variants,
# and the adapter registry.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-web-agent-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/web-agent-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"