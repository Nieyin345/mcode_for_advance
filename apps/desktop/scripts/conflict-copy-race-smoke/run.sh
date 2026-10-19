#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-conflict-copy-race.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/conflict-copy-race-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
