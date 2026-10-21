#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-t84-slides-ai-boundary.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/t84-slides-ai-boundary-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

if [[ "${T84_LEGACY_RED:-}" == "1" ]]; then
  node "$OUT/smoke.mjs" --legacy-red
else
  node "$OUT/smoke.mjs" "$@"
fi
