#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-library-picker-search.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path "*/esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
"${ESBUILD:-npx esbuild}" scripts/arc005-library-picker-search-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
