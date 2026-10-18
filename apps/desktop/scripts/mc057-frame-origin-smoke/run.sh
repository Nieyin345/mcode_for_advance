#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d /tmp/mcode-mc057-frame.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/mc057-frame-origin-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts
MCODE_SMOKE_DATA_ROOT="$OUT" node "$OUT/smoke.mjs"
