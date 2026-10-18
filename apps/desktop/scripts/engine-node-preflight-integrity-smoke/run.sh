#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d /tmp/mcode-node-preflight.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/engine-node-preflight-integrity-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
