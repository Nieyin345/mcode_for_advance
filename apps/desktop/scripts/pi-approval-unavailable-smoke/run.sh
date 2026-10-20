#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-pi-approval-bridge.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/pi-approval-unavailable-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --external:typescript --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
