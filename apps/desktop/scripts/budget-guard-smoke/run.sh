#!/usr/bin/env bash
# Headless smoke for the turn-policy pipeline (main/lib/turnPolicy.ts).
#
# The budget caps (S3) and the failure fallback chain (S4) both start as a JSON
# blob in the settings table and must degrade safely on ANY bad input. Also
# covers the pure three-cap violation check the host's enforceBudget runs
# before it emits turn.notice + interrupt. Pure functions only — the
# emit/interrupt side effects need a live RuntimeManager and stay manual.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-budget-guard-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/budget-guard-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
