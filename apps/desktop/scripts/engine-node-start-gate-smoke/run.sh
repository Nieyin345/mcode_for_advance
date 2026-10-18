#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d /tmp/mcode-node-start-gate.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/engine-node-start-gate-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts --outfile="$OUT/smoke.mjs" --log-level=error
MCODE_SMOKE_DATA_ROOT="$OUT" node "$OUT/smoke.mjs"
