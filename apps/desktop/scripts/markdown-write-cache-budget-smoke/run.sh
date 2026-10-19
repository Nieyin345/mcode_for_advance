#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/markdown-write-cache-budget-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@renderer/lib/api.js=./scripts/markdown-write-cache-budget-smoke/stubApi.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
