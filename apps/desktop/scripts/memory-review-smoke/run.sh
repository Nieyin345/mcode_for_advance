#!/usr/bin/env bash
# Linux/macOS runner for the same isolated test; never touch user data.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=".tmp/memory-review-$(date +%s)-$$"
mkdir -p "$OUT/data"
trap 'rm -rf "$OUT"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path '*/esbuild/bin/esbuild' -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo 'project esbuild not found' >&2; exit 1; fi
node "$ESBUILD" scripts/memory-review-smoke/main.ts \
  --bundle --platform=node --format=cjs --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/store/repositories.js=./scripts/memory-smoke/stubs/repositories.ts \
  --alias:@main/memory/broadcast.js=./scripts/memory-review-smoke/stubs/broadcast.ts \
  --outfile="$OUT/smoke.cjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$OUT/data" node "$OUT/smoke.cjs"
